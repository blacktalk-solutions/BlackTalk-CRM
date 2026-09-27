import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";
import { searchPlaces, PlacesApiError, type RawPlace } from "@/lib/prospecting/places-client";
import { PESOS_PADRAO, scoreInitial, type NicheWeights } from "@/lib/prospecting/score";
import type { AuthUser } from "@/lib/auth/types";

/**
 * T4 — POST /api/v1/prospecting/searches (.specs/features/prospeccao-google-maps/),
 * reescrita por T8 (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Cobre: sucesso com mistura com/sem site (score usa os pesos do NICHO
 * escolhido, requisitos calculados, 3 eventos emitidos: site_quality só com
 * site, cnpj_requested pra 100%, instagram_requested só sem site e peso>0),
 * `nicheId` ausente → busca ad-hoc com `PESOS_PADRAO` (0239), nicho de outra organização → 404,
 * `requireRole` bloqueando role insuficiente, erro de Places API sem insert
 * parcial, zero resultados não é erro, body inválido → 422, falha no insert
 * de `prospected_places` desfaz `prospected_searches` (compensação, já que o
 * client Supabase deste repo não tem transação multi-tabela real).
 *
 * T5 — GET /api/v1/prospecting/searches (mesmo arquivo, histórico/lista).
 *
 * Cobre: lista retorna só buscas da organização ATIVA (filtro explícito além
 * da RLS), mapeamento pra DTO camelCase, `requireRole` bloqueando role
 * insuficiente, erro do Supabase → 500.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/prospecting/places-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/places-client")>()),
  searchPlaces: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "33333333-3333-4333-8333-333333333333";
const NICHE_ID = "55555555-5555-4555-8555-555555555555";

/** Pesos de um nicho de teste — mesmos valores padrão do `prospeccao-kit-aluno` (site 25, instagram 15). */
const PESOS_NICHO: NicheWeights = {
  site: 25,
  instagram: 15,
  email: 15,
  telefone: 10,
  whatsapp: 10,
  reputacao: 10,
  cnpj: 5,
  linkedin: 5,
  endereco: 5,
};

function nicheRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NICHE_ID,
    service_type: "venda de site",
    requirements: {},
    weights: PESOS_NICHO,
    ...overrides,
  };
}

const PLACE_WITH_SITE: RawPlace = {
  placeId: "gp-1",
  name: "Padaria Sol",
  address: "Rua A, 1",
  phoneNumber: "+551122223333",
  websiteUrl: "https://padariasol.com.br",
  rating: 4.2,
  reviewCount: 30,
  lat: -23.55,
  lng: -46.63,
  googleMapsUrl: "https://maps.google.com/?cid=1",
};

