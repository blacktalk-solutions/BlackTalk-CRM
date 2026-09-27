import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * T7 — POST/GET /api/v1/prospecting/niches
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Cobre: criar com pesos somando 100 → sucesso; pesos que não somam 100 →
 * 400 `weights_not_100` com o total; `requireRole` bloqueando role
 * insuficiente; corpo inválido → 422; erro do Supabase → 500; GET lista só
 * a organização ativa.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const NICHE_ID = "33333333-3333-4333-8333-333333333333";

const PESOS_VALIDOS = {
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

const PESOS_INVALIDOS = { ...PESOS_VALIDOS, site: 50 }; // agora soma 125

function mockAuthzOk(role: "manager" | "admin" | "agent" | "viewer" = "manager") {
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

function mockAuthzDenied() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: fail("forbidden_role", "Permissão insuficiente.", 403),
  } as never);
}

interface AdminCfg {
  insertResult?: { data?: Record<string, unknown> | null; error?: unknown };
}

function makeAdminStub(cfg: AdminCfg) {
  const calls: { insertedRow?: Record<string, unknown> } = {};
  const client = {
    from(table: string) {
      if (table !== "prospecting_niches") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          calls.insertedRow = row;
          return {
            select() {
              return {
                single() {
                  return Promise.resolve(
                    cfg.insertResult ?? {
                      data: {
                        id: NICHE_ID,
                        name: row.name,
                        service_type: row.service_type,
                        search_terms: row.search_terms,
                        requirements: row.requirements,
                        weights: row.weights,
                        created_at: "2026-09-24T00:00:00.000Z",
                        updated_at: "2026-09-24T00:00:00.000Z",
                      },
                      error: null,
                    },
                  );
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

function makeQueryClientStub(cfg: { rows?: unknown[]; error?: unknown }) {
  const calls: { eqCalledWith?: [string, string]; orderCalledWith?: string } = {};
  const client = {
    from(table: string) {
      if (table !== "prospecting_niches") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq(col: string, val: string) {
              calls.eqCalledWith = [col, val];
              return {
                order(col2: string) {
                  calls.orderCalledWith = col2;
                  return Promise.resolve({ data: cfg.rows ?? [], error: cfg.error ?? null });
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

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/prospecting/niches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getReq() {
  return new NextRequest("http://localhost/api/v1/prospecting/niches", { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/prospecting/niches", () => {
  it("cria nicho com pesos somando 100 → sucesso (201)", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(
      postReq({
        name: "Clínicas odontológicas",
        serviceType: "venda de site",
        searchTerms: ["clínica odontológica"],
        requirements: { avaliacoesMin: 10 },
        weights: PESOS_VALIDOS,
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string; weights: unknown } };
    expect(body.data.id).toBe(NICHE_ID);
    expect(body.data.name).toBe("Clínicas odontológicas");
    expect(body.data.weights).toEqual(PESOS_VALIDOS);
  });

  it("registra audit prospecting.niche_created ao criar com sucesso", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    await POST(
      postReq({
        name: "Clínicas",
        serviceType: "venda de site",
        searchTerms: ["clínica"],
        weights: PESOS_VALIDOS,
      }),
    );

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.niche_created", organizationId: ORG_ID }),
    );
  });

  it("pesos que não somam 100 → 400 weights_not_100, mostrando o total", async () => {
    mockAuthzOk();

    const { POST } = await import("./route");
    const res = await POST(
      postReq({
        name: "Clínicas",
        serviceType: "venda de site",
        searchTerms: ["clínica"],
        weights: PESOS_INVALIDOS,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { total?: number } } };
    expect(body.error.code).toBe("weights_not_100");
    expect(body.error.details?.total).toBe(125);
  });

  it("requireRole bloqueando role insuficiente (agent/viewer) → resposta do authz, sem tocar o banco", async () => {
    mockAuthzDenied();
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ name: "X", serviceType: "y", searchTerms: ["z"], weights: PESOS_VALIDOS }),
    );

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("corpo inválido (sem searchTerms) → 422", async () => {
    mockAuthzOk();

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "X", serviceType: "y", searchTerms: [], weights: PESOS_VALIDOS }));

    expect(res.status).toBe(422);
  });

  it("erro do Supabase no insert → 500", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({ insertResult: { data: null, error: { message: "boom" } } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ name: "X", serviceType: "y", searchTerms: ["z"], weights: PESOS_VALIDOS }),
    );

    expect(res.status).toBe(500);
  });
});

describe("GET /api/v1/prospecting/niches", () => {
  it("lista só nichos da organização ATIVA (filtro explícito além da RLS)", async () => {
    mockAuthzOk();
    const { createClient } = await import("@/lib/supabase/server");
    const { client, calls } = makeQueryClientStub({
      rows: [
        {
          id: NICHE_ID,
          name: "Clínicas",
          service_type: "venda de site",
          search_terms: ["clínica"],
          requirements: {},
          weights: PESOS_VALIDOS,
          created_at: "2026-09-24T00:00:00.000Z",
          updated_at: "2026-09-24T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(200);
    expect(calls.eqCalledWith).toEqual(["organization_id", ORG_ID]);
    const body = (await res.json()) as { data: Array<{ id: string; serviceType: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.serviceType).toBe("venda de site");
  });

  it("requireRole bloqueando role insuficiente", async () => {
    mockAuthzDenied();

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(403);
  });

  it("erro do Supabase na listagem → 500", async () => {
    mockAuthzOk();
    const { createClient } = await import("@/lib/supabase/server");
    const { client } = makeQueryClientStub({ error: { message: "boom" } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(500);
  });
});
