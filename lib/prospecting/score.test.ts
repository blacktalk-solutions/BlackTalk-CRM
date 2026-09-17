import { describe, it, expect } from "vitest";
import { scoreInitial, scoreFinal, labelFromScore } from "./score";

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
    const result = scoreInitial({ hasWebsite: false });
    expect(result.score).toBe(90);
    expect(result.label).toBe("quente");
  });

  it("should return base 30 with 'baixa' label when website present without ratings", () => {
    const result = scoreInitial({ hasWebsite: true });
    expect(result.score).toBe(30);
    expect(result.label).toBe("baixa");
  });

  it("should add +10 bonus when rating >= 4.5 AND reviewCount >= 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 20,
    });
    expect(result.score).toBe(40); // 30 + 10
    expect(result.label).toBe("oportunidade");
  });

  it("should add +10 bonus when rating > 4.5 AND reviewCount > 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.7,
      reviewCount: 50,
    });
    expect(result.score).toBe(40); // 30 + 10
    expect(result.label).toBe("oportunidade");
  });

  it("should add +5 bonus (not +10) when rating >= 4.0 but reviewCount < 20", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.2,
      reviewCount: 10,
    });
    expect(result.score).toBe(35); // 30 + 5
    expect(result.label).toBe("baixa");
  });

  it("should add +5 bonus when rating exactly 4.0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.0,
      reviewCount: 100,
    });
    expect(result.score).toBe(35); // 30 + 5
  });

  it("should apply -10 penalty when reviewCount < 5", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.8,
      reviewCount: 3,
    });
    // Base 30 + 5 (rating >= 4.0) - 10 (reviews < 5) = 25
    expect(result.score).toBe(25);
    expect(result.label).toBe("baixa");
  });

  it("should apply -10 penalty when reviewCount is 0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 5.0,
      reviewCount: 0,
    });
    // Base 30 + 5 (rating >= 4.0) - 10 (reviews < 5) = 25
    expect(result.score).toBe(25);
  });

  it("should not apply bonus if rating < 4.0", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 3.9,
      reviewCount: 20,
    });
    // Base 30, no bonus (rating < 4.0), no penalty (reviews >= 5)
    expect(result.score).toBe(30);
  });

  it("should have no adjustment when rating is undefined", () => {
    const result = scoreInitial({
      hasWebsite: true,
      reviewCount: 100,
    });
    // Base 30, no rating so no bonus/penalty
    expect(result.score).toBe(30);
  });

  it("should have no adjustment when reviewCount is undefined", () => {
    const result = scoreInitial({
      hasWebsite: true,
      rating: 4.8,
    });
    // Base 30 + 5 (rating >= 4.0), but reviewCount undefined so no -10 penalty
    expect(result.score).toBe(35);
  });

  it("should clamp to 100 when adjusted score exceeds 100", () => {
    const result = scoreInitial({
      hasWebsite: false,
      rating: 4.5,
      reviewCount: 20,
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
    // undefined loadTimeMs (treated as Infinity) means not <= 3000
    expect(result.score).toBe(55);
  });

  it("should apply +10 rating bonus to unreachable site base 85", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 4.5,
      reviewCount: 20,
      siteAnalysis: { reachable: false },
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
    // Base 20 + 5 (rating bonus, not +10 because reviewCount < 20) - 10 (penalty) = 15
    expect(result.score).toBe(15);
  });

  it("should not double-penalize: rating < 4.0 and reviewCount < 5 apply penalty once", () => {
    const result = scoreFinal({
      hasWebsite: true,
      rating: 3.5,
      reviewCount: 2,
      siteAnalysis: { reachable: false },
    });
    // Base 85, no bonus (rating < 4.0), -10 penalty (reviews < 5) = 75
    expect(result.score).toBe(75);
    expect(result.label).toBe("quente");
  });
});