const PLACE_WITHOUT_SITE: RawPlace = {
  placeId: "gp-2",
  name: "Barbearia Show",
  address: "Rua B, 2",
  phoneNumber: "+551144445555",
  websiteUrl: null,
  rating: 4.9,
  reviewCount: 50,
  lat: -23.56,
  lng: -46.64,
  googleMapsUrl: "https://maps.google.com/?cid=2",
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
  nicheResult?: { data?: Record<string, unknown> | null; error?: unknown };
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
      if (table === "prospecting_niches") {
        return {
          select() {
            return {
              eq(_col1: string, _val1: string) {
                return {
                  eq(_col2: string, _val2: string) {
                    return {
                      maybeSingle() {
                        return Promise.resolve(cfg.nicheResult ?? { data: nicheRow(), error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
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

function getReq(qs = "") {
  return new NextRequest(`http://localhost/api/v1/prospecting/searches${qs}`, { method: "GET" });
}

/** Uma linha de `prospected_searches` no formato que o `.select()` da T5 devolve. */
function searchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SEARCH_ID,
    business_type: "padaria",
    location: "São Paulo, SP",
    service_type: "venda_de_site",
    result_count: 2,
    places_api_capped: false,
    created_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

interface ListClientCfg {
  result?: { data?: unknown[] | null; error?: unknown };
}

interface ListCalls {
  filters: Array<[string, unknown]>;
  order?: [string, { ascending: boolean }];
  limit?: number;
}

/** Stub de `createClient()` só pra cadeia usada pelo GET (lista) desta rota. */
function makeListClientStub(cfg: ListClientCfg = {}) {
  const calls: ListCalls = { filters: [] };
  const client = {
    from(table: string) {
      if (table !== "prospected_searches") throw new Error(`unexpected table ${table}`);
      return {
        select(_cols: string) {
          return {
            eq(col: string, val: unknown) {
              calls.filters.push([col, val]);
              return {
                order(col2: string, opts: { ascending: boolean }) {
                  calls.order = [col2, opts];
                  return {
                    limit(n: number) {
                      calls.limit = n;
                      return Promise.resolve(cfg.result ?? { data: [], error: null });
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
  return { client, calls };
}

const VALID_BODY = {
  businessType: "padaria",
  location: "São Paulo, SP",
  nicheId: NICHE_ID,
};

/** Filtra os `rpcCalls` (todos passam por `emit_event`) por `p_event_type`. */
function eventosDoTipo(calls: Calls, eventType: string) {
  return calls.rpcCalls.filter((c) => c.params.p_event_type === eventType);
}

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

  it("sem nicheId → busca funciona (0239): PESOS_PADRAO, sem requisito nenhum, niche_id null, nunca consulta prospecting_niches", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({
      places: [PLACE_WITH_SITE],
      placesApiCapped: false,
    });
    const { client, calls } = makeAdminStub({ insertPlacesResult: "echo" });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ businessType: "padaria", location: "São Paulo, SP" }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { places: Array<{ scoreInitial: number; requisitosOk: boolean }> };
    };
    const esperado = scoreInitial({ hasWebsite: true, rating: 4.2, reviewCount: 30 }, PESOS_PADRAO);
    expect(body.data.places[0]?.scoreInitial).toBe(esperado.score);
    expect(body.data.places[0]?.requisitosOk).toBe(true); // sem nicho, sem requirements, nada reprova

    expect(calls.insertedSearch?.niche_id).toBeNull();
    expect(searchPlaces).toHaveBeenCalled();
  });

  it("nicheId de outra organização (ou inexistente) → 404, nunca chama a Places API", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ nicheResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(404);
    expect(searchPlaces).not.toHaveBeenCalled();
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

  it("mistura com/sem site: score usa os pesos do nicho, 3 tipos de evento emitidos corretamente", async () => {
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
          requisitosOk: boolean;
        }>;
      };
    };

    expect(body.data.searchId).toBe(SEARCH_ID);
    expect(body.data.places).toHaveLength(2);

    const comSite = body.data.places.find((p) => p.websiteUrl !== null)!;
    const semSite = body.data.places.find((p) => p.websiteUrl === null)!;

    // Score usa os pesos do NICHO da busca (PESOS_NICHO), não mais uma constante fixa.
    const esperadoComSite = scoreInitial({ hasWebsite: true, rating: 4.2, reviewCount: 30 }, PESOS_NICHO);
    const esperadoSemSite = scoreInitial({ hasWebsite: false, rating: 4.9, reviewCount: 50 }, PESOS_NICHO);
    expect(comSite.scoreInitial).toBe(esperadoComSite.score);
    expect(comSite.statusLabel).toBe(esperadoComSite.label);
    expect(comSite.siteAnalysisStatus).toBe("pending");
    expect(comSite.requisitosOk).toBe(true); // sem requirements no nicho de teste, nada reprova
    expect(semSite.scoreInitial).toBe(esperadoSemSite.score);
    expect(semSite.statusLabel).toBe(esperadoSemSite.label);
    expect(semSite.siteAnalysisStatus).toBe("not_applicable");

    // site_quality_requested: só quem TEM site (P2 original, inalterado).
    const siteEvents = eventosDoTipo(calls, "prospected_place.site_quality_requested");
    expect(siteEvents).toHaveLength(1);
    expect(siteEvents[0]?.params.p_entity_id).toBe(comSite.id);

    // cnpj_requested: TODO resultado (T8/T9) — 100%, independe de site/peso.
    const cnpjEvents = eventosDoTipo(calls, "prospected_place.cnpj_requested");
    expect(cnpjEvents).toHaveLength(2);
    expect(cnpjEvents.map((e) => e.params.p_entity_id).sort()).toEqual([comSite.id, semSite.id].sort());

    // instagram_requested: só quem NÃO tem site (weights.instagram=15>0 no nicho de teste).
    const instaEvents = eventosDoTipo(calls, "prospected_place.instagram_requested");
    expect(instaEvents).toHaveLength(1);
    expect(instaEvents[0]?.params.p_entity_id).toBe(semSite.id);

    // organization_id/requested_by vêm de requireRole, nunca do body; service_type é CÓPIA do nicho.
    expect(calls.insertedSearch).toEqual(
      expect.objectContaining({
        organization_id: ORG_ID,
        requested_by: USER_ID,
        business_type: "padaria",
        location: "São Paulo, SP",
        service_type: "venda de site",
        niche_id: NICHE_ID,
        result_count: 2,
        places_api_capped: false,
      }),
    );

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.search_run",
        metadata: expect.objectContaining({ result_count: 2, with_website_count: 1, niche_id: NICHE_ID }),
      }),
    );
  });

  it("resultado fora dos requisitos do nicho → requisitos_ok=false com motivo preenchido", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({ places: [PLACE_WITHOUT_SITE], placesApiCapped: false });
    // PLACE_WITHOUT_SITE tem reviewCount: 50 — exige mínimo de 1000 pra reprovar de propósito.
    const { client } = makeAdminStub({
      nicheResult: { data: nicheRow({ requirements: { avaliacoesMin: 1000 } }), error: null },
      insertPlacesResult: "echo",
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { places: Array<{ requisitosOk: boolean; motivoRequisitos: string | null }> } };
    expect(body.data.places[0]?.requisitosOk).toBe(false);
    expect(body.data.places[0]?.motivoRequisitos).toContain("avaliações");
  });

  it("2 nichos diferentes pro MESMO resultado dão notas diferentes (prova que o peso é usado)", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({ places: [PLACE_WITH_SITE], placesApiCapped: false });

    const nichoA = nicheRow({ weights: { ...PESOS_NICHO, site: 100, instagram: 0, whatsapp: 0, email: 0, telefone: 0, reputacao: 0, cnpj: 0, endereco: 0, linkedin: 0 } });
    const { client: clientA } = makeAdminStub({ nicheResult: { data: nichoA, error: null }, insertPlacesResult: "echo" });
    vi.mocked(createAdminClient).mockReturnValue(clientA as never);
    const { POST } = await import("./route");
    const resA = await POST(postReq(VALID_BODY));
    const bodyA = (await resA.json()) as { data: { places: Array<{ scoreInitial: number }> } };

    vi.mocked(createAdminClient).mockClear();
    const nichoB = nicheRow({ weights: { ...PESOS_NICHO, site: 10, instagram: 0, whatsapp: 0, email: 0, telefone: 0, reputacao: 0, cnpj: 0, endereco: 0, linkedin: 0 } });
    const { client: clientB } = makeAdminStub({ nicheResult: { data: nichoB, error: null }, insertPlacesResult: "echo" });
    vi.mocked(createAdminClient).mockReturnValue(clientB as never);
    const resB = await POST(postReq(VALID_BODY));
    const bodyB = (await resB.json()) as { data: { places: Array<{ scoreInitial: number }> } };

    expect(bodyA.data.places[0]?.scoreInitial).not.toBe(bodyB.data.places[0]?.scoreInitial);
  });

  it("nicho com weights.instagram=0 → nenhum instagram_requested, mesmo sem site", async () => {
    mockAuthzOk();
    vi.mocked(searchPlaces).mockResolvedValue({ places: [PLACE_WITHOUT_SITE], placesApiCapped: false });
    const { client, calls } = makeAdminStub({
      nicheResult: { data: nicheRow({ weights: { ...PESOS_NICHO, instagram: 0 } }), error: null },
      insertPlacesResult: "echo",
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(201);
    expect(eventosDoTipo(calls, "prospected_place.instagram_requested")).toHaveLength(0);
    // cnpj continua saindo pra 100%, independente do peso de Instagram.
    expect(eventosDoTipo(calls, "prospected_place.cnpj_requested")).toHaveLength(1);
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
      const { client, calls } = makeAdminStub({});
      vi.mocked(createAdminClient).mockReturnValue(client as never);

      const { POST } = await import("./route");
      const res = await POST(postReq(VALID_BODY));

      expect(res.status).toBe(expectedStatus);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
      // O nicho já foi carregado (createAdminClient É chamado antes da Places
      // API, T8) — o que prova "nada parcial" é que NENHUM insert aconteceu.
      expect(calls.insertedSearch).toBeUndefined();
      expect(calls.insertedPlaces).toBeUndefined();
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

describe("GET /api/v1/prospecting/searches", () => {
  it("sem role manager+ → repassa authz.response, nunca chama o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente.", 403, {}),
    } as never);

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lista as buscas da organização ativa, mais recentes primeiro, mapeadas pra DTO camelCase", async () => {
    mockAuthzOk();
    const rows = [
      searchRow({ id: SEARCH_ID, business_type: "padaria", result_count: 2 }),
      searchRow({ id: "44444444-4444-4444-8444-444444444444", business_type: "barbearia", result_count: 0, places_api_capped: true }),
    ];
    const { client, calls } = makeListClientStub({ result: { data: rows } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      {
        id: SEARCH_ID,
        businessType: "padaria",
        location: "São Paulo, SP",
        serviceType: "venda_de_site",
        resultCount: 2,
        placesApiCapped: false,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        businessType: "barbearia",
        location: "São Paulo, SP",
        serviceType: "venda_de_site",
        resultCount: 0,
        placesApiCapped: true,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    ]);
    // Filtro pela org ATIVA (não só a RLS) + ordem de recência.
    expect(calls.filters).toContainEqual(["organization_id", ORG_ID]);
    expect(calls.order).toEqual(["created_at", { ascending: false }]);
  });

  it("?limit= é respeitado (clamp 1-100, default 50)", async () => {
    mockAuthzOk();
    const { client: c1, calls: calls1 } = makeListClientStub({ result: { data: [] } });
    vi.mocked(createClient).mockResolvedValue(c1 as never);
    const { GET } = await import("./route");
    await GET(getReq("?limit=10"));
    expect(calls1.limit).toBe(10);

    vi.mocked(createClient).mockClear();
    const { client: c2, calls: calls2 } = makeListClientStub({ result: { data: [] } });
    vi.mocked(createClient).mockResolvedValue(c2 as never);
    await GET(getReq());
    expect(calls2.limit).toBe(50);

    vi.mocked(createClient).mockClear();
    const { client: c3, calls: calls3 } = makeListClientStub({ result: { data: [] } });
    vi.mocked(createClient).mockResolvedValue(c3 as never);
    await GET(getReq("?limit=9999"));
    expect(calls3.limit).toBe(100);
  });

  it("erro do Supabase → 500 internal_error", async () => {
    mockAuthzOk();
    const { client } = makeListClientStub({ result: { error: { message: "boom" } } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq());

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
