import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NichosManager } from "./NichosManager";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";

vi.stubGlobal("fetch", vi.fn());

const NICHE: NicheDTO = {
  id: "niche-1",
  name: "Clínicas odontológicas",
  serviceType: "venda de site",
  searchTerms: ["clínica odontológica"],
  requirements: {},
  weights: { site: 25, instagram: 15, whatsapp: 10, email: 15, telefone: 10, reputacao: 10, cnpj: 5, endereco: 5, linkedin: 5 },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("NichosManager", () => {
  it("sem nichos cadastrados, orienta a criar o primeiro", () => {
    render(<NichosManager initialNiches={[]} apifyTokenConfigured />);
    expect(screen.getByText("Nenhum nicho cadastrado ainda.")).toBeInTheDocument();
  });

  it("lista os nichos existentes, com nome e termos de busca", () => {
    render(<NichosManager initialNiches={[NICHE]} apifyTokenConfigured />);
    expect(screen.getByText("Clínicas odontológicas")).toBeInTheDocument();
    expect(screen.getByText("clínica odontológica")).toBeInTheDocument();
  });

  it("\"Novo nicho\" abre o wizard; \"Cancelar\" volta pra lista", async () => {
    const user = userEvent.setup();
    render(<NichosManager initialNiches={[NICHE]} apifyTokenConfigured />);

    await user.click(screen.getByTestId("niche-novo"));
    expect(screen.getByText("Novo nicho de prospecção")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByTestId("niche-list")).toBeInTheDocument();
  });

  it("\"Editar\" num nicho existente abre o wizard pré-preenchido", async () => {
    const user = userEvent.setup();
    render(<NichosManager initialNiches={[NICHE]} apifyTokenConfigured />);

    await user.click(screen.getByRole("button", { name: /Editar/ }));

    expect(screen.getByText("Editar nicho")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome do nicho")).toHaveValue("Clínicas odontológicas");
  });
});
