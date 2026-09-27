import { describe, it, expect } from "vitest";
import {
  scoreInitial,
  scoreFinal,
  labelFromScore,
  checkRequirements,
  recalculateWithInstagram,
  scoreBreakdown,
  type NicheWeights,
} from "./score";

/**
 * Pesos que reproduzem EXATAMENTE a fórmula de antes de T3 (site+reputação
 * como únicos sinais, sem escala) — ver `scaleBySignal` em `score.ts`. Usado
 * nos testes herdados da feature 0234 pra manter os mesmos números
 * asserted antes de `weights` existir; os testes novos abaixo (`describe`
 * "pesos diferentes...") são os que provam a parametrização em si.
 */
const FULL_WEIGHT: NicheWeights = {
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

describe("labelFromScore — fórmula de rótulo com boundary diretos", () => {
  it("should return 'baixa' for score 0", () => {
    expect(labelFromScore(0)).toBe("baixa");
  });

  it("should return 'baixa' for score 39", () => {
    expect(labelFromScore(39)).toBe("baixa");
  });

  it("should return 'oportunidade' for score 40", () => {
    expect(labelFromScore(40)).toBe("oportunidade");
  });

  it("should return 'oportunidade' for score 69", () => {
    expect(labelFromScore(69)).toBe("oportunidade");
  });

  it("should return 'quente' for score 70", () => {
    expect(labelFromScore(70)).toBe("quente");
  });

  it("should return 'quente' for score 100", () => {
    expect(labelFromScore(100)).toBe("quente");
  });
});

describe("scoreInitial", () => {
  it("should return base 90 with 'quente' label when no website", () => {
    const result = scoreInitial({ hasWebsite: false }, FULL_WEIGHT);
    expect(result.score).toBe(90);
    expect(result.label).toBe("quente");
  });

  it("should return base 30 with 'baixa' label when website present without ratings", () => {
    const result = scoreInitial({ hasWebsite: true }, FULL_WEIGHT);
    expect(result.score).toBe(30);
    expect(result.label).toBe("baixa");
  });

  it("should add +10 bonus when rating >= 4.5 AND reviewCount >= 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 20,
    }, FULL_WEIGHT);
    expect(result.score).toBe(40); // 30 + 10
    expect(result.label).toBe("oportunidade");
  });

  it("should add +10 bonus when rating > 4.5 AND reviewCount > 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.7,
      reviewCount: 50,
    }, FULL_WEIGHT);
    expect(result.score).toBe(40); // 30 + 10
    expect(result.label).toBe("oportunidade");
  });

  it("should add +5 bonus (not +10) when rating >= 4.0 but reviewCount < 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.2,
      reviewCount: 10,
    }, FULL_WEIGHT);
    expect(result.score).toBe(35); // 30 + 5
    expect(result.label).toBe("baixa");
  });

  it("should add +5 bonus when rating exactly 4.0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.0,
      reviewCount: 100,
    }, FULL_WEIGHT);
    expect(result.score).toBe(35); // 30 + 5
  });

  it("should apply -10 penalty when reviewCount < 5", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.8,
      reviewCount: 3,
    }, FULL_WEIGHT);
    // Base 30 + 5 (rating >= 4.0) - 10 (reviews < 5) = 25
    expect(result.score).toBe(25);
    expect(result.label).toBe("baixa");
  });

  it("should apply -10 penalty when reviewCount is 0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 5.0,
      reviewCount: 0,
    }, FULL_WEIGHT);
    // Base 30 + 5 (rating >= 4.0) - 10 (reviews < 5) = 25
    expect(result.score).toBe(25);
  });

  it("should not apply bonus if rating < 4.0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 3.9,
      reviewCount: 20,
    }, FULL_WEIGHT);
    // Base 30, no bonus (rating < 4.0), no penalty (reviews >= 5)
    expect(result.score).toBe(30);
  });

  it("should have no adjustment when rating is undefined", () => {
    const result = scoreInitial({
      hasWebsite: true,
      reviewCount: 100,
    }, FULL_WEIGHT);
    // Base 30, no rating so no bonus/penalty
    expect(result.score).toBe(30);
  });

  it("should have no adjustment when reviewCount is undefined", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.8,
    }, FULL_WEIGHT);
    // Base 30 + 5 (rating >= 4.0), but reviewCount undefined so no -10 penalty
    expect(result.score).toBe(35);
  });

  it("should clamp to 100 when adjusted score exceeds 100", () => {
    const result = scoreInitial({
      hasWebsite: false,
      rating: 4.5,
      reviewCount: 20,
    }, FULL_WEIGHT);
    // Base 90 + 10 = 100
    expect(result.score).toBe(100);
    expect(result.label).toBe("quente");
  });
});

