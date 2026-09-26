/**
 * Tests for ProspectingResultsTable Realtime update logic (T9).
 *
 * Tests the pure `applyPlaceUpdate` function which handles row updates
 * from Realtime postgres_changes events. The function must preserve
 * array order, handle missing rows gracefully, and map snake_case DB
 * fields to camelCase DTO fields.
 */
import { describe, it, expect } from "vitest";
import { applyPlaceUpdate } from "./ProspectingResultsTable";
import type { ProspectedPlaceDTO } from "@/app/api/v1/prospecting/searches/route";

describe("applyPlaceUpdate", () => {
  const mockPlace = (
    id: string,
    overrides?: Partial<ProspectedPlaceDTO>,
  ): ProspectedPlaceDTO => ({
    id,
    searchId: "search-1",
    placeId: "place-1",
    name: "Test Place",
    address: "123 Main St",
    phoneNumber: "555-1234",
    phoneNumberNormalized: "5551234",
    websiteUrl: "https://example.com",
    rating: 4.5,
    reviewCount: 10,
    scoreInitial: 50,
    scoreFinal: null,
    statusLabel: "baixa",
    siteAnalysisStatus: "pending",
    siteAnalysisResult: null,
    email: null,
    promotedLeadId: null,
    promotedAt: null,
    requisitosOk: true,
    motivoRequisitos: null,
    ...overrides,
  });

  it("deve atualizar a linha correta por id", () => {
    const places = [
      mockPlace("id-1", { name: "Place 1", scoreFinal: null }),
      mockPlace("id-2", { name: "Place 2" }),
      mockPlace("id-3", { name: "Place 3" }),
    ];

    const update = {
      id: "id-2",
      score_final: 75,
      status_label: "quente",
      site_analysis_status: "done",
    };

    const result = applyPlaceUpdate(places, update);

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("id-1");
    expect(result[1]!.id).toBe("id-2");
    expect(result[1]!.scoreFinal).toBe(75);
    expect(result[1]!.statusLabel).toBe("quente");
    expect(result[1]!.siteAnalysisStatus).toBe("done");
    expect(result[1]!.name).toBe("Place 2"); // preserva campos não atualizados
    expect(result[2]!.id).toBe("id-3");
  });

  it("deve preservar ordem das linhas", () => {
    const places = [mockPlace("id-1"), mockPlace("id-2"), mockPlace("id-3")];

    const update = { id: "id-1", score_final: 100 };
    const result = applyPlaceUpdate(places, update);

    expect(result.map((p) => p.id)).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("deve ignorar silenciosamente updates de linhas não encontradas", () => {
    const places = [mockPlace("id-1"), mockPlace("id-2")];
    const update: Record<string, unknown> = { id: "id-99", score_final: 100 };

    const result = applyPlaceUpdate(places, update);

    expect(result).toEqual(places);
  });

  it("deve ignorar updates sem id", () => {
    const places = [mockPlace("id-1")];
    const update: Record<string, unknown> = { score_final: 100 };

    const result = applyPlaceUpdate(places, update);

    expect(result).toEqual(places);
  });

  it("deve mapear campos snake_case do banco para camelCase do DTO", () => {
    const places = [mockPlace("id-1")];

    const update = {
      id: "id-1",
      score_final: 75,
      status_label: "oportunidade",
      site_analysis_status: "done",
      site_analysis_result: { quality: "high" },
      email: "test@example.com",
    };

    const result = applyPlaceUpdate(places, update);
    const updated = result[0]!;

    expect(updated.scoreFinal).toBe(75);
    expect(updated.statusLabel).toBe("oportunidade");
    expect(updated.siteAnalysisStatus).toBe("done");
    expect(updated.siteAnalysisResult).toEqual({ quality: "high" });
    expect(updated.email).toBe("test@example.com");
  });

  it("deve ignorar silenciosamente campos desconhecidos no update", () => {
    const places = [mockPlace("id-1", { name: "Original Name" })];

    const update: Record<string, unknown> = {
      id: "id-1",
      score_final: 75,
      unknown_field: "should be ignored",
      another_field: 123,
    };

    const result = applyPlaceUpdate(places, update);

    expect(result[0]!.scoreFinal).toBe(75);
    expect(result[0]!.name).toBe("Original Name"); // não foi alterado
    expect((result[0] as unknown as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  it("deve devolver novo array (não mutar o original)", () => {
    const places = [mockPlace("id-1")];
    const update: Record<string, unknown> = { id: "id-1", score_final: 100 };

    const result = applyPlaceUpdate(places, update);

    expect(result).not.toBe(places);
    expect(places[0]!.scoreFinal).toBeNull(); // original não foi alterado
  });

  it("deve lidar com múltiplos updates em sequência", () => {
    let places = [
      mockPlace("id-1", { scoreFinal: null }),
      mockPlace("id-2", { scoreFinal: null }),
    ];

    places = applyPlaceUpdate(places, {
      id: "id-1",
      score_final: 50,
      site_analysis_status: "done",
    } as Record<string, unknown>);

    places = applyPlaceUpdate(places, {
      id: "id-2",
      score_final: 75,
      status_label: "quente",
    } as Record<string, unknown>);

    expect(places[0]!.scoreFinal).toBe(50);
    expect(places[1]!.scoreFinal).toBe(75);
    expect(places[1]!.statusLabel).toBe("quente");
  });

  it("deve mapear promoted_lead_id do banco para camelCase do DTO", () => {
    const places = [mockPlace("id-1", { promotedLeadId: null })];

    const update = {
      id: "id-1",
      promoted_lead_id: "lead-123",
    };

    const result = applyPlaceUpdate(places, update);
    const updated = result[0]!;

    expect(updated.promotedLeadId).toBe("lead-123");
  });
});

/**
 * Função pura para determinar se uma linha deve mostrar o botão "Promover"
 * ou o link "No funil". Testável isoladamente.
 */
export function shouldShowPromoteButton(promotedLeadId: string | null): boolean {
  return promotedLeadId === null;
}

describe("shouldShowPromoteButton", () => {
  it("deve retornar true quando promotedLeadId é null", () => {
    expect(shouldShowPromoteButton(null)).toBe(true);
  });

  it("deve retornar false quando promotedLeadId está definido", () => {
    expect(shouldShowPromoteButton("lead-123")).toBe(false);
  });

  it("deve retornar false para string vazia (tratada como promovida)", () => {
    expect(shouldShowPromoteButton("")).toBe(false);
  });
});
