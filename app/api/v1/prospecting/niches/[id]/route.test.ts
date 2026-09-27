import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * T7 — PATCH /api/v1/prospecting/niches/[id]
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Cobre: edita com sucesso; pesos que não somam 100 → 400 `weights_not_100`;
 * nicho não encontrado (ou de outra organização) → 404; nenhum campo → 422;
 * `requireRole` bloqueando; e a invariante central da task — editar um nicho
 * NUNCA toca `prospected_searches`/`prospected_places` (o stub do admin
 * client lança se alguém tentar consultar qualquer tabela além de
 * `prospecting_niches`, o que prova, por construção, que nenhuma busca
 * antiga é recalculada).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
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

/**
 * Lança se QUALQUER tabela além de `prospecting_niches` for tocada — é o que
 * prova, por construção, que editar um nicho não recalcula
 * `prospected_searches`/`prospected_places` (não há sequer um caminho de
 * código pra chegar lá).
 */
function makeAdminStub(cfg: { updateResult?: { data?: Record<string, unknown> | null; error?: unknown } }) {
  const calls: { patch?: Record<string, unknown>; eqCalls: Array<[string, unknown]> } = { eqCalls: [] };
  const client = {
    from(table: string) {
      if (table !== "prospecting_niches") throw new Error(`unexpected table ${table}`);
      return {
        update(patch: Record<string, unknown>) {
          calls.patch = patch;
          const builder = {
            eq(col: string, val: unknown) {
              calls.eqCalls.push([col, val]);
              return builder;
            },
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve(
                    cfg.updateResult ?? {
                      data: {
                        id: NICHE_ID,
                        name: patch.name ?? "Clínicas",
                        service_type: patch.service_type ?? "venda de site",
                        search_terms: patch.search_terms ?? ["clínica"],
                        requirements: patch.requirements ?? {},
                        weights: patch.weights ?? PESOS_VALIDOS,
                        created_at: "2026-09-01T00:00:00.000Z",
                        updated_at: "2026-09-24T00:00:00.000Z",
                      },
                      error: null,
                    },
                  );
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

function patchReq(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/prospecting/niches/${NICHE_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const CTX = { params: Promise.resolve({ id: NICHE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/prospecting/niches/[id]", () => {
  it("edita um nicho existente com sucesso", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client, calls } = makeAdminStub({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ name: "Clínicas odontológicas — atualizado" }), CTX);

    expect(res.status).toBe(200);
    expect(calls.patch).toEqual({ name: "Clínicas odontológicas — atualizado" });
    // Sempre filtra pela organização ativa, além do id — defesa em profundidade sobre RLS.
    expect(calls.eqCalls).toContainEqual(["id", NICHE_ID]);
    expect(calls.eqCalls).toContainEqual(["organization_id", ORG_ID]);
  });

  it("editar não toca prospected_searches/prospected_places (nenhuma busca antiga é recalculada)", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { PATCH } = await import("./route");
    // Se o handler tentasse tocar prospected_searches/prospected_places, o
    // stub acima lançaria "unexpected table" e este teste falharia.
    const res = await PATCH(patchReq({ weights: PESOS_VALIDOS }), CTX);
    expect(res.status).toBe(200);
  });

  it("pesos que não somam 100 → 400 weights_not_100", async () => {
    mockAuthzOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ weights: { ...PESOS_VALIDOS, site: 50 } }), CTX);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { total?: number } } };
    expect(body.error.code).toBe("weights_not_100");
    expect(body.error.details?.total).toBe(125);
  });

  it("nicho não encontrado (id inexistente ou de outra organização) → 404", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({ updateResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ name: "X" }), CTX);

    expect(res.status).toBe(404);
  });

  it("nenhum campo para alterar → 422, sem tocar o banco", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({}), CTX);

    expect(res.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("requireRole bloqueando role insuficiente (agent/viewer)", async () => {
    mockAuthzDenied();
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ name: "X" }), CTX);

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("registra audit prospecting.niche_updated com os campos alterados", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { PATCH } = await import("./route");
    await PATCH(patchReq({ name: "Novo nome" }), CTX);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.niche_updated",
        organizationId: ORG_ID,
        resourceId: NICHE_ID,
        metadata: { campos: ["name"] },
      }),
    );
  });

  it("erro do Supabase no update → 500", async () => {
    mockAuthzOk();
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { client } = makeAdminStub({ updateResult: { data: null, error: { message: "boom" } } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ name: "X" }), CTX);

    expect(res.status).toBe(500);
  });
});
