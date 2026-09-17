/**
 * Score de perspectiva de Google Maps.
 *
 * Fórmula pura, sem I/O, sem dependência de banco/rede. Calcula score inicial
 * (antes de site analysis) e score final (com dados de análise do site).
 *
 * Estilos e princípios: a fórmula é auditável, cada parcela documentada, sem
 * chamadas de modelo — o "porquê" é derivado do cálculo, não gerado ao lado.
 */

/**
 * Status/rótulo do prospect, derivado do score final.
 *
 * - "quente": score >= 70, alta probabilidade de conversão
 * - "oportunidade": 40 <= score < 70, conversão possível
 * - "baixa": score < 40, baixa prioridade
 */
export type StatusLabel = "quente" | "oportunidade" | "baixa";

/**
 * Entrada para `scoreInitial`: dados mínimos, antes de análise do site.
 */
export interface ScoreInput {
  /** Prospect tem website registrado/detectado. */
  hasWebsite: boolean;
  /** Avaliação média (p.ex., do Google Maps). Varia de 1 a 5. */
  rating?: number;
  /** Número de avaliações/reviews. */
  reviewCount?: number;
}

/**
 * Análise do site: reachability, responsividade, performance.
 *
 * Chamada pela fórmula de `scoreFinal`.
 */
export interface SiteAnalysisInput {
  /** Site é alcançável (HTTP 2xx/3xx, sem timeout). */
  reachable: boolean;
  /**
   * Site é responsivo (mobile-friendly).
   *
   * Se `undefined`, trata como "não comprovado responsivo" = false para fins
   * de scoring. Só a combinação explícita `true` levanta o site.
   */
  mobileResponsive?: boolean;
  /** Tempo de carregamento em milissegundos. */
  loadTimeMs?: number;
}

/**
 * Resultado do scoring: score numérico + rótulo.
 */
export interface ScoreResult {
  score: number;
  label: StatusLabel;
}

/** Constantes da fórmula para auditoria. */
const SCORE_BASE_SEM_SITE = 90;
const SCORE_BASE_COM_SITE = 30;
const SCORE_BASE_INALCANCAVEL = 85;
const SCORE_BASE_LENTO_OU_NAO_RESPONSIVO = 55;
const SCORE_BASE_BOM = 20;
const SCORE_AJUSTE_BONUS_ALTO = 10; // rating >= 4.5 && reviewCount >= 20
const SCORE_AJUSTE_BONUS_MEDIO = 5; // rating >= 4.0
const SCORE_AJUSTE_PENALIDADE_POUCOS_REVIEWS = -10; // reviewCount < 5
const SCORE_LIMITE_QUENTE = 70; // >= 70 é "quente"
const SCORE_LIMITE_OPORTUNIDADE = 40; // >= 40 && < 70 é "oportunidade"
const RATING_LIMITE_BONUS_ALTO = 4.5;
const RATING_LIMITE_BONUS_MEDIO = 4.0;
const REVIEW_COUNT_PARA_BONUS_ALTO = 20;
const REVIEW_COUNT_LIMITE_PENALIDADE = 5;
const LOAD_TIME_LIMITE_MS = 3000;

/**
 * Rótulo de faixa de score.
 *
 * Limites exatos:
 * - >= SCORE_LIMITE_QUENTE (70) → "quente"
 * - >= SCORE_LIMITE_OPORTUNIDADE (40) && < SCORE_LIMITE_QUENTE → "oportunidade"
 * - < SCORE_LIMITE_OPORTUNIDADE → "baixa"
 *
 * Exportado para testes de limite diretos em valores que a fórmula não alcança
 * (p.ex., 39, 69) mas cuja classificação precisa ser auditável.
 */
export function labelFromScore(score: number): StatusLabel {
  if (score >= SCORE_LIMITE_QUENTE) return "quente";
  if (score >= SCORE_LIMITE_OPORTUNIDADE) return "oportunidade";
  return "baixa";
}

/**
 * Calcula ajuste de rating/reviews.
 *
 * Regras:
 * - +SCORE_AJUSTE_BONUS_ALTO (10) se rating >= RATING_LIMITE_BONUS_ALTO (4.5) && reviewCount >= REVIEW_COUNT_PARA_BONUS_ALTO (20)
 * - senão +SCORE_AJUSTE_BONUS_MEDIO (5) se rating >= RATING_LIMITE_BONUS_MEDIO (4.0)
 * - -SCORE_AJUSTE_PENALIDADE_POUCOS_REVIEWS (10) se reviewCount !== undefined && reviewCount < REVIEW_COUNT_LIMITE_PENALIDADE (5)
 * - ausência de rating/reviewCount → nenhum ajuste
 *
 * A devolução é aditiva: somas antes do clamp.
 */
