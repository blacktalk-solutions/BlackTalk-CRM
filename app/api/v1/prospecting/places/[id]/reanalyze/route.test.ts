import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const SEARCH_ID = "33333333-3333-4333-8333-333333333333";

function mockAuthzOk(role = "manager") {
  const user = {
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

function makeAdminStub(cfg) {
  const calls = { selectFilters: [], updateFilters: [] };
  const client = {
    from(table) {
      if (table === "prospected_places") {
        return {
          select() {
            return {
              eq(col, val) {
                calls.selectFilters.push([col, val]);
                return {
                  eq(col2, val2) {
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
              eq(col, val) {
                calls.updateFilters.push([col, val]);
                return {
                  eq(col2, val2) {
                    calls.updateFilters.push([col2, val2]);
                    return Promise.resolve({ error: cfg.updateError ?? null });
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name, params) {
      calls.rpcCall = { name, params };
      return Promise.resolve({ data: null, error: cfg.rpcError ?? null });
    },
  };
  return { client, calls };
}

function postReq(id) {
  return new NextRequest(`http://localhost/api/v1/prospecting/places/${id}/reanalyze`, {
    method: "POST",
  });
}

function ctx(id) {
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
    vi.mocked(createAdminClient).mockReturnValue(client);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(404);
  });

  it("cross-tenant → 404", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({ selectResult: { data: null, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    vi.mocked(createAdminClient).mockReturnValue(client);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(409);
  });

  it("status done → 409", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: placeRow({ site_analysis_status: "done" }), error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    ]);
    expect(calls.rpcCall.name).toBe("emit_event");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.place_reanalyze" })
    );
  });

  it("emit_event fails → 200 (graceful)", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: {
        data: placeRow({ site_analysis_status: "failed" }),
        error: null,
      },
      rpcError: { message: "boom" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(200);
  });

  it("select error → 500", async () => {
    mockAuthzOk();
    const { client } = makeAdminStub({
      selectResult: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(client);
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
    vi.mocked(createAdminClient).mockReturnValue(client);
    const { POST } = await import("./route");
    const res = await POST(postReq(PLACE_ID), ctx(PLACE_ID));
    expect(res.status).toBe(500);
  });
});
