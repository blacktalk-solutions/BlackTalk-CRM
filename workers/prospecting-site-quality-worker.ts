/**
 * Consome `prospected_place.site_quality_requested` (P2 da prospecção via
 * Google Maps — `.specs/features/prospeccao-google-maps/`): abre o
 * `website_url` de um `prospected_places` com Playwright, mede
 * alcançabilidade/responsividade/tempo de carregamento, tenta achar um
 * e-mail de contato, recalcula o score via `lib/prospecting/score.ts` e
 * persiste o resultado.
 *
 * Idempotência: `event_log` real (migration 0234_prospeccao_google_maps) NÃO
 * tem coluna `external_id`/constraint de idempotência — `design.md` original
 * supunha que tinha; não tem (achado confirmado na Task 4, reconfirmado
 * aqui lendo o schema de novo). A idempotência desta feature vive na
 * APLICAÇÃO: `prospected_places.site_analysis_status` é a guarda —
 * 'done'/'processing' → no-op; 'pending'/'failed' → processa. Ver
 * `.superpowers/sdd/tasks/task-8-brief.md`, seção "Correção importante".
 *
 * Spec (`.specs/features/prospeccao-google-maps/spec.md`, P2, linhas 71-72):
 * - Site alcançável (responde, mesmo com HTTP de erro) → análise SUCEDEU:
 *   `site_analysis_status='done'`, `score_final` recalculado via
 *   `scoreFinal` (que já sabe pontuar `reachable:false` para uma resposta
 *   HTTP de erro — "site inalcançável: boa oportunidade").
 * - Timeout / site fora do ar / erro de navegação (Playwright não conseguiu
 *   nem obter uma resposta) → análise FALHOU:
 *   `site_analysis_status='failed'`, e o requirement PROSPECT-11 é
 *   explícito: "mantendo o score inicial do P1" — ou seja, `score_final`
 *   NÃO é tocado aqui (fica null se já era null; a UI usa
 *   `scoreFinal ?? scoreInitial`). Ver `lib/prospecting/score.ts` e o teste
 *   deste arquivo para os dois cenários lado a lado.
 */
import { chromium, type Browser } from "playwright";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { scoreFinal } from "@/lib/prospecting/score";
import { createAdminClient } from "@/lib/supabase/admin";

export const PROSPECTING_SITE_QUALITY_CONSUMER_KEY = "prospecting_site_quality_v1";

/** Timeout de navegação do Playwright — PROSPECT-10 exige exatamente 15s. */
const NAVIGATION_TIMEOUT_MS = 15_000;

/** Abaixo disto a resposta HTTP conta como "site alcançável". */
const HTTP_ERROR_STATUS_THRESHOLD = 400;

interface ProspectedPlaceRow {
  id: string;
  organization_id: string;
  website_url: string | null;
  rating: number | null;
  review_count: number | null;
  site_analysis_status: string;
}

interface PlaywrightAnalysisResult {
  /** HTTP 2xx/3xx recebido dentro do timeout. */
  reachable: boolean;
  /**
   * Heurística de responsividade: presença de `<meta name="viewport">` no
   * HTML. É um proxy simples e conhecidamente incompleto — NÃO prova que o
   * layout de fato se adapta a telas pequenas (um site pode ter a tag e
   * ainda assim ter CSS quebrado em mobile, ou ser responsivo por outra
   * técnica sem declarar a tag). Fora de escopo desta task fazer uma
   * análise visual real (viewport emulation + screenshot diff); ver
   * PROSPECT-10 e o brief da Task 8.
   */
  mobileResponsive: boolean;
  loadTimeMs: number;
  /** Primeiro e-mail encontrado (mailto: ou regex no texto visível). */
  email?: string;
}

