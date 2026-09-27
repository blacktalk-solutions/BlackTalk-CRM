import { beforeEach, describe, expect, it, vi } from "vitest";

// Só o import do próprio vitest antes dos dublês/`vi.mock` — mesma ordem de
// `tests/unit/media-persist-worker.test.ts`. `vi.mock` é hoisted para o topo
// do arquivo; os `const ..._mock = vi.fn()` referenciados dentro das
// factories ficam ANTES dos `vi.mock` no texto para não depender de
// `vi.hoisted`, e os imports "de verdade" (inclusive tipos) só entram DEPOIS
// dos `vi.mock`, também espelhando o arquivo de referência.
//
// Movido de `workers/prospecting-site-quality-worker.test.ts` pro local real
// de todo teste de worker deste repo (`tests/unit/`) — os outros 8 testes de
// worker existentes (media-persist-worker, media-derive-worker,
// ai-response-worker-*, lgpd-*, agenda-google-*-worker) já vivem aqui; o
// brief original da Task 8 pedia co-locado em `workers/`, mas isso não batia
// com nenhum teste de worker já existente no repo — ruling do orquestrador
// depois do code review. Nenhum import precisou mudar: todos usam alias `@/`,
// não caminho relativo.

// ─── Playwright: NUNCA abre um browser de verdade no teste ─────────────────
//
// `vi.hoisted()` em vez de `const` soltos: o arquivo testado
// (`workers/prospecting-site-quality-worker.ts`) é importado estaticamente
// mais abaixo (linha ~135), e imports estáticos são resolvidos ANTES do
// corpo do módulo de teste rodar — quando isso acontece, o `import
// { chromium } from "playwright"` daquele arquivo já aciona a factory do
// `vi.mock` abaixo, e ela tentava ler `launchMock` antes da linha `const
// launchMock = vi.fn(...)` ter executado (TDZ: "Cannot access 'launchMock'
// before initialization"). `vi.hoisted()` sobe esses `vi.fn()` pro mesmo
// estágio de hoisting do `vi.mock`, eliminando a corrida.
const {
  gotoMock,
  contentMock,
  innerTextMock,
  contextCloseMock,
  browserCloseMock,
  newPageMock,
  newContextMock,
  launchMock,
} = vi.hoisted(() => {
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
  return {
    gotoMock,
    contentMock,
    innerTextMock,
    contextCloseMock,
    browserCloseMock,
    newPageMock,
    newContextMock,
    launchMock,
  };
});

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
//
// `selectThrows`/`claimThrows`: simulam uma exceção de VERDADE (não um
// `{data, error}` estruturado) escapando da leitura inicial ou do claim —
// cenário do Important #1 do code review: o worker precisa capturar isso e
// gravar 'failed', não deixar escapar.
interface PlaceRowFixture {
  id: string;
  organization_id: string;
  search_id: string;
  place_id: string;
  website_url: string | null;
  rating: number | null;
  review_count: number | null;
  site_analysis_status: string;
}

