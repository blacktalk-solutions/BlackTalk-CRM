import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `workers/prospecting-pitch-worker.ts` — mesma doutrina de teste dos 3
 * workers irmãos (`prospecting-site-quality-worker.test.ts`,
 * `prospecting-cnpj-worker.test.ts`, `prospecting-instagram-worker.test.ts`):
 * dublê fiel da cadeia Supabase, claim otimista provado por CAS perdido, e
 * toda exceção de VERDADE (não só `{data,error}`) tratada sem escapar pro
 * dispatcher.
 *
 * Diferença dos 3 irmãos: este worker chama `generateObject` (pacote `ai`) —
 * mockado aqui, nunca uma chamada de rede real — e a checagem de IA
 * configurada roda ANTES do claim (ver nota de topo do arquivo testado).
 */

const { updateSpy, state } = vi.hoisted(() => {
  const updateSpy = vi.fn();
  const state: {
    placeRow: Record<string, unknown> | null;
    placeError: { message: string } | null;
    selectThrows: Error | null;
    claimOk: boolean;
    claimError: { message: string } | null;
    claimThrows: Error | null;
    finalUpdateError: { message: string } | null;
    failUpdateError: { message: string } | null;
  } = {
    placeRow: null,
    placeError: null,
    selectThrows: null,
    claimOk: true,
    claimError: null,
    claimThrows: null,
    finalUpdateError: null,
    failUpdateError: null,
  };
  return { updateSpy, state };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "prospected_places") throw new Error(`tabela inesperada no teste: ${table}`);
      return {
        select: (_cols: string) => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (state.selectThrows) throw state.selectThrows;
                return { data: state.placeRow, error: state.placeError };
              },
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateSpy(patch);
          // Objeto genérico: `.eq()` encadeia à vontade (a claim usa 3, o
          // resto usa 2 ou 3 dependendo do caminho); `.select()` é o desfecho
          // do CLAIM (patch com status='processing'); ausência de `.select()`
          // (código faz `await ...eq()`) resolve via `then` — mesmo truque do
          // `PostgrestFilterBuilder` real, que é thenable.
          const chain: Record<string, unknown> = {
            eq: () => chain,
            select: async (_c: string) => {
              if (state.claimThrows) throw state.claimThrows;
              return { data: state.claimOk ? [{ id: (state.placeRow as { id: string } | null)?.id }] : [], error: state.claimError };
            },
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              const p =
                patch.oportunidade_pitch_status === "done"
                  ? Promise.resolve({ error: state.finalUpdateError })
                  : Promise.resolve({ error: state.failUpdateError });
              return p.then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
  }),
}));

const { isAiGatewayConfiguredMock, resolveLanguageModelMock } = vi.hoisted(() => ({
  isAiGatewayConfiguredMock: vi.fn(),
  resolveLanguageModelMock: vi.fn(),
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-5",
  isAiGatewayConfigured: isAiGatewayConfiguredMock,
  resolveLanguageModel: resolveLanguageModelMock,
}));

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock("ai", () => ({ generateObject: generateObjectMock }));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { generateProspectPitch } from "@/workers/prospecting-pitch-worker";

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "prospected_place.pitch_requested",
    entity_kind: "prospected_place",
    entity_id: "place1",
    payload: { prospected_place_id: "place1", search_id: "search1", place_id: "gp-1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

function placeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "place1",
    organization_id: "org1",
    name: "Clínica OSPE",
    address: "Av. Paulista, 1000",
    score_final: 62,
    score_initial: 55,
    status_label: "oportunidade",
    website_url: "https://clinicaospe.com.br",
    site_analysis_status: "done",
    site_analysis_result: { reachable: true, mobileResponsive: false, hasWhatsappButton: false, hasMetaPixel: false, hasGoogleAdsPixel: false, hasGoogleAnalytics: false, desatualizado: false, copyrightYear: 2026 },
    cnpj_data: null,
    instagram_data: null,
    oportunidade_pitch_status: "not_applicable",
    ...overrides,
  };
}

