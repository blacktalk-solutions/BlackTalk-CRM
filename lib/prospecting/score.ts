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

/**
 * Rótulo de faixa de score.
 *
 * Limites exatos:
 * - 70+ → "quente"
 * - 40-69 → "oportunidade"
 * - 0-39 → "baixa"
 */
function labelFromScore(score: number): StatusLabel {
  if (score >= 70) return "quente";
  if (score >= 40) return "oportunidade";
  return "baixa";
}

/**
 * Calcula ajuste de rating/reviews.
 *
 * Regras:
 * - +10 se rating >= 4.5 && reviewCount >= 20
 * - senão +5 se rating >= 4.0
 * - -10 se reviewCount !== undefined && reviewCount < 5
 * - ausência de rating/reviewCount → nenhum ajuste
 *
 * A devolução é aditiva: somas antes do clamp.
 */
function calcularAjuste(input: ScoreInput): number {
  let ajuste = 0;

  const temRating = input.rating !== undefined;
  const temReviewCount = input.reviewCount !== undefined;

  // Bonificação por rating alto + reviews suficientes
  if (temRating && temReviewCount && input.rating >= 4.5 && input.reviewCount >= 20) {
    ajuste += 10;
  } else if (temRating && input.rating >= 4.0) {
    // Bonificação por rating bom, mesmo que reviews < 20
    ajuste += 5;
  }

  // Penalidade por poucos reviews (descredibilidade)
  if (temReviewCount && input.reviewCount < 5) {
    ajuste -= 10;
  }

  return ajuste;
}

/**
 * Score inicial: antes de análise do site.
 *
 * Base:
 * - Sem site (hasWebsite === false) → 90 (prospect "quente" por ausência de concorrência digital)
 * - Com site (hasWebsite === true) → 30 (score neutro/provisório, até `scoreFinal`)
 *
 * Depois: aplicar ajuste de rating/reviews e clampear a 0-100.
 *
 * @param input Dados mínimos do prospect.
 * @returns Score (0-100) e rótulo ("quente" | "oportunidade" | "baixa").
 */
export function scoreInitial(input: ScoreInput): ScoreResult {
  const base = input.hasWebsite ? 30 : 90;
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
 * - Inalcançável (reachable === false) → 85 (oportunidade: sem concorrência online)
 * - Alcançável, mas não-responsivo ou lento:
 *   - mobileResponsive === false OU loadTimeMs > 3000 → 55
 *   - (Nota: undefined mobileResponsive é tratado como false/"não comprovado")
 * - Alcançável, responsivo (true), rápido (<= 3000ms) → 20 (já está bem, pouco margem)
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
    base = 85;
  } else {
    // Site alcançável: avaliar responsividade + performance
    // Nota: undefined mobileResponsive é tratado como "não comprovado" = false
    const ehResponsivo = siteAnalysis.mobileResponsive === true;
    const temCarregamentoRapido = (siteAnalysis.loadTimeMs ?? Infinity) <= 3000;

    if (ehResponsivo && temCarregamentoRapido) {
      // Site bom: pouco margem de melhoria
      base = 20;
    } else {
      // Site ruim (não-responsivo OU lento): oportunidade clara
      base = 55;
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
