import { beforeEach, describe, expect, it, vi } from "vitest";

// Só o import do próprio vitest antes dos dublês/`vi.mock` — mesma ordem de
// `tests/unit/media-persist-worker.test.ts`. `vi.mock` é hoisted para o topo
// do arquivo; os `const ..._mock = vi.fn()` referenciados dentro das
// factories ficam ANTES dos `vi.mock` no texto para não depender de
// `vi.hoisted`, e os imports "de verdade" (inclusive tipos) só entram DEPOIS
// dos `vi.mock`, também espelhando o arquivo de referência.

// ─── Playwright: NUNCA abre um browser de verdade no teste ─────────────────
const gotoMock = vi.fn();
const contentMock = vi.fn();
const innerTextMock = vi.fn();
const contextCloseMock = vi.fn(async () => {});
const browserCloseMock = vi.fn(async () => {});
const newPageMock = vi.fn(async () => ({
  goto: gotoMock,
  content: contentMock,
  innerText: innerTextMock,
}));
const newContextMock = vi.fn(async () => ({
  newPage: newPageMock,
  close: contextCloseMock,
}));
const launchMock = vi.fn(async () => ({
  newContext: newContextMock,
  close: browserCloseMock,
}));

vi.mock("playwright", () => ({
  chromium: { launch: launchMock },
}));

// ─── Supabase admin: dublê fiel à cadeia real usada pelo worker ────────────
//
// Três formatos de chamada, todos sobre `prospected_places`:
//  (1) leitura:      .select(cols).eq(id).eq(org).maybeSingle()
//  (2) claim (CAS):  .update({status:"processing"}).eq(id).eq(org).eq(statusAtual).select("id")
//  (3) gravação final: .update(patch).eq(id).eq(org)  — awaited direto, sem .select()
//
// O dublê distingue (2) de (3) pelo PRÓPRIO patch (`site_analysis_status ===
// "processing"` só acontece no claim) — não por contagem de chamada, então a
// ordem dos testes não importa.
interface PlaceRowFixture {
  id: string;
  organization_id: string;
  website_url: string | null;
  rating: number | null;
  review_count: number | null;
  site_analysis_status: string;
}

const updateSpy = vi.fn();
const state: {
  placeRow: PlaceRowFixture | null;
  placeError: { message: string } | null;
  claimOk: boolean;
  claimError: { message: string } | null;
  finalUpdateError: { message: string } | null;
} = {
  placeRow: null,
  placeError: null,
  claimOk: true,
  claimError: null,
  finalUpdateError: null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "prospected_places") throw new Error(`tabela inesperada no teste: ${table}`);
      return {
        select: (_cols: string) => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.placeRow, error: state.placeError }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateSpy(patch);
          if (patch.site_analysis_status === "processing") {
            // claim otimista — 3 .eq() + .select("id")
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    select: async (_cols: string) => ({
                      data: state.claimOk ? [{ id: state.placeRow?.id }] : [],
                      error: state.claimError,
                    }),
                  }),
                }),
              }),
            };
          }
          // gravação final ("done" ou "failed") — 2 .eq(), awaited direto
          return {
            eq: () => ({
              eq: async () => ({ error: state.finalUpdateError }),
            }),
          };
        },
      };
    },
  }),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { scoreFinal } from "@/lib/prospecting/score";