function lastUpdatePatch(): Record<string, unknown> {
  const calls = updateSpy.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

describe("generateProspectPitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.placeRow = placeRow();
    state.placeError = null;
    state.selectThrows = null;
    state.claimOk = true;
    state.claimError = null;
    state.claimThrows = null;
    state.finalUpdateError = null;
    state.failUpdateError = null;
    isAiGatewayConfiguredMock.mockReturnValue(true);
    resolveLanguageModelMock.mockReturnValue({ modelId: "anthropic/claude-sonnet-5" });
    generateObjectMock.mockResolvedValue({
      object: { justificativaOportunidade: "Venda site novo, o atual não tem WhatsApp nem pixel.", abordagemInstagram: null },
    });
  });

  it("1. sucesso com Instagram confirmado — grava justificativa e ganchos, status done", async () => {
    state.placeRow = placeRow({
      instagram_data: { seguidores: 1200, bio: "Clínica odontológica", diasSemPostar: 40 },
    });
    generateObjectMock.mockResolvedValue({
      object: {
        justificativaOportunidade: "O site não tem pixel nem WhatsApp — comece por ali.",
        abordagemInstagram: "Pergunte sobre os 40 dias sem postar.",
      },
    });

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "ok" });
    const patch = lastUpdatePatch();
    expect(patch).toMatchObject({
      oportunidade_pitch_status: "done",
      justificativa_oportunidade: "O site não tem pixel nem WhatsApp — comece por ali.",
      abordagem_instagram: "Pergunte sobre os 40 dias sem postar.",
    });
    expect(patch.oportunidade_pitch_gerado_em).toEqual(expect.any(String));
  });

  it("2. sucesso sem Instagram — abordagem_instagram gravado null mesmo se o modelo devolver texto", async () => {
    state.placeRow = placeRow({ instagram_data: null });
    generateObjectMock.mockResolvedValue({
      object: { justificativaOportunidade: "Venda site.", abordagemInstagram: "gancho que não deveria ser usado" },
    });

    await generateProspectPitch(eventRow());

    const patch = lastUpdatePatch();
    expect(patch.abordagem_instagram).toBeNull();
  });

  it("3. idempotência: já 'done' é no-op, generateObject nunca é chamado", async () => {
    state.placeRow = placeRow({ oportunidade_pitch_status: "done" });

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "skipped", detail: "already done" });
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("4. idempotência: já 'processing' é no-op", async () => {
    state.placeRow = placeRow({ oportunidade_pitch_status: "processing" });

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "skipped", detail: "already processing" });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("5. sem chave de IA configurada → grava 'failed', nunca chama generateObject, devolve 'ok'", async () => {
    isAiGatewayConfiguredMock.mockReturnValue(false);

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "ok" });
    expect(generateObjectMock).not.toHaveBeenCalled();
    const patch = lastUpdatePatch();
    expect(patch.oportunidade_pitch_status).toBe("failed");
  });

  it("6. isAiGatewayConfigured=true mas resolveLanguageModel devolve null → grava 'failed', defesa em profundidade", async () => {
    resolveLanguageModelMock.mockReturnValue(null);

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "ok" });
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(lastUpdatePatch().oportunidade_pitch_status).toBe("failed");
  });

  it("7. claim otimista perdido → skip, generateObject nunca é chamado", async () => {
    state.claimOk = false;

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "skipped", detail: "concurrent claim lost" });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("8. generateObject lança exceção → catch grava 'failed', não escapa pro dispatcher", async () => {
    generateObjectMock.mockRejectedValue(new Error("Overloaded (529)"));

    const result = await generateProspectPitch(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "ok" });
    const patch = lastUpdatePatch();
    expect(patch.oportunidade_pitch_status).toBe("failed");
  });

  it("9. leitura inicial lança exceção de VERDADE → mesmo assim grava 'failed'", async () => {
    state.selectThrows = new Error("fetch failed: ECONNRESET");

    const result = await generateProspectPitch(eventRow());

    expect(result.status).toBe("ok");
    expect(lastUpdatePatch().oportunidade_pitch_status).toBe("failed");
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("10. claim lança exceção de VERDADE → mesmo assim grava 'failed'", async () => {
    state.claimThrows = new Error("fetch failed: ETIMEDOUT");

    const result = await generateProspectPitch(eventRow());

    expect(result.status).toBe("ok");
    expect(lastUpdatePatch().oportunidade_pitch_status).toBe("failed");
  });

  it("11. falha ao gravar 'failed' também → status 'error', mensagem combinada", async () => {
    generateObjectMock.mockRejectedValue(new Error("boom"));
    state.failUpdateError = { message: "banco fora do ar" };

    const result = await generateProspectPitch(eventRow());

    expect(result.status).toBe("error");
    expect(result.detail).toContain("boom");
    expect(result.detail).toContain("banco fora do ar");
  });

  it("12. sem prospected_place_id no evento → skipped, nunca toca o banco", async () => {
    const result = await generateProspectPitch(eventRow({ payload: {}, entity_id: undefined }));

    expect(result).toEqual({ consumer_key: "prospecting_pitch_v1", status: "skipped", detail: "no prospected_place_id" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
