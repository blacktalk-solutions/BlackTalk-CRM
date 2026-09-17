import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * T5 — GET /api/v1/prospecting/searches/[id] (reabre uma busca persistida).
 *
 * Cobre: `requireRole` bloqueando role insuficiente; busca existente devolve
 * `{ search, places }` mapeados pra DTO camelCase (reusando `toSearchDTO`/
 * `toPlaceDTO` de `../route`, importados de verdade — não mockados, porque
 * são funções puras e o contrato do DTO precisa ser o MESMO das duas rotas);
 * busca de outra organização e busca inexistente caem no mesmo 404
 * `not_found` (RLS + filtro explícito por `organization_id` colapsam os dois
 * casos em `maybeSingle()` devolvendo null — não há como a rota diferenciar,
 * e é exatamente esse o comportamento pedido: não revelar "não existe" vs.
 * "não é seu"); erro do Supabase em qualquer uma das duas consultas → 500.
 *
 * Mocks reaproveitados do padrão de `../route.test.ts` (Task 4): mesmos
 * módulos mockados (`requireRole`, `createClient`/`createAdminClient`,
 * `audit`, `searchPlaces`, `requireSupportWrite`) — aqui `createAdminClient`,
 * `audit` e `searchPlaces` são mockados só porque `../route.ts` (de onde
 * este arquivo importa `toPlaceDTO`/`toSearchDTO`/as colunas) os importa no
 * topo; o handler `GET` desta rota nunca os chama.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/prospecting/places-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/places-client")>()),
  searchPlaces: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "55555555-5555-4555-8555-555555555555";

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

function searchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SEARCH_ID,
    business_type: "padaria",
    location: "São Paulo, SP",
    service_type: "venda_de_site",
    result_count: 1,
    places_api_capped: false,
    created_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function placeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PLACE_ID,
    search_id: SEARCH_ID,
    place_id: "gp-1",
    name: "Padaria Sol",
    address: "Rua A, 1",
    phone_number: "+551122223333",
    phone_number_normalized: null,
    website_url: "https://padariasol.com.br",
    rating: 4.2,
    review_count: 30,
    score_initial: 70,
    score_final: null,
    status_label: "oportunidade",
    site_analysis_status: "pending",
    site_analysis_result: null,
    email: null,
    promoted_lead_id: null,
    promoted_at: null,
    ...overrides,
  };
}

interface ClientCfg {
  searchResult?: { data?: Record<string, unknown> | null; error?: unknown };
  placesResult?: { data?: unknown[] | null; error?: unknown };
}

interface ClientCalls {
  searchFilters: Array<[string, unknown]>;
  placesFilters: Array<[string, unknown]>;
  placesOrders: Array<[string, { ascending: boolean }]>;
  /** true assim que algo chamou `.from("prospected_places")`. */
  placesQueried: boolean;
}

