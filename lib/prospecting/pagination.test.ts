import { describe, it, expect } from "vitest";
import {
  RESULTS_PAGE_SIZE,
  totalResultPages,
  clampResultPage,
  paginateResults,
} from "./pagination";

describe("RESULTS_PAGE_SIZE", () => {
  it("is 15 (PROSPECT-04: paginação 15/15)", () => {
    expect(RESULTS_PAGE_SIZE).toBe(15);
  });
});

describe("totalResultPages", () => {
  it("returns 1 for an empty list (not 0 — the table exists, just empty)", () => {
    expect(totalResultPages(0)).toBe(1);
  });

  it("returns 1 when every item fits on a single page", () => {
    expect(totalResultPages(15)).toBe(1);
  });

  it("returns 2 when one item spills onto a second page", () => {
    expect(totalResultPages(16)).toBe(2);
  });

  it("returns 4 for the full 60-result Places API cap", () => {
    expect(totalResultPages(60)).toBe(4);
  });

  it("returns 4 for a non-exact multiple of the page size (47 results)", () => {
    expect(totalResultPages(47)).toBe(4);
  });
});

describe("clampResultPage", () => {
  it("never goes below page 1", () => {
    expect(clampResultPage(0, 30)).toBe(1);
    expect(clampResultPage(-5, 30)).toBe(1);
  });

  it("never exceeds the last page", () => {
    expect(clampResultPage(99, 30)).toBe(2); // 30 itens = 2 páginas de 15
  });

  it("passes through a page already within range", () => {
    expect(clampResultPage(2, 60)).toBe(2);
  });

  it("clamps to page 1 for an empty list regardless of the requested page", () => {
    expect(clampResultPage(5, 0)).toBe(1);
  });
});

describe("paginateResults", () => {
  const items = Array.from({ length: 47 }, (_, i) => i + 1);

  it("returns the first 15 on page 1", () => {
    expect(paginateResults(items, 1)).toEqual(items.slice(0, 15));
  });

  it("returns the next 15 on page 2, without touching page 1's items", () => {
    expect(paginateResults(items, 2)).toEqual(items.slice(15, 30));
  });

  it("returns the remainder (2 items) on the last page", () => {
    const ultima = paginateResults(items, 4);
    expect(ultima).toEqual(items.slice(45, 47));
    expect(ultima).toHaveLength(2);
  });

  it("clamps an out-of-range page instead of returning an empty page", () => {
    expect(paginateResults(items, 99)).toEqual(items.slice(45, 47));
  });

  it("returns an empty page for an empty list", () => {
    expect(paginateResults([], 1)).toEqual([]);
  });

  it("respects a custom page size", () => {
    expect(paginateResults(items, 1, 10)).toEqual(items.slice(0, 10));
    expect(paginateResults(items, 5, 10)).toEqual(items.slice(40, 47));
  });
});
