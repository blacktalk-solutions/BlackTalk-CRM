import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import { searchPlaces, PlacesApiError, type RawPlace } from "@/lib/prospecting/places-client";
import { scoreInitial } from "@/lib/prospecting/score";
import type { AuthUser } from "@/lib/auth/types";

/**
 * T4 — POST /api/v1/prospecting/searches (.specs/features/prospeccao-google-maps/).
 *
 * Cobre: sucesso com mistura com/sem site (só com site emite evento),
 * `requireRole` bloqueando role insuficiente, erro de Places API sem insert
 * parcial, zero resultados não é erro, body inválido → 422, falha no insert
 * de `prospected_places` desfaz `prospected_searches` (compensação, já que o
 * client Supabase deste repo não tem transação multi-tabela real).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/prospecting/places-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/places-client")>()),
  searchPlaces: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "33333333-3333-4333-8333-333333333333";

const PLACE_WITH_SITE: RawPlace = {
  placeId: "gp-1",
  name: "Padaria Sol",
  address: "Rua A, 1",
  phoneNumber: "+551122223333",
  websiteUrl: "https://padariasol.com.br",
  rating: 4.2,
  reviewCount: 30,
};

const PLACE_WITHOUT_SITE: RawPlace = {
  placeId: "gp-2",
  name: "Barbearia Show",
  address: "Rua B, 2",
  phoneNumber: "+551144445555",
  websiteUrl: null,
  rating: 4.9,
  reviewCount: 50,
};

function mockAuthzOk(role: "manager" | "admin" = "manager") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  } as never);
}

interface AdminCfg {
  insertSearchResult?: { data?: { id: string } | null; error?: unknown };
  /** "echo" gera 1 linha por item inserido, com id sequencial `place-N`. */
  insertPlacesResult?: { data?: unknown[] | null; error?: unknown } | "echo";
  rpcResult?: { data?: unknown; error?: unknown };
}

interface Calls {
  insertedSearch?: Record<string, unknown>;
  insertedPlaces?: Array<Record<string, unknown>>;
  deletedSearchId?: string;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
}

