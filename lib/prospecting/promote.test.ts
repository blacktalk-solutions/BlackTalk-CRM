import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteToLead, type MotivoSemPromocao, type ResultadoPromocao } from "./promote";

/**
 * T12 — promoteToLead (lib/prospecting/promote.ts).
 *
 * Cobre: reaproveita contact existente por telefone; cria contact novo quando
 * não existe; cria lead no pipeline default/etapa de menor position; cria
 * crm_lead_links com target_kind='external'; erro ja_promovido ao tentar
 * promover de novo; erro sem_pipeline_default; erro sem_etapa; partial
 * failures (lead criado mas link falha — log e continua).
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const STAGE_ID = "66666666-6666-4666-8666-666666666666";
const LEAD_ID = "77777777-7777-4777-8777-777777777777";
const EXISTING_CONTACT_ID = "88888888-8888-4888-8888-888888888888";

const PHONE_RAW = "1133334444"; // 10 digits, will normalize to +5511333344
const PHONE_NORMALIZED = "551133334444"; // normalizePhoneToE164(PHONE_RAW) — sem "+", só dígitos

interface PlaceRow {
  id: string;
  name: string;
  phone_number: string | null; // Changed from phone_number_normalized (now computed on the fly)
  address: string | null;
  rating: number | null;
  review_count: number | null;
  place_id: string;
  website_url: string | null;
  promoted_lead_id: string | null;
}

function makePlace(overrides: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: PLACE_ID,
    name: "Padaria Brasil",
    phone_number: PHONE_RAW, // Raw format, will be normalized by promoteToLead
    address: "Rua A, 123",
    rating: 4.5,
    review_count: 25,
    place_id: "gp-123",
    website_url: "https://padaria.com.br",
    promoted_lead_id: null,
    ...overrides,
  };
}

interface ClientCfg {
  selectPlace?: { data?: PlaceRow | null; error?: unknown };
  selectContact?: { data?: unknown | null; error?: unknown };
  selectPipeline?: { data?: { id: string } | null; error?: unknown };
  selectStage?: { data?: { id: string } | null; error?: unknown };
  insertContact?: { data?: unknown | null; error?: unknown };
  insertLead?: { data?: unknown | null; error?: unknown };
  insertLink?: { error?: unknown };
  updatePlace?: { error?: unknown };
}

interface ClientCalls {
  selectedPlace?: { org: string; id: string };
  selectedContact?: { org: string; phone: string };
  selectedPipeline?: { org: string };
  selectedStage?: { org: string; pipeline: string };
  insertedContact?: Record<string, unknown>;
  insertedLead?: Record<string, unknown>;
  insertedLink?: Record<string, unknown>;
  updatedPlace?: { org: string; id: string; leadId: string };
}

function makeClientStub(cfg: ClientCfg) {
  const calls: ClientCalls = {};

  const client = {
    from(table: string) {
      if (table === "prospected_places") {
        return {
          select() {
            return {
              eq(col: string, val: string) {
                if (!calls.selectedPlace) calls.selectedPlace = { org: "", id: "" };
                if (col === "organization_id") calls.selectedPlace.org = val;
                if (col === "id") calls.selectedPlace.id = val;
                return {
                  eq(col2: string, val2: string) {
                    if (col2 === "organization_id") calls.selectedPlace!.org = val2;
                    if (col2 === "id") calls.selectedPlace!.id = val2;
                    return {
                      maybeSingle: () =>
                        Promise.resolve(
                          cfg.selectPlace ?? { data: makePlace(), error: null },
                        ),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              eq: (col: string, val: string) => {
                if (!calls.updatedPlace) calls.updatedPlace = { org: "", id: "", leadId: "" };
                if (col === "organization_id") calls.updatedPlace.org = val;
                if (col === "id") calls.updatedPlace.id = val;
                return {
                  eq: (col2: string, val2: string) => {
                    if (col2 === "organization_id") calls.updatedPlace!.org = val2;
                    if (col2 === "id") calls.updatedPlace!.id = val2;
                    return Promise.resolve(cfg.updatePlace ?? { error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "contacts") {
        return {
          select() {
            return {
              eq: function (col: string, val: string) {
                if (!calls.selectedContact)
                  calls.selectedContact = { org: "", phone: "" };
                if (col === "organization_id") calls.selectedContact.org = val;
                if (col === "phone_number") calls.selectedContact.phone = val;
                return {
                  eq: function (col2: string, val2: string) {
                    if (col2 === "organization_id") calls.selectedContact!.org = val2;
                    if (col2 === "phone_number") calls.selectedContact!.phone = val2;
                    return {
                      maybeSingle: () =>
                        Promise.resolve(
                          cfg.selectContact ?? { data: null, error: null },
                        ),
                    };
                  },
                };
              },
            };
          },
          insert: (row: Record<string, unknown>) => {
            calls.insertedContact = row;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    cfg.insertContact ?? {
                      data: { id: CONTACT_ID },
                      error: null,
                    },
                  ),
              }),
            };
          },
        };
      }

      if (table === "crm_pipelines") {
        return {
          select() {
            return {
              eq: function (col: string, val: unknown) {
                if (!calls.selectedPipeline) calls.selectedPipeline = { org: "" };
                if (col === "organization_id") calls.selectedPipeline.org = val as string;
                return {
                  eq: function (col2: string, val2: unknown) {
                    return {
                      eq: function (col3: string, val3: unknown) {
                        return {
                          maybeSingle: () =>
                            Promise.resolve(
                              cfg.selectPipeline ?? {
                                data: { id: PIPELINE_ID },
                                error: null,
                              },
                            ),
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

      if (table === "crm_stages") {
        return {
          select() {
            return {
              eq: function (col: string, val: string) {
                if (!calls.selectedStage) calls.selectedStage = { org: "", pipeline: "" };
                if (col === "organization_id") calls.selectedStage.org = val;
                if (col === "pipeline_id") calls.selectedStage.pipeline = val;
                return {
                  eq: function (col2: string, val2: string) {
                    if (col2 === "pipeline_id") calls.selectedStage!.pipeline = val2;
                    return {
                      eq: function (col3: string, val3: unknown) {
                        return {
                          eq: function (col4: string, val4: unknown) {
                            return {
                              eq: function (col5: string, val5: unknown) {
                                return {
                                  order: () => ({
                                    limit: () => ({
                                      maybeSingle: () =>
                                        Promise.resolve(
                                          cfg.selectStage ?? {
                                            data: { id: STAGE_ID },
                                            error: null,
                                          },
                                        ),
                                    }),
                                  }),
                                };
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
          },
        };
      }

      if (table === "crm_leads") {
        return {
          insert: (row: Record<string, unknown>) => {
            calls.insertedLead = row;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    cfg.insertLead ?? { data: { id: LEAD_ID }, error: null },
                  ),
              }),
            };
          },
        };
      }

      if (table === "crm_lead_links") {
        return {
          insert: (row: Record<string, unknown>) => {
            calls.insertedLink = row;
            return Promise.resolve(cfg.insertLink ?? { error: null });
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promoteToLead", () => {
  it("criação bem-sucedida: novo contact + lead + links, atualiza prospected_places", async () => {
    const { client, calls } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null }, // Não existe contact com esse telefone
    });

    const resultado = await promoteToLead(
      client as any,
      ORG_ID,
      PLACE_ID,
    );

    expect(resultado.promotado).toBe(true);
    if (resultado.promotado) {
      expect(resultado.leadId).toBe(LEAD_ID);
    }

    // Verifica fluxo: 1) leitura do place
    expect(calls.selectedPlace).toEqual({ org: ORG_ID, id: PLACE_ID });

    // 2) busca por contact existente
    expect(calls.selectedContact).toEqual({
      org: ORG_ID,
      phone: PHONE_NORMALIZED,
    });

    // 3) novo contact criado
    expect(calls.insertedContact).toEqual(
      expect.objectContaining({
        organization_id: ORG_ID,
        name: "Padaria Brasil",
        display_name: "Padaria Brasil",
        phone_number: PHONE_NORMALIZED,
        source: "google_maps_prospecting",
        source_metadata: expect.objectContaining({
          place_id: "gp-123",
          address: "Rua A, 123",
          rating: 4.5,
          review_count: 25,
        }),
      }),
    );

    // 4) pipeline default encontrado
    expect(calls.selectedPipeline).toEqual({ org: ORG_ID });

    // 5) first stage encontrado
    expect(calls.selectedStage).toEqual({
      org: ORG_ID,
      pipeline: PIPELINE_ID,
    });

    // 6) lead criado com source='google_maps_prospecting'
    expect(calls.insertedLead).toEqual(
      expect.objectContaining({
        organization_id: ORG_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        contact_id: CONTACT_ID,
        title: "Padaria Brasil",
        status: "open",
        source: "google_maps_prospecting",
        source_metadata: expect.objectContaining({
          place_id: "gp-123",
          address: "Rua A, 123",
          rating: 4.5,
          review_count: 25,
        }),
      }),
    );

    // 7) link criado com target_kind='external'
    expect(calls.insertedLink).toEqual({
      organization_id: ORG_ID,
      lead_id: LEAD_ID,
      target_kind: "external",
      target_id: PLACE_ID,
      link_kind: "prospected_place",
    });

    // 8) prospected_places atualizado (com defensive org_id filter)
    expect(calls.updatedPlace).toEqual({
      org: ORG_ID,
      id: PLACE_ID,
      leadId: expect.any(String),
    });
  });

  it("reaproveita contact existente quando telefone já existe", async () => {
    const existingContact = { id: EXISTING_CONTACT_ID };
    const { client, calls } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: existingContact },
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(true);

    // Não deve criar novo contact
    expect(calls.insertedContact).toBeUndefined();

    // Lead deve usar o contact existente
    expect(calls.insertedLead).toEqual(
      expect.objectContaining({
        contact_id: EXISTING_CONTACT_ID,
      }),
    );
  });

  it("cria contact novo quando place não tem telefone válido para normalizar", async () => {
    const place = makePlace({ phone_number: null }); // Sem telefone
    const { client, calls } = makeClientStub({
      selectPlace: { data: place },
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(true);

    // Não deve buscar contact por telefone (porque não há / não normalizável)
    expect(calls.selectedContact).toBeUndefined();

    // Deve criar novo contact sem telefone — a chave phone_number nem é
    // incluída no insert (não é "undefined", está ausente de propósito).
    expect(calls.insertedContact).not.toHaveProperty("phone_number");
    expect(calls.insertedContact).toEqual(
      expect.objectContaining({
        source: "google_maps_prospecting",
      }),
    );
  });

  it("erro ja_promovido quando promoted_lead_id já não é null (idempotente)", async () => {
    const place = makePlace({ promoted_lead_id: "existing-lead-id" });
    const { client } = makeClientStub({
      selectPlace: { data: place },
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(false);
    if (!resultado.promotado) {
      expect(resultado.motivo).toBe("ja_promovido");
    }

    // Nada mais deve ser criado
  });

  it("erro sem_pipeline_default quando organização não tem pipeline default", async () => {
    const { client } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null },
      selectPipeline: { data: null }, // Não encontrou
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(false);
    if (!resultado.promotado) {
      expect(resultado.motivo).toBe("sem_pipeline_default");
    }
  });

  it("erro sem_etapa quando pipeline não tem etapas utilizáveis", async () => {
    const { client } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null },
      selectPipeline: { data: { id: PIPELINE_ID } },
      selectStage: { data: null }, // Não encontrou
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(false);
    if (!resultado.promotado) {
      expect(resultado.motivo).toBe("sem_etapa");
    }
  });

  it("erro quando place não é encontrado", async () => {
    const { client } = makeClientStub({
      selectPlace: { data: null, error: null },
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(false);
    if (!resultado.promotado) {
      expect(resultado.motivo).toBe("erro");
    }
  });

  it("erro ao criar contact é reportado corretamente", async () => {
    const { client } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null },
      insertContact: {
        data: null,
        error: { message: "violação de constraint única" },
      },
    });

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    expect(resultado.promotado).toBe(false);
    if (!resultado.promotado) {
      expect(resultado.motivo).toBe("erro");
      // promote.ts repassa a mensagem real do erro do banco (útil pra
      // debugar); "Erro ao criar contact" só é usado como fallback quando
      // o erro não tem mensagem nenhuma — não é um prefixo somado.
      expect(resultado.detalhe).toBe("violação de constraint única");
    }
  });

  it("partial failure: link falha mas lead é criado (log não revertem)", async () => {
    const { client, calls } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null },
      insertLink: { error: { message: "link insert failed" } },
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    // Mesmo assim, a promoção é considerada bem-sucedida
    expect(resultado.promotado).toBe(true);
    if (resultado.promotado) {
      expect(resultado.leadId).toBe(LEAD_ID);
    }

    // Lead foi criado
    expect(calls.insertedLead).toBeDefined();

    // Mas link não foi criado (mas apenas logou, não falhou)
  });

  it("partial failure: prospected_places update falha mas lead/link são criados", async () => {
    const { client, calls } = makeClientStub({
      selectPlace: { data: makePlace() },
      selectContact: { data: null },
      updatePlace: { error: { message: "update failed" } },
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    const resultado = await promoteToLead(client as any, ORG_ID, PLACE_ID);

    // Mesmo assim, a promoção é bem-sucedida
    expect(resultado.promotado).toBe(true);
    if (resultado.promotado) {
      expect(resultado.leadId).toBe(LEAD_ID);
    }

    // Lead foi criado
    expect(calls.insertedLead).toBeDefined();
    // Link foi criado
    expect(calls.insertedLink).toBeDefined();
  });
});