/** `<a href="mailto:...">` — primeira ocorrência, sem juntar todos. */
const MAILTO_RE = /href=["']mailto:([^"'?\s]+)/i;
/** Padrão de e-mail simples — primeira ocorrência no texto visível da página. */
const EMAIL_TEXT_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * Extrai o primeiro e-mail de contato encontrado.
 *
 * Estratégia (nessa ordem): (1) link `mailto:` no HTML — sinal forte de
 * "e-mail de contato deliberado"; (2) regex de e-mail no TEXTO VISÍVEL
 * (`innerText`, não o HTML bruto) — evita casar endereços dentro de
 * `<script>`/JSON-LD/comentários que nunca aparecem pro usuário.
 *
 * Limitações honestas: não distingue um e-mail real de algo que só parece
 * um (ex. texto de exemplo/copyright), não valida deliverability, e
 * `innerText` aproxima "visível" pelo motor de render do Chromium — não é
 * uma prova rigorosa de visibilidade (ex. texto dentro de um carrossel
 * colapsado pode ou não entrar, dependendo de como o CSS esconde).
 */
function extractEmailFromMailto(html: string): string | undefined {
  const match = html.match(MAILTO_RE);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function extractEmailFromText(text: string): string | undefined {
  return text.match(EMAIL_TEXT_RE)?.[0];
}

function hasViewportMeta(html: string): boolean {
  return /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
}

/**
 * Abre `websiteUrl` num browser Chromium efêmero e mede os indicadores.
 *
 * Lança (throw) quando a navegação falha/expira — timeout, DNS, conexão
 * recusada — o chamador trata isso como "análise falhou" (PROSPECT-11).
 * Uma resposta HTTP de erro (4xx/5xx) NÃO lança: o Playwright conseguiu
 * "responder", então isso é `reachable:false` mas análise bem-sucedida
 * (ver comentário de topo do arquivo).
 *
 * SEMPRE fecha o browser e o contexto, mesmo em erro — `.close()` de cada
 * um é `.catch()`-ado para nunca mascarar a exceção original de navegação.
 */
async function runPlaywrightAnalysis(websiteUrl: string): Promise<PlaywrightAnalysisResult> {
  const browser: Browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const startedAt = Date.now();
      const response = await page.goto(websiteUrl, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: "load",
      });
      const loadTimeMs = Date.now() - startedAt;
      const status = response?.status() ?? 0;
      const reachable = status > 0 && status < HTTP_ERROR_STATUS_THRESHOLD;

      const html = await page.content();
      const mobileResponsive = hasViewportMeta(html);

      let email = extractEmailFromMailto(html);
      if (!email) {
        // Não crítico: se innerText falhar por qualquer motivo, apenas
        // seguimos sem e-mail em vez de derrubar a análise inteira.
        const visibleText = await page.innerText("body").catch(() => "");
        email = extractEmailFromText(visibleText);
      }

      return { reachable, mobileResponsive, loadTimeMs, email };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Handler principal — assinatura `(row: EventRow) => Promise<HandlerResult>`,
 * mesmo contrato de `workers/media-persist-worker.ts` (`persistMessageMedia`),
 * confirmado lendo esse par + `lib/event-log/dispatcher.ts` inteiros antes de
 * codar (pesquisa obrigatória do brief).
 */
export async function analyzeProspectSiteQuality(row: EventRow): Promise<HandlerResult> {
  const consumer_key = PROSPECTING_SITE_QUALITY_CONSUMER_KEY;

  const prospectedPlaceId =
    (row.payload.prospected_place_id as string | undefined) ?? row.entity_id ?? undefined;
  if (!prospectedPlaceId) {
    return { consumer_key, status: "skipped", detail: "no prospected_place_id" };
  }

  const admin = createAdminClient();

  // A leitura inicial, o claim otimista e a análise inteira vivem dentro do
  // MESMO try: um erro `{data, error}` estruturado do Postgrest (branches
  // `if (error) return ...` abaixo) continua tratado como antes, sem tocar
  // no status da linha — mas uma exceção de VERDADE (throw — falha de rede
  // no client Supabase, por exemplo) em QUALQUER um desses passos agora cai
  // no catch de baixo e grava `site_analysis_status='failed'`, em vez de
  // escapar sem deixar rastro na linha (achado do code review da Task 8: o
  // dispatcher já protege o PROCESSO, mas não persiste o 'failed' — quem
  // faz isso é este catch).
  try {
    const { data, error } = await admin
      .from("prospected_places")
      .select("id, organization_id, website_url, rating, review_count, site_analysis_status")
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (error) return { consumer_key, status: "error", detail: error.message };

    const place = data as ProspectedPlaceRow | null;
    if (!place) return { consumer_key, status: "skipped", detail: "prospected_place not found" };
    if (!place.website_url) {
      // Invariante: a rota de busca (T4) só emite este evento para linhas COM
      // site. Chegar aqui sem `website_url` não deveria acontecer — guarda
      // defensiva, não um caminho esperado.
      return { consumer_key, status: "skipped", detail: "no website_url" };
    }

    // ─── GUARD DE IDEMPOTÊNCIA (aplicação, não constraint de banco) ─────────
    // 'done'/'processing' → já concluído ou já em voo: no-op, conta como
    // sucesso vazio (o evento é marcado consumido normalmente pelo drain).
    if (place.site_analysis_status === "done" || place.site_analysis_status === "processing") {
      return { consumer_key, status: "skipped", detail: `already ${place.site_analysis_status}` };
    }

    // Claim otimista (mesmo espírito do claim de `event_log` em drain.ts):
    // só avança se o UPDATE realmente casar a linha no status que acabamos de
    // ler. Se outra execução concorrente (reanalyze duplicado, retry) já
    // moveu a linha para 'processing' entre o SELECT e aqui, `claimed` vem
    // vazio e tratamos como no-op em vez de rodar o Playwright duas vezes.
    const { data: claimed, error: claimErr } = await admin
      .from("prospected_places")
      .update({ site_analysis_status: "processing" })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id)
      .eq("site_analysis_status", place.site_analysis_status)
      .select("id");
    if (claimErr) return { consumer_key, status: "error", detail: claimErr.message };
    if (!claimed?.length) {
      return { consumer_key, status: "skipped", detail: "concurrent claim lost" };
    }

    const analysis = await runPlaywrightAnalysis(place.website_url);

    const scoreResult = scoreFinal({
      hasWebsite: true,
      rating: place.rating ?? undefined,
      reviewCount: place.review_count ?? undefined,
      siteAnalysis: {
        reachable: analysis.reachable,
        mobileResponsive: analysis.mobileResponsive,
        loadTimeMs: analysis.loadTimeMs,
      },
    });

    const patch: Record<string, unknown> = {
      site_analysis_status: "done",
      site_analysis_result: {
        reachable: analysis.reachable,
        mobileResponsive: analysis.mobileResponsive,
        loadTimeMs: analysis.loadTimeMs,
      },
      score_final: scoreResult.score,
      status_label: scoreResult.label,
    };
    if (analysis.email) patch.email = analysis.email;

    const { error: updErr } = await admin
      .from("prospected_places")
      .update(patch)
      .eq("id", place.id)
      .eq("organization_id", place.organization_id);
    if (updErr) throw new Error(`update (done) failed: ${updErr.message}`);

    return { consumer_key, status: "ok" };
  } catch (err) {
    // PROSPECT-11: timeout, site fora do ar, erro de navegação — e também
    // qualquer erro inesperado em QUALQUER passo do try acima (leitura
    // inicial, claim otimista, análise, gravação de 'done') — tudo cai
    // aqui. Nunca deixamos a exceção escapar pro dispatcher; sempre
    // tentamos gravar 'failed' com o motivo.
    //
    // Usa `prospectedPlaceId`/`row.organization_id` (conhecidos ANTES do
    // try) em vez de `place.id`/`place.organization_id`: `place` é
    // block-scoped dentro do try e pode nem existir ainda se foi a própria
    // leitura inicial que lançou. Os dois pares são equivalentes quando
    // `place` existe (é exatamente o que a leitura filtrou por `.eq()`).
    //
    // Trade-off aceito conscientemente: se a exceção veio da LEITURA (antes
    // de sabermos o status atual) ou do CLAIM, gravamos 'failed' sem
    // confirmar que a linha não tinha acabado de virar 'done' por outro
    // caminho no mesmo instante — uma janela de corrida estreitíssima (só
    // existe se dois eventos distintos pra mesma linha estiverem em voo ao
    // mesmo tempo, o que T11/reanalyze pode em tese causar). Preferível a
    // deixar a linha presa sem nenhum sinal de que algo deu errado.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting-site-quality] análise falhou", {
      prospected_place_id: prospectedPlaceId,
      detail,
    });

    const { error: failErr } = await admin
      .from("prospected_places")
      .update({
        site_analysis_status: "failed",
        // `score_final`/`status_label` DELIBERADAMENTE fora deste patch:
        // PROSPECT-11 manda manter o score inicial do P1 quando a análise
        // falha, não zerar/recalcular. A UI lê `scoreFinal ?? scoreInitial`.
        site_analysis_result: { reachable: false, error: detail },
      })
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id);

    if (failErr) {
      // Pior caso: nem a gravação de 'failed' foi possível (banco fora do
      // ar?). A linha fica presa em 'processing' — não há reaper para
      // `prospected_places.site_analysis_status` hoje (só `event_log` tem,
      // em drain.ts). Devolver "error" deixa o dispatcher tentar de novo;
      // documentado como limitação conhecida no relatório da Task 8.
      logger.error("[prospecting-site-quality] gravação de 'failed' também falhou", {
        prospected_place_id: prospectedPlaceId,
        detail: failErr.message,
      });
      return { consumer_key, status: "error", detail: `${detail}; also failed to persist: ${failErr.message}` };
    }

    // Estado 'failed' persistido com sucesso: o evento foi tratado por
    // completo (fizemos tudo que dava pra fazer). NÃO retornamos "error"
    // aqui de propósito — um "error" faria o drain reagendar e tentar de
    // novo automaticamente (backoff de drain.ts), batendo no mesmo site
    // quebrado sem intervenção humana; o reprocessamento intencional desta
    // feature é manual, via a ação "tentar de novo" (T11), que emite um
    // novo evento depois de resetar o status. "ok" marca o evento como
    // consumido, sem retry automático.
    return { consumer_key, status: "ok" };
  }
}