function calcularAjuste(input: ScoreInput): number {
  let ajuste = 0;

  // Checagem de undefined INLINE, e não via `temRating`/`temReviewCount`
  // guardados à parte: o TypeScript só estreita `input.rating`/
  // `input.reviewCount` de `number | undefined` para `number` a partir da
  // checagem que os testa DIRETAMENTE — uma booleana solta (por mais que
  // calculada a partir do mesmo `!== undefined`) não carrega esse estreitamento
  // para quem lê `input.rating` depois. Mesma lógica de antes, sem o TS2532/
  // TS18048 (achado ao rodar `pnpm typecheck` pela primeira vez nesta task).
  const { rating, reviewCount } = input;

  // Bonificação por rating alto + reviews suficientes
  if (
    rating !== undefined &&
    reviewCount !== undefined &&
    rating >= RATING_LIMITE_BONUS_ALTO &&
    reviewCount >= REVIEW_COUNT_PARA_BONUS_ALTO
  ) {
    ajuste += SCORE_AJUSTE_BONUS_ALTO;
  } else if (rating !== undefined && rating >= RATING_LIMITE_BONUS_MEDIO) {
    // Bonificação por rating bom, mesmo que reviews < 20
    ajuste += SCORE_AJUSTE_BONUS_MEDIO;
  }

  // Penalidade por poucos reviews (descredibilidade)
  if (reviewCount !== undefined && reviewCount < REVIEW_COUNT_LIMITE_PENALIDADE) {
    ajuste += SCORE_AJUSTE_PENALIDADE_POUCOS_REVIEWS;
  }

  return ajuste;
}

/**
 * Score inicial: antes de análise do site.
 *
 * Base:
 * - Sem site (hasWebsite === false) → SCORE_BASE_SEM_SITE (90, "prospect quente" por ausência de concorrência digital)
 * - Com site (hasWebsite === true) → SCORE_BASE_COM_SITE (30, score neutro/provisório até `scoreFinal`)
 *
 * Depois: aplicar ajuste de rating/reviews e clampear a 0-100.
 *
 * @param input Dados mínimos do prospect.
 * @returns Score (0-100) e rótulo ("quente" | "oportunidade" | "baixa").
 */
export function scoreInitial(input: ScoreInput): ScoreResult {
  const base = input.hasWebsite ? SCORE_BASE_COM_SITE : SCORE_BASE_SEM_SITE;
  const ajuste = calcularAjuste(input);
  const bruto = base + ajuste;
  const score = Math.max(0, Math.min(100, bruto));

  return {
    score,
    label: labelFromScore(score),
  };
}

/**
 * Score final: com análise do site.
 *
 * Base (determinada pela análise do site):
 * - Inalcançável (reachable === false) → SCORE_BASE_INALCANCAVEL (85, oportunidade: sem concorrência online)
 * - Alcançável, mas não-responsivo ou lento:
 *   - mobileResponsive === false OU loadTimeMs > LOAD_TIME_LIMITE_MS (3000) → SCORE_BASE_LENTO_OU_NAO_RESPONSIVO (55)
 *   - (Nota: undefined mobileResponsive é tratado como false/"não comprovado")
 * - Alcançável, responsivo (true), rápido (<= LOAD_TIME_LIMITE_MS) → SCORE_BASE_BOM (20, já está bem, pouco margem)
 *
 * Depois: aplicar ajuste de rating/reviews e clampear a 0-100.
 *
 * @param input Dados do prospect + análise do site.
 * @returns Score (0-100) e rótulo.
 */
export function scoreFinal(
  input: ScoreInput & { siteAnalysis: SiteAnalysisInput },
): ScoreResult {
  const { siteAnalysis } = input;

  // Determinar base de acordo com análise do site
  let base: number;

  if (!siteAnalysis.reachable) {
    // Site inalcançável: boa oportunidade
    base = SCORE_BASE_INALCANCAVEL;
  } else {
    // Site alcançável: avaliar responsividade + performance
    // Nota: undefined mobileResponsive é tratado como "não comprovado" = false
    const ehResponsivo = siteAnalysis.mobileResponsive === true;
    const temCarregamentoRapido = (siteAnalysis.loadTimeMs ?? Infinity) <= LOAD_TIME_LIMITE_MS;

    if (ehResponsivo && temCarregamentoRapido) {
      // Site bom: pouco margem de melhoria
      base = SCORE_BASE_BOM;
    } else {
      // Site ruim (não-responsivo OU lento): oportunidade clara
      base = SCORE_BASE_LENTO_OU_NAO_RESPONSIVO;
    }
  }

  const ajuste = calcularAjuste(input);
  const bruto = base + ajuste;
  const score = Math.max(0, Math.min(100, bruto));

  return {
    score,
    label: labelFromScore(score),
  };
}
