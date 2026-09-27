import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

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
    site_analysis_status: "failed",
    site_analysis_result: null,
    email: null,
    promoted_lead_id: null,
    promoted_at: null,
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
                              data: cfg.updateError
                                ? null
                                : (cfg.updateData ?? [{ id: PLACE_ID }]),
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
  return new NextRequest(`http://localhost/api/v1/prospecting/places/${id}/reanalyze`, {
    method: "POST",
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/prospecting/places/[id]/reanalyze", () => {
  it("sem role manager+ → 403", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "No", 403, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("place inexistente → 404", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ selectResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(404);
  });

  it("cross-tenant → 404", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ selectResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(404);
  });

  it("status pending → 409", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "pending" }),
        error: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(409);
  });

  it("status processing → 409", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "processing" }),
        error: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(409);
  });

  it("status done → 409", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: placeRow({ site_analysis_status: "done" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(409);
  });

  it("status not_applicable → 409", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "not_applicable" }),
        error: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(409);
  });

  it("status failed → 200, updates status, emits event, audits", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "failed" }),
        error: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
    expect(calls.selectFilters).toEqual([
      ["id", PLACE_ID],
      ["organization_id", ORG_ID],
    ]);
    expect(calls.updateFilters).toEqual([
      ["id", PLACE_ID],
      ["organization_id", ORG_ID],
      ["site_analysis_status", "failed"],
    ]);
    expect(calls.rpcCall?.name).toBe("emit_event");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.place_reanalyze" })
    );
  });

  it("emit_event falha → 500, não atualiza status (fica 'failed', botão de retry continua aparecendo)", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "failed" }),
        error: null,
      },
      rpcError: { message: "boom" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
    // Emit falhou antes do update rodar — status nunca é tocado.
    expect(calls.updateFilters).toEqual([]);
  });

  it("worker já ganhou a corrida (claim perdido) → 200 already_progressed, não reverte status", async () => {
    mockAuthzOk();
    const { client, calls } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "failed" }),
        error: null,
      },
      updateData: [], // 0 linhas casaram o CAS: o worker já moveu pra processing/done
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("already_progressed");
    // O evento ainda foi emitido (não é esse o problema) — só o update final
    // é que respeitou o CAS e não reverteu nada.
    expect(calls.rpcCall?.name).toBe("emit_event");
  });

  it("select error → 500", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
  });

  it("update error → 500", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "failed" }),
        error: null,
      },
      updateError: { message: "boom" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
  });
});