// Mesmo motivo do `vi.hoisted()` do bloco do Playwright acima: o worker é
// importado estaticamente mais abaixo, e esse import aciona a factory do
// `vi.mock("@/lib/supabase/admin", ...)` antes de `const`s soltos aqui
// terem rodado.
const { updateSpy, rpcSpy, state } = vi.hoisted(() => {
  const updateSpy = vi.fn();
  const rpcSpy = vi.fn();
  const state: {
    placeRow: PlaceRowFixture | null;
    placeError: { message: string } | null;
    selectThrows: Error | null;
    claimOk: boolean;
    claimError: { message: string } | null;
    claimThrows: Error | null;
    finalUpdateError: { message: string } | null;
    /** T11 — `null` = "sem nicho" (fallback pro shim de pesos legado). */
    searchRow: { niche_id: string | null } | null;
    nicheRow: { weights: Record<string, number> } | null;
    rpcError: { message: string } | null;
  } = {
    placeRow: null,
    placeError: null,
    selectThrows: null,
    claimOk: true,
    claimError: null,
    claimThrows: null,
    finalUpdateError: null,
    searchRow: { niche_id: null },
    nicheRow: null,
    rpcError: null,
  };
  return { updateSpy, rpcSpy, state };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      // T11: lookup de nicho (place.search_id → niche_id → weights). Por
      // padrão devolve "sem nicho" (niche_id null) — o worker cai no MESMO
      // shim de pesos que reproduz a fórmula anterior a T3/T8, e todo teste
      // "herdado" que já existia continua batendo os mesmos números sem
      // precisar saber que este lookup existe. `state.searchRow`/
      // `state.nicheRow` deixam um teste dedicado (abaixo) sobrescrever isso.
      if (table === "prospected_searches") {
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.searchRow, error: null }),
            }),
          }),
        };
      }
      if (table === "prospecting_niches") {
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.nicheRow, error: null }),
            }),
          }),
        };
      }
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
          if (patch.site_analysis_status === "processing") {
            // claim otimista — 3 .eq() + .select("id")
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    select: async (_cols: string) => {
                      if (state.claimThrows) throw state.claimThrows;
                      return {
                        data: state.claimOk ? [{ id: state.placeRow?.id }] : [],
                        error: state.claimError,
                      };
                    },
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
    // T11: emissão de `instagram_requested` quando o nicho dá peso a esse sinal.
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcSpy(name, params);
      return { error: state.rpcError };
    },
  }),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { scoreFinal, type NicheWeights } from "@/lib/prospecting/score";
import { analyzeProspectSiteQuality } from "@/workers/prospecting-site-quality-worker";