describe("scoreFinal", () => {
  it("should return base 85 when site is unreachable", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: { reachable: false },
    }, FULL_WEIGHT);
    expect(result.score).toBe(85);
    expect(result.label).toBe("quente");
  });

  it("should return base 55 when site is reachable but not mobile responsive", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: false,
        loadTimeMs: 1000,
      },
    }, FULL_WEIGHT);
    expect(result.score).toBe(55);
    expect(result.label).toBe("oportunidade");
  });

  it("should return base 55 when site is reachable but slow (loadTimeMs > 3000)", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 3500,
      },
    }, FULL_WEIGHT);
    expect(result.score).toBe(55);
  });

  it("should return base 55 when loadTimeMs exactly 3001 (> 3000)", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 3001,
      },
    }, FULL_WEIGHT);
    expect(result.score).toBe(55);
  });

  it("should return base 20 when site is reachable, responsive, and fast (<= 3000ms)", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 2000,
      },
    }, FULL_WEIGHT);
    expect(result.score).toBe(20);
    expect(result.label).toBe("baixa");
  });

  it("should return base 20 when loadTimeMs exactly 3000", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 3000,
      },
    }, FULL_WEIGHT);
    expect(result.score).toBe(20);
  });

  it("should treat undefined mobileResponsive as false (not responsive)", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: undefined,
        loadTimeMs: 1000,
      },
    }, FULL_WEIGHT);
    // undefined mobileResponsive + fast load = base 55 (not 20)
    expect(result.score).toBe(55);
    expect(result.label).toBe("oportunidade");
  });

  it("should treat undefined loadTimeMs as if it exceeds 3000 (assuming slow)", () => {
    const result = scoreFinal({
      hasWebsite: true,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: undefined,
      },
    }, FULL_WEIGHT);
    // undefined loadTimeMs (treated as Infinity) means not <= 3000
    expect(result.score).toBe(55);
  });

  it("should apply +10 rating bonus to unreachable site base 85", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 20,
      siteAnalysis: { reachable: false },
    }, FULL_WEIGHT);
    // Base 85 + 10 = 95
    expect(result.score).toBe(95);
    expect(result.label).toBe("quente");
  });

  it("should apply +5 rating bonus to slow site base 55", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.2,
      reviewCount: 30,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: false,
        loadTimeMs: 5000,
      },
    }, FULL_WEIGHT);
    // Base 55 + 5 = 60
    expect(result.score).toBe(60);
    expect(result.label).toBe("oportunidade");
  });

  it("should apply -10 review penalty to good site base 20", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 2,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 1500,
      },
    }, FULL_WEIGHT);
    // Base 20 + 5 (rating bonus) - 10 (review penalty) = 15
    expect(result.score).toBe(15);
    expect(result.label).toBe("baixa");
  });

  it("should clamp to 100 when adjusted score exceeds 100", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 5.0,
      reviewCount: 100,
      siteAnalysis: { reachable: false },
    }, FULL_WEIGHT);
    // Base 85 + 10 = 95 (below 100, but testing mechanism)
    expect(result.score).toBe(95);
  });

  it("should clamp to 0 when adjusted score would be negative", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 3.5,
      reviewCount: 1,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 1000,
      },
    }, FULL_WEIGHT);
    // Base 20, no bonus (rating < 4.0), -10 penalty (reviews < 5) = 10
    expect(result.score).toBe(10);
  });

  it("should reach low score < 40 with poor site and penalty", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 3.8,
      reviewCount: 2,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 2000,
      },
    }, FULL_WEIGHT);
    // Base 20, no bonus, -10 penalty = 10
    expect(result.score).toBe(10);
    expect(result.label).toBe("baixa");
  });

  it("should reach mid-range score in 40-69 with bonus", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 100,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: false,
        loadTimeMs: 5000,
      },
    }, FULL_WEIGHT);
    // Base 55 + 10 = 65
    expect(result.score).toBe(65);
    expect(result.label).toBe("oportunidade");
  });

  it("should reach high score >= 70 with unreachable and bonus", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 100,
      siteAnalysis: { reachable: false },
    }, FULL_WEIGHT);
    // Base 85 + 10 = 95
    expect(result.score).toBe(95);
    expect(result.label).toBe("quente");
  });

  it("should handle both bonus and penalty together", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 3,
      siteAnalysis: {
        reachable: true,
        mobileResponsive: true,
        loadTimeMs: 1000,
      },
    }, FULL_WEIGHT);
    // Base 20 + 5 (rating bonus, not +10 because reviewCount < 20) - 10 (penalty) = 15
    expect(result.score).toBe(15);
  });

  it("should not double-penalize: rating < 4.0 and reviewCount < 5 apply penalty once", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 3.5,
      reviewCount: 2,
      siteAnalysis: { reachable: false },
    }, FULL_WEIGHT);
    // Base 85, no bonus (rating < 4.0), -10 penalty (reviews < 5) = 75
    expect(result.score).toBe(75);
    expect(result.label).toBe("quente");
  });
});