import { analyzeProspectSiteQuality } from "@/workers/prospecting-site-quality-worker";

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "prospected_place.site_quality_requested",
    entity_kind: "prospected_place",
    entity_id: "place1",
    payload: { prospected_place_id: "place1", website_url: "https://example.com" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

function placeRow(overrides: Partial<PlaceRowFixture> = {}): PlaceRowFixture {
  return {
    id: "place1",
    organization_id: "org1",
    website_url: "https://example.com",
    rating: 4.8,
    review_count: 25,
    site_analysis_status: "pending",
    ...overrides,
  };
}

function lastUpdatePatch(): Record<string, unknown> {
  const calls = updateSpy.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

describe("analyzeProspectSiteQuality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.placeRow = placeRow();
    state.placeError = null;
    state.claimOk = true;
    state.claimError = null;
    state.finalUpdateError = null;
    innerTextMock.mockResolvedValue("");
  });

  it("1. sucesso: alcançável, responsivo, rápido — score final calculado e e-mail (mailto) encontrado", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      '<html><head><meta name="viewport" content="width=device-width"></head><body><a href="mailto:contato@example.com">fale conosco</a></body></html>',
    );

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_site_quality_v1", status: "ok" });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(gotoMock).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ timeout: 15_000 }),
    );

    // `loadTimeMs` real (mock resolve síncrono) fica bem abaixo de 3000ms;
    // qualquer valor pequeno cai no mesmo ramo da fórmula, então 0 aqui
    // reproduz fielmente o branch que o worker vai exercitar.
    const esperado = scoreFinal({
      hasWebsite: true,
      rating: 4.8,
      reviewCount: 25,
      siteAnalysis: { reachable: true, mobileResponsive: true, loadTimeMs: 0 },
    });
    const patch = lastUpdatePatch();
    expect(patch).toMatchObject({
      site_analysis_status: "done",
      score_final: esperado.score,
      status_label: esperado.label,
      email: "contato@example.com",
      site_analysis_result: expect.objectContaining({ reachable: true, mobileResponsive: true }),
    });

    // browser/contexto sempre fechados no caminho feliz também
    expect(contextCloseMock).toHaveBeenCalledTimes(1);
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });

  it("2. sucesso sem e-mail na página — patch de 'done' não inclui a chave email", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      '<html><head><meta name="viewport" content="width=device-width"></head><body>sem contato aqui</body></html>',
    );
    innerTextMock.mockResolvedValue("sem contato aqui, só texto qualquer sem arroba nenhuma");

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("done");
    expect(patch).not.toHaveProperty("email");
  });

  it("3. timeout/site inalcançável → failed, score_final e status_label NÃO tocados (mantém score inicial do P1)", async () => {
    gotoMock.mockRejectedValue(new Error("Timeout 15000ms exceeded."));

    const result = await analyzeProspectSiteQuality(eventRow());

    // Handled com sucesso (gravamos 'failed'), não é um "error" de dispatcher:
    // retry automático bateria no mesmo site quebrado; reprocessar é manual
    // (T11 "tentar de novo"), não responsabilidade deste worker.
    expect(result.status).toBe("ok");

    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("failed");
    expect(patch.site_analysis_result).toMatchObject({
      reachable: false,
      error: expect.stringContaining("Timeout"),
    });
    expect(patch).not.toHaveProperty("score_final");
    expect(patch).not.toHaveProperty("status_label");

    expect(contextCloseMock).toHaveBeenCalledTimes(1);
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });

  it("4. erro inesperado (não timeout de navegação) tratado do mesmo jeito, sem propagar exceção", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockRejectedValue(new Error("Execution context was destroyed"));

    await expect(analyzeProspectSiteQuality(eventRow())).resolves.toEqual({
      consumer_key: "prospecting_site_quality_v1",
      status: "ok",
    });

    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("failed");
    expect(patch.site_analysis_result).toMatchObject({
      reachable: false,
      error: expect.stringContaining("Execution context was destroyed"),
    });
    expect(patch).not.toHaveProperty("score_final");
  });

  it("5. idempotência: evento para linha já 'done' é no-op (Playwright nunca é chamado)", async () => {
    state.placeRow = placeRow({ site_analysis_status: "done" });

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result).toEqual({
      consumer_key: "prospecting_site_quality_v1",
      status: "skipped",
      detail: "already done",
    });
    expect(launchMock).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("6. idempotência: evento para linha já 'processing' é no-op (Playwright nunca é chamado)", async () => {
    state.placeRow = placeRow({ site_analysis_status: "processing" });

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result).toEqual({
      consumer_key: "prospecting_site_quality_v1",
      status: "skipped",
      detail: "already processing",
    });
    expect(launchMock).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("7. browser e contexto são fechados mesmo quando a falha acontece antes do goto (newPage lança)", async () => {
    newPageMock.mockRejectedValueOnce(new Error("target crashed"));

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("failed");
    expect(contextCloseMock).toHaveBeenCalledTimes(1);
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });

  it("8. claim otimista perdido (linha mudou entre o SELECT e o UPDATE) é no-op, sem rodar Playwright", async () => {
    state.claimOk = false;

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result).toEqual({
      consumer_key: "prospecting_site_quality_v1",
      status: "skipped",
      detail: "concurrent claim lost",
    });
    expect(launchMock).not.toHaveBeenCalled();
  });
});