/** Mesmo shim `LEGACY_FULL_WEIGHT_SHIM` do worker (T3) — reproduz a fórmula de antes de T3, sem escala. */
const LEGACY_FULL_WEIGHT_SHIM: NicheWeights = {
  site: 100,
  instagram: 0,
  whatsapp: 0,
  email: 0,
  telefone: 0,
  reputacao: 100,
  cnpj: 0,
  endereco: 0,
  linkedin: 0,
};

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
    search_id: "search1",
    place_id: "gp-1",
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
    state.selectThrows = null;
    state.claimOk = true;
    state.claimError = null;
    state.claimThrows = null;
    state.finalUpdateError = null;
    state.searchRow = { niche_id: null }; // T11: sem nicho por padrão -> shim legado, mesmos números de sempre
    state.nicheRow = null;
    state.rpcError = null;
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
    const esperado = scoreFinal(
      {
        hasWebsite: true,
        rating: 4.8,
        reviewCount: 25,
        siteAnalysis: { reachable: true, mobileResponsive: true, loadTimeMs: 0 },
      },
      LEGACY_FULL_WEIGHT_SHIM,
    );
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

  it("3. timeout/site inalcançável (goto lança) → failed, score_final e status_label NÃO tocados (mantém score inicial do P1)", async () => {
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

  it("9. goto() RESOLVE com HTTP 500 (não lança) → 'done' (não 'failed'), score recalculado com reachable:false", async () => {
    // Distinção central do worker (comentário de topo do arquivo): uma
    // resposta HTTP de erro NÃO é uma exceção de navegação — o Playwright
    // conseguiu "responder". Isso é análise BEM-SUCEDIDA com reachable:false,
    // não uma falha (PROSPECT-11 só cobre timeout/site fora do ar/erro de
    // navegação — nenhum dos três aconteceu aqui).
    gotoMock.mockResolvedValue({ status: () => 500 });
    contentMock.mockResolvedValue(
      '<html><head><meta name="viewport" content="width=device-width"></head><body>erro 500</body></html>',
    );

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_site_quality_v1", status: "ok" });

    const esperado = scoreFinal(
      {
        hasWebsite: true,
        rating: 4.8,
        reviewCount: 25,
        siteAnalysis: { reachable: false, mobileResponsive: true, loadTimeMs: 0 },
      },
      LEGACY_FULL_WEIGHT_SHIM,
    );
    const patch = lastUpdatePatch();
    expect(patch).toMatchObject({
      site_analysis_status: "done",
      score_final: esperado.score,
      status_label: esperado.label,
      site_analysis_result: expect.objectContaining({ reachable: false, mobileResponsive: true }),
    });
    // Não é o caminho de falha: não deve ter `error` no resultado da análise.
    expect(patch.site_analysis_result).not.toHaveProperty("error");

    expect(contextCloseMock).toHaveBeenCalledTimes(1);
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });

  it("10. leitura inicial lança uma exceção de VERDADE (não {data,error}) → mesmo assim grava 'failed', não escapa pro dispatcher", async () => {
    state.selectThrows = new Error("fetch failed: ECONNRESET");

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("failed");
    expect(patch.site_analysis_result).toMatchObject({
      reachable: false,
      error: expect.stringContaining("ECONNRESET"),
    });
    // Nem chegou perto do Playwright — a exceção veio antes de qualquer claim.
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("11. claim otimista lança uma exceção de VERDADE (não {data,error}) → mesmo assim grava 'failed'", async () => {
    state.claimThrows = new Error("fetch failed: ETIMEDOUT");

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("failed");
    expect(patch.site_analysis_result).toMatchObject({
      reachable: false,
      error: expect.stringContaining("ETIMEDOUT"),
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  // ─── T11 — encadeamento do Instagram ────────────────────────────────────

  it("12. HTML com link de Instagram + nicho com peso>0 → link extraído e passado no evento", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      '<html><body><a href="https://www.instagram.com/clinica.ospe/">Instagram</a></body></html>',
    );
    state.searchRow = { niche_id: "niche1" };
    state.nicheRow = { weights: { instagram: 15 } };

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    expect(rpcSpy).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "prospected_place.instagram_requested",
        p_entity_id: "place1",
        p_payload: expect.objectContaining({
          prospected_place_id: "place1",
          search_id: "search1",
          instagram_link: "https://www.instagram.com/clinica.ospe/",
        }),
      }),
    );
  });

  it("13. HTML sem link de Instagram + nicho com peso>0 → evento ainda emitido, com instagram_link=null", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body>sem redes sociais aqui</body></html>");
    state.searchRow = { niche_id: "niche1" };
    state.nicheRow = { weights: { instagram: 15 } };

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    expect(rpcSpy).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "prospected_place.instagram_requested",
        p_payload: expect.objectContaining({ instagram_link: null }),
      }),
    );
  });

  it("14. nicho com weights.instagram === 0 → NÃO emite instagram_requested", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      '<html><body><a href="https://www.instagram.com/clinica.ospe/">Instagram</a></body></html>',
    );
    state.searchRow = { niche_id: "niche1" };
    state.nicheRow = { weights: { instagram: 0 } };

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("15. score final usa os pesos DE VERDADE do nicho da busca (não mais o shim legado)", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body></body></html>");
    state.searchRow = { niche_id: "niche1" };
    state.nicheRow = { weights: { site: 25, instagram: 0, whatsapp: 0, email: 0, telefone: 0, reputacao: 0, cnpj: 0, endereco: 0, linkedin: 0 } };

    await analyzeProspectSiteQuality(eventRow());

    const esperado = scoreFinal(
      { hasWebsite: true, rating: 4.8, reviewCount: 25, siteAnalysis: { reachable: true, mobileResponsive: false, loadTimeMs: 0 } },
      { site: 25, instagram: 0, whatsapp: 0, email: 0, telefone: 0, reputacao: 0, cnpj: 0, endereco: 0, linkedin: 0 },
    );
    const patch = lastUpdatePatch();
    expect(patch.score_final).toBe(esperado.score);
    // Prova que NÃO é mais o shim legado (que daria um número bem maior aqui).
    expect(patch.score_final).not.toBe(
      scoreFinal(
        { hasWebsite: true, rating: 4.8, reviewCount: 25, siteAnalysis: { reachable: true, mobileResponsive: false, loadTimeMs: 0 } },
        LEGACY_FULL_WEIGHT_SHIM,
      ).score,
    );
  });

  it("16. falha ao emitir instagram_requested não desfaz a análise já concluída (fire-and-forget)", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body></body></html>");
    state.searchRow = { niche_id: "niche1" };
    state.nicheRow = { weights: { instagram: 15 } };
    state.rpcError = { message: "emit_event indisponível" };

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_status).toBe("done");
  });

  // ─── Raio-x do site: botão WhatsApp / pixel Meta / tag Google Ads / GA / rodapé ──

  it("17. HTML com todos os 4 sinais de marketing presentes + rodapé do ano corrente → todos true, desatualizado=false", async () => {
    const anoCorrente = new Date().getFullYear();
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      `<html><body>
        <a href="https://wa.me/5511999998888">Fale no WhatsApp</a>
        <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
        <script>gtag('config', 'AW-123456789');</script>
        <script src="https://www.googletagmanager.com/gtag/js?id=G-ABCDEF"></script>
      </body></html>`,
    );
    innerTextMock.mockResolvedValue(`Fale no WhatsApp © ${anoCorrente} Minha Empresa`);

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_result).toMatchObject({
      hasWhatsappButton: true,
      hasMetaPixel: true,
      hasGoogleAdsPixel: true,
      hasGoogleAnalytics: true,
      copyrightYear: anoCorrente,
      desatualizado: false,
    });
  });

  it("18. HTML sem nenhum dos 4 sinais de marketing e sem rodapé → todos false, copyrightYear null, desatualizado false", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body>página simples, sem nada disso</body></html>");
    innerTextMock.mockResolvedValue("página simples, sem nada disso");

    const result = await analyzeProspectSiteQuality(eventRow());

    expect(result.status).toBe("ok");
    const patch = lastUpdatePatch();
    expect(patch.site_analysis_result).toMatchObject({
      hasWhatsappButton: false,
      hasMetaPixel: false,
      hasGoogleAdsPixel: false,
      hasGoogleAnalytics: false,
      copyrightYear: null,
      desatualizado: false,
    });
  });

  it("19. rodapé com mais de 1 ano de atraso → desatualizado=true", async () => {
    const anoAntigo = new Date().getFullYear() - 3;
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body>site parado</body></html>");
    innerTextMock.mockResolvedValue(`Copyright ${anoAntigo} Minha Empresa`);

    const result = await analyzeProspectSiteQuality(eventRow());

    const patch = lastUpdatePatch();
    expect(patch.site_analysis_result).toMatchObject({ copyrightYear: anoAntigo, desatualizado: true });
  });

  it("20. rodapé do ano anterior (folga de 1 ano) → NÃO é desatualizado", async () => {
    const anoPassado = new Date().getFullYear() - 1;
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue("<html><body>site ok</body></html>");
    innerTextMock.mockResolvedValue(`© ${anoPassado}`);

    const result = await analyzeProspectSiteQuality(eventRow());

    const patch = lastUpdatePatch();
    expect(patch.site_analysis_result).toMatchObject({ copyrightYear: anoPassado, desatualizado: false });
  });

  it("21. raio-x não influencia score_final nem status_label — só site/reputação (mesmo score de antes do raio-x existir)", async () => {
    gotoMock.mockResolvedValue({ status: () => 200 });
    contentMock.mockResolvedValue(
      '<html><head><meta name="viewport" content="width=device-width"></head><body><a href="https://wa.me/5511999998888">zap</a></body></html>',
    );
    innerTextMock.mockResolvedValue("© 2019 empresa bem antiga");

    await analyzeProspectSiteQuality(eventRow());

    const esperado = scoreFinal(
      {
        hasWebsite: true,
        rating: 4.8,
        reviewCount: 25,
        siteAnalysis: { reachable: true, mobileResponsive: true, loadTimeMs: 0 },
      },
      LEGACY_FULL_WEIGHT_SHIM,
    );
    const patch = lastUpdatePatch();
    expect(patch.score_final).toBe(esperado.score);
    expect(patch.status_label).toBe(esperado.label);
  });
});