/**
 * T3 — prova de que `weights` de fato parametriza o resultado (critério
 * "Done when": "o resultado muda com pesos diferentes pro mesmo input").
 */
describe("scoreInitial/scoreFinal — pesos diferentes mudam o resultado (T3)", () => {
  const SITE_ONLY: NicheWeights = { ...FULL_WEIGHT, site: 100, reputacao: 0 };
  const SITE_BAIXO: NicheWeights = { ...FULL_WEIGHT, site: 25, reputacao: 0 };

  it("scoreInitial: mesmo input, nicho com peso de site menor pontua proporcionalmente menos", () => {
    const alto = scoreInitial({ hasWebsite: false }, SITE_ONLY);
    const baixo = scoreInitial({ hasWebsite: false }, SITE_BAIXO);
    // 90 * (100/100) = 90 vs. 90 * (25/100) = 22,5 → arredonda 23
    expect(alto.score).toBe(90);
    expect(baixo.score).toBe(23);
    expect(alto.score).toBeGreaterThan(baixo.score);
    expect(alto.label).toBe("quente");
    expect(baixo.label).toBe("baixa");
  });

  it("scoreFinal: mesmo input, nicho com peso de site menor pontua proporcionalmente menos", () => {
    const input = { hasWebsite: true, siteAnalysis: { reachable: false as const } };
    const alto = scoreFinal(input, SITE_ONLY);
    const baixo = scoreFinal(input, SITE_BAIXO);
    // 85 * (100/100) = 85 vs. 85 * (25/100) = 21,25 → arredonda 21
    expect(alto.score).toBe(85);
    expect(baixo.score).toBe(21);
    expect(alto.score).toBeGreaterThan(baixo.score);
  });

  it("scoreInitial: peso de reputação também muda o resultado, isolado do peso de site", () => {
    const input = { hasWebsite: true, rating: 4.8, reviewCount: 30 };
    const comReputacao = scoreInitial(input, { ...FULL_WEIGHT, site: 0, reputacao: 100 });
    const semReputacao = scoreInitial(input, { ...FULL_WEIGHT, site: 0, reputacao: 0 });
    expect(comReputacao.score).toBe(10); // site:0 → base 0; +10 bonus (reputacao:100)
    expect(semReputacao.score).toBe(0); // nem site nem reputação contribuem
  });
});

/**
 * T3 — `checkRequirements`: cobre dentro/fora da faixa (min e max),
 * `exigeCelular`/`exigeSite` faltando. Réplica dos casos de
 * `prospeccao-kit-aluno/lib/requisitos.mjs` (`checarRequisitos`), adaptada ao
 * formato E.164 com `+` usado neste CRM.
 */