/** Stub de `createClient()` pra cadeia usada pelo GET de `[id]/route.ts`. */
function makeClientStub(cfg: ClientCfg = {}) {
  const calls: ClientCalls = { searchFilters: [], placesFilters: [], placesOrders: [], placesQueried: false };
  const client = {
    from(table: string) {
      if (table === "prospected_searches") {
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: unknown) {
                calls.searchFilters.push([col, val]);
                return {
                  eq(col2: string, val2: unknown) {
                    calls.searchFilters.push([col2, val2]);
                    return {
                      maybeSingle() {
                        return Promise.resolve(cfg.searchResult ?? { data: null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "prospected_places") {
        calls.placesQueried = true;
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: unknown) {
                calls.placesFilters.push([col, val]);
                return {
                  eq(col2: string, val2: unknown) {
                    calls.placesFilters.push([col2, val2]);
                    return {
                      order(col3: string, opts: { ascending: boolean }) {
                        calls.placesOrders.push([col3, opts]);
                        return {
                          order(col4: string, opts2: { ascending: boolean }) {
                            calls.placesOrders.push([col4, opts2]);
                            return Promise.resolve(cfg.placesResult ?? { data: [], error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, calls };
}

function getReq(id: string) {
  return new NextRequest(`http://localhost/api/v1/prospecting/searches/${id}`, { method: "GET" });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/prospecting/searches/[id]", () => {
  it("sem role manager+ → repassa authz.response, nunca toca o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente.", 403, {}),
    } as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("busca existente → devolve search + places, mapeados pra DTO camelCase", async () => {
    mockAuthzOk();
    const { client, calls } = makeClientStub({
      searchResult: { data: searchRow(), error: null },
      placesResult: { data: [placeRow()], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { search: Record<string, unknown>; places: Array<Record<string, unknown>> };
    };
    expect(body.data.search).toEqual({
      id: SEARCH_ID,
      businessType: "padaria",
      location: "São Paulo, SP",
      serviceType: "venda_de_site",
      resultCount: 1,
      placesApiCapped: false,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(body.data.places).toHaveLength(1);
    expect(body.data.places[0]).toEqual(
      expect.objectContaining({
        id: PLACE_ID,
        searchId: SEARCH_ID,
        placeId: "gp-1",
        name: "Padaria Sol",
        websiteUrl: "https://padariasol.com.br",
        scoreInitial: 70,
        statusLabel: "oportunidade",
        siteAnalysisStatus: "pending",
      }),
    );

    // Filtro explícito por id E organization_id ALÉM da RLS, nas duas tabelas.
    expect(calls.searchFilters).toEqual([
      ["id", SEARCH_ID],
      ["organization_id", ORG_ID],
    ]);
    expect(calls.placesFilters).toEqual([
      ["search_id", SEARCH_ID],
      ["organization_id", ORG_ID],
    ]);
  });

  it("busca sem nenhum place → search com places: []", async () => {
    mockAuthzOk();
    const { client } = makeClientStub({
      searchResult: { data: searchRow({ result_count: 0 }), error: null },
      placesResult: { data: [], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { places: unknown[] } };
    expect(body.data.places).toEqual([]);
  });

  it("busca inexistente (maybeSingle devolve null) → 404 not_found, nunca busca places", async () => {
    mockAuthzOk();
    const { client, calls } = makeClientStub({ searchResult: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(calls.placesQueried).toBe(false);
  });

  /**
   * ⭐ Mesma resposta EXATA do teste acima — de propósito. RLS
   * (`tenant_isolation_prospected_searches_all`) já devolve 0 linhas pra
   * busca de outro tenant, e o `.eq("organization_id", org.orgId)` explícito
   * faz o mesmo mesmo se a RLS um dia falhar aberta: os dois caminhos
   * convergem no MESMO `maybeSingle()` → null → 404, sem diferenciar "não
   * existe" de "é de outra organização" (design.md, Error Handling
   * Strategy — mesmo padrão de `app/app/leads/[id]`).
   */
  it("busca de outra organização → mesmo 404 not_found (não revela cross-tenant)", async () => {
    mockAuthzOk();
    // A org ATIVA nesta sessão é ORG_ID. Uma busca de OUTRA organização nunca
    // chega até aqui pra começo de conversa: a RLS (fn_user_org_ids()) já a
    // exclui, e o `.eq("organization_id", org.orgId)` explícito da rota faz o
    // mesmo mesmo que a RLS falhe aberta — os dois filtros convergem no MESMO
    // resultado que o stub simula abaixo: `maybeSingle()` devolvendo null.
    const { client } = makeClientStub({ searchResult: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("erro do Supabase ao buscar a busca → 500, nunca busca places", async () => {
    mockAuthzOk();
    const { client, calls } = makeClientStub({ searchResult: { data: null, error: { message: "boom" } } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(calls.placesQueried).toBe(false);
  });

  it("erro do Supabase ao buscar os places → 500", async () => {
    mockAuthzOk();
    const { client } = makeClientStub({
      searchResult: { data: searchRow(), error: null },
      placesResult: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(SEARCH_ID), ctx(SEARCH_ID));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
