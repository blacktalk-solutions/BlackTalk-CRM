/**
 * Score de perspectiva de Google Maps, ponderado por nicho.
 *
 * Fórmula pura, sem I/O, sem dependência de banco/rede. Calcula score inicial
 * (antes de site analysis) e score final (com dados de análise do site).
 *
 * Estilos e princípios: a fórmula é auditável, cada parcela documentada, sem
 * chamadas de modelo — o "porquê" é derivado do cálculo, não gerado ao lado.
 *
 * T3 (`.specs/features/prospeccao-nichos-e-enriquecimento/`): as constantes
 * fixas viraram parâmetros — `scoreInitial`/`scoreFinal` agora recebem os
 * `weights` do nicho da busca (ver `NicheWeights`, migration 0236). Ver a nota
 * em `scaleBySignal` para a regra de escala e por que ela é uma decisão de
 * implementação (design.md não fixa a fórmula exata, só exige que pesos
 * diferentes mudem o resultado — critério "Done when" de T3).
 */

/**
 * Status/rótulo do prospect, derivado do score final.
 *
 * - "quente": score >= 70, alta probabilidade de conversão
 * - "oportunidade": 40 <= score < 70, conversão possível
 * - "baixa": score < 40, baixa prioridade
 *
 * Limites fixos, não parametrizados pelo nicho (mesmo critério antes e depois
 * de T3 — só a fórmula que produz o número mudou).
 */
export type StatusLabel = "quente" | "oportunidade" | "baixa";

/**
 * Pesos por sinal de um nicho de prospecção — `prospecting_niches.weights`
 * (migration 0236). Soma 100, validada na ESCRITA do nicho (T7), não aqui.
 *
 * Hoje (T3) só `site` e `reputacao` têm fórmula que os usa — os outros 7
 * campos existem no tipo porque a UI de nicho (T13) e a validação de soma
 * (T7) precisam deles desde já, mas cada sinal só passa a influenciar o score
 * quando a task que o implementa chega (`instagram`/`cnpj` em T9/T10,
 * `whatsapp`/`email`/`telefone`/`endereco`/`linkedin` não têm task de score
 * própria nesta feature — continuam version 0 na fórmula, sinal exposto no
 * nicho mas ainda não pontuado).
 */
export interface NicheWeights {
  site: number;
  instagram: number;
  whatsapp: number;
  email: number;
  telefone: number;
  reputacao: number;
  cnpj: number;
  endereco: number;
  linkedin: number;
}

/**
 * Pesos padrão — mesmo `PESOS_PADRAO` do `prospeccao-kit-aluno` (`lib/score.mjs`),
 * validado por semanas de uso real antes desta feature (design.md, "Tech
 * Decisions"). Soma 100.
 *
 * Duplo uso (0239): sugestão inicial no wizard de criação de nicho, e o
 * peso de fato aplicado numa busca SEM nicho escolhido (nicho virou
 * opcional — ver `searches/route.ts`). Um só lugar pra não os dois se
 * desalinharem com o tempo.
 */
export const PESOS_PADRAO: NicheWeights = {
  site: 25,
  instagram: 15,
  email: 15,
  telefone: 10,
  whatsapp: 10,
  reputacao: 10,
  cnpj: 5,
  linkedin: 5,
  endereco: 5,
};

/**
 * Requisitos de um nicho — `prospecting_niches.requirements` (migration 0236).
 * O que ELIMINA (via `checkRequirements`), diferente de `weights`, que só
 * ordena quem sobrou. Mesma distinção do `prospeccao-kit-aluno`
 * (`lib/requisitos.mjs`).
 */
