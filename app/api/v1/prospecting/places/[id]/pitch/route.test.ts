import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAiGatewayConfigured } from "@/lib/ai/gateway";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser, Role } from "@/lib/auth/types";

/**
 * POST /api/v1/prospecting/places/[id]/pitch — gatilho MANUAL de geração de
 * pitch por IA (migration 0238). Mesmo formato de teste de
 * `../reanalyze/route.test.ts` (dublê fiel da cadeia Supabase), adaptado às
 * diferenças de contrato desta rota: guarda de `isAiGatewayConfigured()`
 * ANTES de tudo, e pending/processing são 200 idempotente (não 409, porque
 * clicar duas vezes rápido não deveria ser erro pro operador).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/gateway", () => ({ isAiGatewayConfigured: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const SEARCH_ID = "33333333-3333-4333-8333-333333333333";

function mockAuthzOk(role: Role = "manager") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

function placeRow(overrides = {}) {
  return {
    id: PLACE_ID,
    search_id: SEARCH_ID,
    place_id: "gp-1",
    organization_id: ORG_ID,
    oportunidade_pitch_status: "not_applicable",
    ...overrides,
  };
}

type StubConfig = {
  selectResult?: { data: unknown; error: unknown };
  updateError?: { message: string } | null;
  updateData?: Array<{ id: string }> | null;
  rpcError?: { message: string } | null;
};

function makeAdminStub(cfg: StubConfig) {
  const calls: {
    selectFilters: unknown[][];
    updateFilters: unknown[][];
    rpcCall?: { name: string; params: unknown };
  } = { selectFilters: [], updateFilters: [] };
  const client = {
    from(table: string) {
      if (table === "prospected_places") {
        return {
          select() {
            return {
              eq(col: string, val: unknown) {
                calls.selectFilters.push([col, val]);
                return {
                  eq(col2: string, val2: unknown) {
                    calls.selectFilters.push([col2, val2]);
                    return {
                      maybeSingle() {
                        return Promise.resolve(cfg.selectResult ?? { data: null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              eq(col: string, val: unknown) {
                calls.updateFilters.push([col, val]);
                return {
                  eq(col2: string, val2: unknown) {
                    calls.updateFilters.push([col2, val2]);
                    return {
                      eq(col3: string, val3: unknown) {
                        calls.updateFilters.push([col3, val3]);
                        return {
                          select() {
                            return Promise.resolve({
                              data: cfg.updateError ? null : (cfg.updateData ?? [{ id: PLACE_ID }]),
                              error: cfg.updateError ?? null,
                            });
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
    rpc(name: string, params: unknown) {
      calls.rpcCall = { name, params };
      return Promise.resolve({ data: null, error: cfg.rpcError ?? null });
    },
  };
  return { client, calls };
}

function postReq(id: string) {
  return new NextRequest(`http://localhost/api/v1/prospecting/places/${id}/pitch`, { method: "POST" });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAiGatewayConfigured).mockReturnValue(true);
});

describe("POST /api/v1/prospecting/places/[id]/pitch", () => {
  it("sem role manager+ → 403", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "No", 403, {}) });
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("sem chave de IA configurada → 503, nunca consulta o banco", async () => {
    mockAuthzOk();
    vi.mocked(isAiGatewayConfigured).mockReturnValue(false);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("ai_gateway_not_configured");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("place inexistente (ou de outra organização) → 404", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ selectResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(404);
  });

  it("status pending → 200 idempotente, não emite de novo", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "pending" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
    expect(calls.rpcCall).toBeUndefined();
  });

  it("status processing → 200 idempotente, não emite de novo", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "processing" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("processing");
    expect(calls.rpcCall).toBeUndefined();
  });

  it("status not_applicable → 200, emite evento, atualiza pra pending, audita", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "not_applicable" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
    expect(calls.rpcCall?.name).toBe("emit_event");
    expect((calls.rpcCall?.params as { p_event_type: string }).p_event_type).toBe("prospected_place.pitch_requested");
    expect(calls.updateFilters).toEqual([
      ["id", PLACE_ID],
      ["organization_id", ORG_ID],
      ["oportunidade_pitch_status", "not_applicable"],
    ]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "prospecting.place_pitch_generate" }));
  });

  it("status failed → 200, permite tentar de novo", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "failed" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    expect(calls.rpcCall?.name).toBe("emit_event");
  });

  it("status done → 200, permite regenerar", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "done" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    expect(calls.rpcCall?.name).toBe("emit_event");
  });

  it("emit_event falha → 500, não atualiza status", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "failed" }), error: null },
      rpcError: { message: "boom" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
    expect(calls.updateFilters).toEqual([]);
  });

  it("worker já ganhou a corrida (claim perdido) → 200 already_progressed", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "failed" }), error: null },
      updateData: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("already_progressed");
  });

  it("select error → 500", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ selectResult: { data: null, error: { message: "boom" } } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
  });

  it("update error → 500", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: placeRow({ oportunidade_pitch_status: "failed" }), error: null },
      updateError: { message: "boom" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
  });
});