function makeAdminStub(cfg: AdminCfg) {
  const calls: Calls = { rpcCalls: [] };
  const client = {
    from(table: string) {
      if (table === "prospected_searches") {
        return {
          insert(row: Record<string, unknown>) {
            calls.insertedSearch = row;
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve(
                      cfg.insertSearchResult ?? { data: { id: SEARCH_ID }, error: null },
                    );
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq(_col: string, id: string) {
                calls.deletedSearchId = id;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === "prospected_places") {
        return {
          insert(rows: Array<Record<string, unknown>>) {
            calls.insertedPlaces = rows;
            return {
              select() {
                if (cfg.insertPlacesResult === "echo") {
                  const echoed = rows.map((row, idx) => ({ id: `place-${idx}`, ...row }));
                  return Promise.resolve({ data: echoed, error: null });
                }
                return Promise.resolve(cfg.insertPlacesResult ?? { data: [], error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, params: Record<string, unknown>) {
      calls.rpcCalls.push({ name, params });
      return Promise.resolve(cfg.rpcResult ?? { data: null, error: null });
    },
  };
  return { client, calls };
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/prospecting/searches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  businessType: "padaria",
  location: "São Paulo, SP",
  serviceType: "venda_de_site",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/prospecting/searches", () => {
  it("sem role manager+ → repassa authz.response, nunca chama Places API nem o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente.", 403, {}),
    } as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(403);
    expect(searchPlaces).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("body inválido (serviceType errado) → 422, nada chamado depois da validação", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");

    const res = await POST(postReq({ ...VALID_BODY, serviceType: "outra_coisa" }));

    expect(res.status).toBe(422);
    expect(searchPlaces).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("businessType vazio → 422", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");

    const res = await POST(postReq({ ...VALID_BODY, businessType: "" }));

    expect(res.status).toBe(422);
  });

  it("zero resultados da Places API não é erro: busca persiste com places: []", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({ places: [], placesApiCapped: false });
    const { client, calls } = makeAdminStub({ insertPlacesResult: "echo" });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { searchId: string; places: unknown[] } };
    expect(body.data).toEqual({ searchId: SEARCH_ID, places: [] });
    // Sem resultado nenhum, não há por que tocar prospected_places nem emit_event.
    expect(calls.insertedPlaces).toBeUndefined();
    expect(calls.rpcCalls).toHaveLength(0);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.search_run",
        organizationId: ORG_ID,
        resourceId: SEARCH_ID,
        metadata: expect.objectContaining({ result_count: 0, with_website_count: 0 }),
      }),
    );
  });

  it("mistura com/sem site: persiste as duas, mas só emite event_log para a linha com site", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({
      places: [PLACE_WITH_SITE, PLACE_WITHOUT_SITE],
      placesApiCapped: false,
    });
    const { client, calls } = makeAdminStub({ insertPlacesResult: "echo" });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        searchId: string;
        places: Array<{
          id: string;
          websiteUrl: string | null;
          scoreInitial: number;
          statusLabel: string;
          siteAnalysisStatus: string;
        }>;
      };
    };

    expect(body.data.searchId).toBe(SEARCH_ID);
    expect(body.data.places).toHaveLength(2);

    const comSite = body.data.places.find((p) => p.websiteUrl !== null)!;
    const semSite = body.data.places.find((p) => p.websiteUrl === null)!;

    const esperadoComSite = scoreInitial({ hasWebsite: true, rating: 4.2, reviewCount: 30 });
    const esperadoSemSite = scoreInitial({ hasWebsite: false, rating: 4.9, reviewCount: 50 });
    expect(comSite.scoreInitial).toBe(esperadoComSite.score);
    expect(comSite.statusLabel).toBe(esperadoComSite.label);
    expect(comSite.siteAnalysisStatus).toBe("pending");
    expect(semSite.scoreInitial).toBe(esperadoSemSite.score);
    expect(semSite.statusLabel).toBe(esperadoSemSite.label);
    expect(semSite.siteAnalysisStatus).toBe("not_applicable");

    // Linha sem site NÃO gera evento; linha com site gera exatamente 1.
    expect(calls.rpcCalls).toHaveLength(1);
    expect(calls.rpcCalls[0]).toEqual({
      name: "emit_event",
      params: expect.objectContaining({
        p_event_type: "prospected_place.site_quality_requested",
        p_entity_kind: "prospected_place",
        p_entity_id: comSite.id,
        p_organization_id: ORG_ID,
        p_payload: expect.objectContaining({ prospected_place_id: comSite.id, search_id: SEARCH_ID }),
      }),
    });

    // organization_id/requested_by vêm de requireRole, nunca do body.
    expect(calls.insertedSearch).toEqual(
      expect.objectContaining({
        organization_id: ORG_ID,
        requested_by: USER_ID,
        business_type: "padaria",
        location: "São Paulo, SP",
        service_type: "venda_de_site",
        result_count: 2,
        places_api_capped: false,
      }),
    );

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.search_run",
        metadata: expect.objectContaining({ result_count: 2, with_website_count: 1 }),
      }),
    );
  });

  it.each([
    ["missing_api_key", 503],
    ["invalid_api_key_or_billing", 502],
    ["quota_exceeded", 503],
    ["unknown_error", 502],
  ] as const)(
    "PlacesApiError(%s) → %i, sem insert nenhum (nada parcial no banco)",
    async (code, expectedStatus) => {
      mockAuthzOk();
      vi.mocked(searchPlaces).mockRejectedValue(new PlacesApiError(code, `falhou: ${code}`));
      const { client } = makeAdminStub({});
      vi.mocked(createAdminClient).mockReturnValue(client as never);

      const { POST } = await import("./route");
      const res = await POST(postReq(VALID_BODY));

      expect(res.status).toBe(expectedStatus);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
      // createAdminClient só é chamado DEPOIS da Places API responder — erro
      // aqui nunca chega a criar o client, então nunca chega a inserir nada.
      expect(createAdminClient).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it("falha ao inserir prospected_places desfaz a prospected_searches (sem deixar busca órfã)", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({
      places: [PLACE_WITH_SITE],
      placesApiCapped: false,
    });
    const { client, calls } = makeAdminStub({
      insertPlacesResult: { data: null, error: { message: "insert falhou" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(calls.deletedSearchId).toBe(SEARCH_ID);
    expect(calls.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro ao inserir prospected_searches → 500, sem tentar prospected_places", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({
      places: [PLACE_WITH_SITE],
      placesApiCapped: false,
    });
    const { client, calls } = makeAdminStub({
      insertSearchResult: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(500);
    expect(calls.insertedPlaces).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