export interface NicheRequirements {
  avaliacoesMin?: number;
  avaliacoesMax?: number;
  exigeCelular?: boolean;
  exigeSite?: boolean;
}

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
 * Escala um valor da fórmula original (calibrada quando site+reputação eram
 * os ÚNICOS sinais, feature 0234) pelo peso que o nicho da busca atribui a
 * esse sinal.
 *
 * Regra: `peso 100` reproduz exatamente o número de antes de T3 (nicho que
 * dedica o orçamento inteiro a este sinal); `peso 0` zera a contribuição.
 * Linear entre os dois. Como `NicheWeights` soma 100 ENTRE os 9 sinais (não
 * 100 em cada), um nicho real com `site: 25` (mesmo default do
 * `prospeccao-kit-aluno`) produz uma base bem menor que 90/30 — o score
 * inicial fica proporcionalmente mais baixo até `instagram`/`cnpj` chegarem
 * (T9/T10) e `scoreFinal` ser chamado de novo com a soma desses pesos
 * também contribuindo (arquitetura descrita em design.md: "chamada de novo
 * depois que CNPJ/Instagram terminam"). `design.md` não fixa a fórmula exata
 * de escala — só exige que pesos diferentes mudam o resultado (T3, "Done
 * when") — esta função é a decisão de implementação que fecha essa lacuna.
 */
function scaleBySignal(base: number, weight: number): number {
  return base * (weight / 100);
}

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
 * Calcula ajuste de rating/reviews, escalado pelo peso de `reputacao` do
 * nicho (mesmo racional de `scaleBySignal`: peso 100 reproduz o ajuste
 * original de antes de T3).
 *
 * Regras (antes da escala):
 * - +SCORE_AJUSTE_BONUS_ALTO (10) se rating >= RATING_LIMITE_BONUS_ALTO (4.5) && reviewCount >= REVIEW_COUNT_PARA_BONUS_ALTO (20)
 * - senão +SCORE_AJUSTE_BONUS_MEDIO (5) se rating >= RATING_LIMITE_BONUS_MEDIO (4.0)
 * - -SCORE_AJUSTE_PENALIDADE_POUCOS_REVIEWS (10) se reviewCount !== undefined && reviewCount < REVIEW_COUNT_LIMITE_PENALIDADE (5)
 * - ausência de rating/reviewCount → nenhum ajuste
 *
 * A devolução é aditiva: somas antes do clamp.
 */
function calcularAjuste(input: ScoreInput, reputacaoWeight: number): number {
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
    ajuste += scaleBySignal(SCORE_AJUSTE_BONUS_ALTO, reputacaoWeight);
  } else if (rating !== undefined && rating >= RATING_LIMITE_BONUS_MEDIO) {
    // Bonificação por rating bom, mesmo que reviews < 20
    ajuste += scaleBySignal(SCORE_AJUSTE_BONUS_MEDIO, reputacaoWeight);
  }

  // Penalidade por poucos reviews (descredibilidade)
  if (reviewCount !== undefined && reviewCount < REVIEW_COUNT_LIMITE_PENALIDADE) {
    ajuste += scaleBySignal(SCORE_AJUSTE_PENALIDADE_POUCOS_REVIEWS, reputacaoWeight);
  }

  return ajuste;
}

/**
 * Score inicial: antes de análise do site.
 *
 * Base (antes da escala por `weights.site`, ver `scaleBySignal`):
 * - Sem site (hasWebsite === false) → SCORE_BASE_SEM_SITE (90, "prospect quente" por ausência de concorrência digital)
 * - Com site (hasWebsite === true) → SCORE_BASE_COM_SITE (30, score neutro/provisório até `scoreFinal`)
 *
 * Depois: aplicar ajuste de rating/reviews (escalado por `weights.reputacao`)
 * e clampear a 0-100. Arredondado para inteiro — `score_initial` é `integer`
 * no banco (migration 0234).
 *
 * @param input Dados mínimos do prospect.
 * @param weights Pesos do nicho da busca (migration 0236) — `site` e
 *   `reputacao` são os únicos usados por esta fórmula hoje.
 * @returns Score (0-100) e rótulo ("quente" | "oportunidade" | "baixa").
 */
export function scoreInitial(input: ScoreInput, weights: NicheWeights): ScoreResult {
  const baseOriginal = input.hasWebsite ? SCORE_BASE_COM_SITE : SCORE_BASE_SEM_SITE;
  const base = scaleBySignal(baseOriginal, weights.site);
  const ajuste = calcularAjuste(input, weights.reputacao);
  const bruto = Math.round(base + ajuste);
  const score = Math.max(0, Math.min(100, bruto));

  return {
    score,
    label: labelFromScore(score),
  };
}

/**
 * Score final: com análise do site.
 *
 * Base (antes da escala por `weights.site`, determinada pela análise do site):
 * - Inalcançável (reachable === false) → SCORE_BASE_INALCANCAVEL (85, oportunidade: sem concorrência online)
 * - Alcançável, mas não-responsivo ou lento:
 *   - mobileResponsive === false OU loadTimeMs > LOAD_TIME_LIMITE_MS (3000) → SCORE_BASE_LENTO_OU_NAO_RESPONSIVO (55)
 *   - (Nota: undefined mobileResponsive é tratado como false/"não comprovado")
 * - Alcançável, responsivo (true), rápido (<= LOAD_TIME_LIMITE_MS) → SCORE_BASE_BOM (20, já está bem, pouco margem)
 *
 * Depois: aplicar ajuste de rating/reviews (escalado por `weights.reputacao`)
 * e clampear a 0-100. Arredondado para inteiro.
 *
 * Pensada para ser chamada mais de uma vez por resultado, à medida que mais
 * enriquecimento chega (T9/T10 recalculam com os pesos de CNPJ/Instagram
 * quando esses dados existirem — fora do escopo desta função enquanto essas
 * tasks não estendem a assinatura).
 *
 * @param input Dados do prospect + análise do site.
 * @param weights Pesos do nicho da busca.
 * @returns Score (0-100) e rótulo.
 */
export function scoreFinal(
  input: ScoreInput & { siteAnalysis: SiteAnalysisInput },
  weights: NicheWeights,
): ScoreResult {
  const { siteAnalysis } = input;

  // Determinar base de acordo com análise do site
  let baseOriginal: number;

  if (!siteAnalysis.reachable) {
    // Site inalcançável: boa oportunidade
    baseOriginal = SCORE_BASE_INALCANCAVEL;
  } else {
    // Site alcançável: avaliar responsividade + performance
    // Nota: undefined mobileResponsive é tratado como "não comprovado" = false
    const ehResponsivo = siteAnalysis.mobileResponsive === true;
    const temCarregamentoRapido = (siteAnalysis.loadTimeMs ?? Infinity) <= LOAD_TIME_LIMITE_MS;

    if (ehResponsivo && temCarregamentoRapido) {
      // Site bom: pouco margem de melhoria
      baseOriginal = SCORE_BASE_BOM;
    } else {
      // Site ruim (não-responsivo OU lento): oportunidade clara
      baseOriginal = SCORE_BASE_LENTO_OU_NAO_RESPONSIVO;
    }
  }

  const base = scaleBySignal(baseOriginal, weights.site);
  const ajuste = calcularAjuste(input, weights.reputacao);
  const bruto = Math.round(base + ajuste);
  const score = Math.max(0, Math.min(100, bruto));

  return {
    score,
    label: labelFromScore(score),
  };
}

/**
 * Entrada para `checkRequirements` — só o que os quatro requisitos de
 * `NicheRequirements` precisam ler.
 */
export interface CheckRequirementsInput {
  /** Número de avaliações/reviews (Google Maps). */
  reviewCount?: number;
  /** Prospect tem website registrado/detectado (mesmo campo de `ScoreInput`). */
  hasWebsite: boolean;
  /**
   * Melhor telefone conhecido, já em E.164 (`+55...`) — mesmo formato que
   * `normalizePhoneToE164` devolve. `null`/`undefined` quando não há nenhum.
   */
  phoneE164?: string | null;
}

/** Resultado de `checkRequirements`. */
export interface CheckRequirementsResult {
  ok: boolean;
  /** Motivos concatenados (`"; "`) quando `ok === false` — vira `prospected_places.motivo_requisitos`. */
  motivo?: string;
}

/**
 * Celular brasileiro em E.164 (`+55` + DDD + 9 + 8 dígitos). Fixo, 0800, 0300
 * etc. não passam. Mesma regra do `prospeccao-kit-aluno`
 * (`lib/requisitos.mjs`, `ehCelular`), adaptada ao formato COM `+` que
 * `normalizePhoneToE164` usa aqui (o kit guarda sem o `+`).
 */
const CELULAR_BR_E164 = /^\+55[1-9][1-9]9\d{8}$/;

/**
 * O que ELIMINA um resultado do nicho — separado do score, que só ordena
 * quem sobrou (mesma distinção do `prospeccao-kit-aluno`,
 * `lib/requisitos.mjs`, `checarRequisitos`). Sem I/O, sem exceção: ausência
 * de requisito (`{}`) sempre passa.
 *
 * `exigeSite` verifica só a PRESENÇA de site no Maps (`hasWebsite`), não a
 * qualidade/reachability — esta checagem roda na busca (T8), antes do
 * `site-quality-worker` (T11) resolver se o site está de fato no ar.
 *
 * @param input Dados do resultado no momento da busca.
 * @param requirements Requisitos do nicho (`prospecting_niches.requirements`).
 */
export function checkRequirements(
  input: CheckRequirementsInput,
  requirements: NicheRequirements,
): CheckRequirementsResult {
  const motivos: string[] = [];
  const n = input.reviewCount ?? 0;

  if (requirements.avaliacoesMin != null && n < requirements.avaliacoesMin) {
    motivos.push(`${n} avaliações (mínimo ${requirements.avaliacoesMin})`);
  }
  if (requirements.avaliacoesMax != null && n > requirements.avaliacoesMax) {
    motivos.push(`${n} avaliações (máximo ${requirements.avaliacoesMax})`);
  }
  if (requirements.exigeCelular) {
    const celular = input.phoneE164;
    if (!celular || !CELULAR_BR_E164.test(celular)) {
      motivos.push("sem celular (nem no Maps nem no site)");
    }
  }
  if (requirements.exigeSite && !input.hasWebsite) {
    motivos.push("sem site divulgado no Maps");
  }

  return motivos.length === 0 ? { ok: true } : { ok: false, motivo: motivos.join("; ") };
}

/**
 * Recalcula um score já existente incorporando o sinal de Instagram — T10
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`, "Done when":
 * "`score_final` recalculado incorporando o peso de Instagram do nicho da
 * busca").
 *
 * Diferente de `site`/`reputacao` (T3, escalados via `scaleBySignal` a
 * partir de uma constante antiga que já existia antes desta feature),
 * `instagram` não tem constante prévia — é sinal novo. Por isso a regra
 * aqui é a mais simples possível e a mesma do `prospeccao-kit-aluno`
 * (`lib/score.mjs`, `marcar('instagram', ...)`): perfil ENCONTRADO soma
 * `weights.instagram` pontos direto (o peso JÁ É o valor em pontos, não uma
 * fração de 100 a escalar); não encontrado não soma nem subtrai nada — a
 * ausência de Instagram não é penalizada, só não pontua.
 *
 * Recebe o `ScoreResult` JÁ calculado (por `scoreInitial`/`scoreFinal`) em
 * vez de recalcular do zero: é a mesma arquitetura de "chamada de novo
 * conforme mais dado chega" que design.md descreve — o worker de Instagram
 * (T10) lê `score_final ?? score_initial` da linha, soma este sinal, grava
 * de volta. Não duplica a base de site/reputação já computada.
 *
 * @param previous Score atual da linha (`scoreFinal ?? scoreInitial`).
 * @param hasInstagram `true` quando um perfil válido foi confirmado (T10).
 * @param weights Pesos do nicho da busca — só `instagram` é usado aqui.
 */
export function recalculateWithInstagram(
  previous: ScoreResult,
  hasInstagram: boolean,
  weights: NicheWeights,
): ScoreResult {
  if (!hasInstagram) return previous;
  const score = Math.max(0, Math.min(100, previous.score + weights.instagram));
  return { score, label: labelFromScore(score) };
}

/**
 * Fatos conhecidos de cada sinal no momento em que a ficha (T15) monta o
 * bloco "De onde vem a nota" — cada campo já vem derivado de
 * `prospected_places`/`cnpj_data`/`instagram_data` por quem chama
 * `scoreBreakdown`, nunca lido aqui.
 */
export interface ScoreBreakdownInput {
  hasWebsite: boolean;
  /** `undefined` = `site-quality-worker` ainda não rodou (nem sucesso nem falha ainda). */
  siteReachable?: boolean;
  hasInstagram: boolean;
  /** Celular BR válido (o mesmo `CELULAR_BR_E164` de `checkRequirements`), não qualquer telefone. */
  hasWhatsapp: boolean;
  hasEmail: boolean;
  /** Telefone fixo/secundário, distinto do celular de `hasWhatsapp`. */
  hasPhone: boolean;
  rating?: number;
  hasCnpj: boolean;
  hasAddress: boolean;
}

/** Uma linha do "De onde vem a nota" — um sinal, seu peso no nicho, se foi atingido. */
export interface ScoreBreakdownItem {
  sinal: keyof NicheWeights;
  peso: number;
  atingido: boolean;
  /**
   * `true` só para `linkedin`: sinal que `weights` já expõe (T3/T7, "a UI de
   * nicho precisa dele desde já") mas que NENHUM worker desta feature coleta
   * — a ficha usa isto pra mostrar "não coletado" em vez de fingir que
   * verificou e não achou.
   */
  naoColetado?: boolean;
}

/** Mesma ordem de leitura de `NicheWeights` — estável, não alfabética. */
const ORDEM_SINAIS_BREAKDOWN: ReadonlyArray<keyof NicheWeights> = [
  "site",
  "instagram",
  "whatsapp",
  "email",
  "telefone",
  "reputacao",
  "cnpj",
  "endereco",
  "linkedin",
];

/**
 * Reconstrói, pra exibição, quais sinais do nicho a linha atingiu — DIRC
 * "Calcular", não "Duplicar": nada disto é persistido (`prospected_places`
 * não tem um `sinais jsonb` como o `prospeccao-kit-aluno`; a fonte da
 * verdade continua sendo `score_final`/`score_initial`, esta função só
 * explica visualmente de onde eles vieram). Sinais com peso 0 no nicho não
 * entram (nada a explicar sobre um sinal que não pontua).
 *
 * `reputacao` usa o MESMO limiar de bônus médio de `calcularAjuste`
 * (`RATING_LIMITE_BONUS_MEDIO`, 4.0) como proxy de "atingido" — uma
 * simplificação binária da fórmula real (que tem 2 níveis de bônus + 1
 * penalidade), suficiente pra um selo visual "tem/não tem", não pra
 * reproduzir o número exato do ajuste.
 */
export function scoreBreakdown(input: ScoreBreakdownInput, weights: NicheWeights): ScoreBreakdownItem[] {
  const atingidoPorSinal: Record<keyof NicheWeights, boolean> = {
    site: input.hasWebsite && input.siteReachable === true,
    instagram: input.hasInstagram,
    whatsapp: input.hasWhatsapp,
    email: input.hasEmail,
    telefone: input.hasPhone,
    reputacao: input.rating !== undefined && input.rating >= RATING_LIMITE_BONUS_MEDIO,
    cnpj: input.hasCnpj,
    endereco: input.hasAddress,
    linkedin: false,
  };

  return ORDEM_SINAIS_BREAKDOWN.filter((sinal) => weights[sinal] > 0).map((sinal) => ({
    sinal,
    peso: weights[sinal],
    atingido: atingidoPorSinal[sinal],
    ...(sinal === "linkedin" ? { naoColetado: true } : {}),
  }));
}
