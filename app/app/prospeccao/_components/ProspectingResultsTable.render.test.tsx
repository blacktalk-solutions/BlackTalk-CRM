/**
 * T14 (`.specs/features/prospeccao-nichos-e-enriquecimento/`) — filtro
 * "reprovado nos requisitos": esconde por padrão, chip mostra o total e
 * revela sob pedido. Renderização real (não só a função pura de
 * `applyPlaceUpdate`, já coberta em `ProspectingResultsTable.test.ts`).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: vi.fn() }));

import { ProspectingResultsTable } from "./ProspectingResultsTable";
import type { ProspectedPlaceDTO } from "@/app/api/v1/prospecting/searches/route";

function place(overrides: Partial<ProspectedPlaceDTO>): ProspectedPlaceDTO {
  return {
    id: "p1",
    searchId: "s1",
    placeId: "gp1",
    name: "Empresa",
    address: null,
    phoneNumber: null,
    phoneNumberNormalized: null,
    websiteUrl: null,
    rating: null,
    reviewCount: null,
    scoreInitial: 50,
    scoreFinal: null,
    statusLabel: "oportunidade",
    siteAnalysisStatus: "not_applicable",
    siteAnalysisResult: null,
    email: null,
    promotedLeadId: null,
    promotedAt: null,
    requisitosOk: true,
    motivoRequisitos: null,
    ...overrides,
  };
}

describe("ProspectingResultsTable — filtro de reprovado nos requisitos", () => {
  it("esconde reprovados por padrão e mostra a linha aprovada", () => {
    const places = [
      place({ id: "aprovado", name: "Aprovado", requisitosOk: true }),
      place({ id: "reprovado", name: "Reprovado", requisitosOk: false, motivoRequisitos: "3 avaliações (mínimo 10)" }),
    ];
    render(<ProspectingResultsTable searchId="s1" initialPlaces={places} placesApiCapped={false} />);

    expect(screen.getByText("Aprovado")).toBeInTheDocument();
    expect(screen.queryByText("Reprovado")).not.toBeInTheDocument();
    expect(screen.getByTestId("prospeccao-toggle-reprovados")).toHaveTextContent("1");
  });

  it("o chip revela os reprovados ao clicar", async () => {
    const user = userEvent.setup();
    const places = [
      place({ id: "aprovado", name: "Aprovado", requisitosOk: true }),
      place({ id: "reprovado", name: "Reprovado", requisitosOk: false }),
    ];
    render(<ProspectingResultsTable searchId="s1" initialPlaces={places} placesApiCapped={false} />);

    await user.click(screen.getByTestId("prospeccao-toggle-reprovados"));

    expect(screen.getByText("Reprovado")).toBeInTheDocument();
    expect(screen.getByTestId("prospeccao-fora-do-perfil")).toBeInTheDocument();
  });

  it("sem nenhum reprovado, o chip nem aparece", () => {
    const places = [place({ id: "a", name: "A", requisitosOk: true })];
    render(<ProspectingResultsTable searchId="s1" initialPlaces={places} placesApiCapped={false} />);
    expect(screen.queryByTestId("prospeccao-toggle-reprovados")).not.toBeInTheDocument();
  });

  it("todos reprovados: estado vazio orienta a mostrar mesmo assim", async () => {
    const user = userEvent.setup();
    const places = [place({ id: "r1", name: "Só reprovado", requisitosOk: false })];
    render(<ProspectingResultsTable searchId="s1" initialPlaces={places} placesApiCapped={false} />);

    expect(screen.getByText(/reprovaram nos requisitos do nicho/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mostrar mesmo assim" }));
    expect(screen.getByText("Só reprovado")).toBeInTheDocument();
  });
});