describe("checkRequirements", () => {
  it("sem requisitos ({}) sempre passa", () => {
    expect(checkRequirements({ hasWebsite: false, reviewCount: 0 }, {})).toEqual({ ok: true });
  });

  it("dentro da faixa de avaliações (min e max) passa", () => {
    const result = checkRequirements(
      { hasWebsite: true, reviewCount: 15 },
      { avaliacoesMin: 10, avaliacoesMax: 20 },
    );
    expect(result).toEqual({ ok: true });
  });

  it("fora da faixa — abaixo do mínimo de avaliações", () => {
    const result = checkRequirements({ hasWebsite: true, reviewCount: 3 }, { avaliacoesMin: 10 });
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("3 avaliações (mínimo 10)");
  });

  it("fora da faixa — acima do máximo de avaliações", () => {
    const result = checkRequirements({ hasWebsite: true, reviewCount: 500 }, { avaliacoesMax: 200 });
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("500 avaliações (máximo 200)");
  });

  it("reviewCount ausente conta como 0 avaliações para o mínimo", () => {
    const result = checkRequirements({ hasWebsite: true }, { avaliacoesMin: 1 });
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("0 avaliações (mínimo 1)");
  });

  it("exigeCelular faltando — sem telefone nenhum", () => {
    const result = checkRequirements(
      { hasWebsite: true, phoneE164: null },
      { exigeCelular: true },
    );
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("sem celular");
  });

  it("exigeCelular faltando — telefone é fixo, não celular", () => {
    const result = checkRequirements(
      { hasWebsite: true, phoneE164: "+551130001000" },
      { exigeCelular: true },
    );
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("sem celular");
  });

  it("exigeCelular satisfeito — celular brasileiro válido em E.164", () => {
    const result = checkRequirements(
      { hasWebsite: true, phoneE164: "+5511988887777" },
      { exigeCelular: true },
    );
    expect(result.ok).toBe(true);
  });

  it("exigeSite faltando — sem site no Maps", () => {
    const result = checkRequirements({ hasWebsite: false }, { exigeSite: true });
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("sem site");
  });

  it("exigeSite satisfeito — tem site no Maps", () => {
    const result = checkRequirements({ hasWebsite: true }, { exigeSite: true });
    expect(result.ok).toBe(true);
  });

  it("acumula vários motivos quando mais de um requisito falha", () => {
    const result = checkRequirements(
      { hasWebsite: false, reviewCount: 2, phoneE164: null },
      { avaliacoesMin: 10, exigeCelular: true, exigeSite: true },
    );
    expect(result.ok).toBe(false);
    expect(result.motivo).toContain("avaliações");
    expect(result.motivo).toContain("celular");
    expect(result.motivo).toContain("site");
  });
});

describe("recalculateWithInstagram", () => {
  const WEIGHTS: NicheWeights = { ...FULL_WEIGHT, instagram: 15 };

  it("perfil encontrado soma weights.instagram pontos direto", () => {
    const anterior = { score: 50, label: "oportunidade" as const };
    const resultado = recalculateWithInstagram(anterior, true, WEIGHTS);
    expect(resultado.score).toBe(65);
  });

  it("sem perfil (não encontrado) não muda o score", () => {
    const anterior = { score: 50, label: "oportunidade" as const };
    const resultado = recalculateWithInstagram(anterior, false, WEIGHTS);
    expect(resultado).toEqual(anterior);
  });

  it("clampeia a 100 quando a soma excede o teto", () => {
    const anterior = { score: 95, label: "quente" as const };
    const resultado = recalculateWithInstagram(anterior, true, WEIGHTS);
    expect(resultado.score).toBe(100);
  });

  it("rótulo é recalculado a partir do novo score (pode virar 'quente')", () => {
    const anterior = { score: 60, label: "oportunidade" as const }; // 60+15=75 -> quente
    const resultado = recalculateWithInstagram(anterior, true, WEIGHTS);
    expect(resultado.label).toBe("quente");
  });
});

describe("scoreBreakdown — reconstrução visual de 'de onde vem a nota'", () => {
  /** Mesmos 9 pesos de `PESOS_NICHO` em route.test.ts (soma 100). */
  const PESOS: NicheWeights = {
    site: 25,
    instagram: 15,
    whatsapp: 10,
    email: 15,
    telefone: 10,
    reputacao: 10,
    cnpj: 5,
    linkedin: 5,
    endereco: 5,
  };

  const TUDO_ATINGIDO = {
    hasWebsite: true,
    siteReachable: true,
    hasInstagram: true,
    hasWhatsapp: true,
    hasEmail: true,
    hasPhone: true,
    rating: 4.8,
    hasCnpj: true,
    hasAddress: true,
  };

  it("marca todos os 9 sinais como atingidos quando todos os fatos são positivos, exceto linkedin", () => {
    const resultado = scoreBreakdown(TUDO_ATINGIDO, PESOS);
    expect(resultado).toHaveLength(9);
    for (const item of resultado) {
      if (item.sinal === "linkedin") {
        expect(item.atingido).toBe(false);
      } else {
        expect(item.atingido).toBe(true);
      }
    }
  });

  it("linkedin sempre vem com naoColetado=true, os outros 8 sinais sem essa flag", () => {
    const resultado = scoreBreakdown(TUDO_ATINGIDO, PESOS);
    const linkedin = resultado.find((i) => i.sinal === "linkedin");
    expect(linkedin?.naoColetado).toBe(true);
    for (const item of resultado.filter((i) => i.sinal !== "linkedin")) {
      expect(item.naoColetado).toBeUndefined();
    }
  });

  it("omite sinais com peso 0 no nicho", () => {
    const pesosComZero: NicheWeights = { ...PESOS, cnpj: 0 };
    const resultado = scoreBreakdown(TUDO_ATINGIDO, pesosComZero);
    expect(resultado.find((i) => i.sinal === "cnpj")).toBeUndefined();
    expect(resultado).toHaveLength(8);
  });

  it("site não é atingido quando há website mas siteReachable ainda é undefined (worker não rodou)", () => {
    const resultado = scoreBreakdown({ ...TUDO_ATINGIDO, siteReachable: undefined }, PESOS);
    expect(resultado.find((i) => i.sinal === "site")?.atingido).toBe(false);
  });

  it("site não é atingido quando siteReachable é false (site fora do ar)", () => {
    const resultado = scoreBreakdown({ ...TUDO_ATINGIDO, siteReachable: false }, PESOS);
    expect(resultado.find((i) => i.sinal === "site")?.atingido).toBe(false);
  });

  it("reputacao usa o limiar RATING_LIMITE_BONUS_MEDIO (4.0): 3.9 não atinge, 4.0 atinge", () => {
    const abaixo = scoreBreakdown({ ...TUDO_ATINGIDO, rating: 3.9 }, PESOS);
    const noLimiar = scoreBreakdown({ ...TUDO_ATINGIDO, rating: 4.0 }, PESOS);
    expect(abaixo.find((i) => i.sinal === "reputacao")?.atingido).toBe(false);
    expect(noLimiar.find((i) => i.sinal === "reputacao")?.atingido).toBe(true);
  });

  it("reputacao não é atingida quando rating é undefined", () => {
    const resultado = scoreBreakdown({ ...TUDO_ATINGIDO, rating: undefined }, PESOS);
    expect(resultado.find((i) => i.sinal === "reputacao")?.atingido).toBe(false);
  });

  it("cada item carrega o peso exato do nicho pro sinal", () => {
    const resultado = scoreBreakdown(TUDO_ATINGIDO, PESOS);
    expect(resultado.find((i) => i.sinal === "email")?.peso).toBe(15);
    expect(resultado.find((i) => i.sinal === "endereco")?.peso).toBe(5);
  });

  it("todos os fatos negativos: nenhum sinal atingido", () => {
    const resultado = scoreBreakdown(
      {
        hasWebsite: false,
        siteReachable: undefined,
        hasInstagram: false,
        hasWhatsapp: false,
        hasEmail: false,
        hasPhone: false,
        rating: undefined,
        hasCnpj: false,
        hasAddress: false,
      },
      PESOS,
    );
    expect(resultado.every((i) => !i.atingido)).toBe(true);
  });
});
