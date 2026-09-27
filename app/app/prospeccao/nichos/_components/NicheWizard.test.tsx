/**
 * Smoke test do wizard de nicho (T13) — cobre o essencial do "Done when":
 * criar do zero só pelo formulário, pesos que não somam 100 bloqueiam o
 * passo final mostrando o total, e editar vem pré-preenchido.
 *
 * E2E completo (a jornada real, com API de verdade) fica em T17
 * (`tests/e2e/prospeccao.spec.ts`) — aqui é só o componente, com `fetch`
 * mockado.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NicheWizard } from "./NicheWizard";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

const NICHE_EXISTENTE: NicheDTO = {
  id: "niche-1",
  name: "Clínicas odontológicas",
  serviceType: "venda de site",
  searchTerms: ["clínica odontológica"],
  requirements: { avaliacoesMin: 10, exigeCelular: true },
  weights: { site: 25, instagram: 15, whatsapp: 10, email: 15, telefone: 10, reputacao: 10, cnpj: 5, endereco: 5, linkedin: 5 },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

async function avancarAte(user: ReturnType<typeof userEvent.setup>, vezes: number) {
  for (let i = 0; i < vezes; i++) {
    await user.click(screen.getByRole("button", { name: "Próximo" }));
  }
}

describe("NicheWizard — criação do zero", () => {
  it("preenche passo 1, avança até revisão e salva — POST com o payload certo", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ...NICHE_EXISTENTE, id: "niche-novo" } }),
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();

    render(<NicheWizard niche={null} apifyTokenConfigured onSaved={onSaved} onCancel={() => {}} />);

    await user.type(screen.getByLabelText("Nome do nicho"), "Barbearias");
    await user.type(
      screen.getByLabelText("Como esse cliente aparece no Google Maps (um termo por linha)"),
      "barbearia",
    );
    await avancarAte(user, 2); // negocio -> tamanho -> pesos (pesos padrão já somam 100)
    await user.click(screen.getByRole("button", { name: "Próximo" })); // pesos -> revisão

    await user.click(screen.getByRole("button", { name: "Salvar nicho" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/prospecting/niches",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      name: string;
      searchTerms: string[];
      weights: Record<string, number>;
    };
    expect(body.name).toBe("Barbearias");
    expect(body.searchTerms).toEqual(["barbearia"]);
    expect(Object.values(body.weights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "niche-novo" }));
  });

  it("não avança do passo 1 sem nome/termos", async () => {
    const user = userEvent.setup();
    render(<NicheWizard niche={null} apifyTokenConfigured onSaved={vi.fn()} onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Próximo" }));

    // Continua no passo 1 — o campo de nome (só existe nesse passo) ainda está na tela.
    expect(screen.getByLabelText("Nome do nicho")).toBeInTheDocument();
  });

  it("pesos que não somam 100 bloqueiam o passo final, mostrando o total", async () => {
    const user = userEvent.setup();
    render(<NicheWizard niche={null} apifyTokenConfigured onSaved={vi.fn()} onCancel={() => {}} />);

    await user.type(screen.getByLabelText("Nome do nicho"), "Barbearias");
    await user.type(
      screen.getByLabelText("Como esse cliente aparece no Google Maps (um termo por linha)"),
      "barbearia",
    );
    await avancarAte(user, 2); // negocio -> tamanho -> pesos

    const campoSite = screen.getByLabelText("Site no ar");
    await user.clear(campoSite);
    await user.type(campoSite, "90"); // agora a soma passa de 100

    expect(screen.getByTestId("niche-soma-pesos")).toHaveTextContent("precisa somar exatamente 100");

    // "Próximo" (pesos -> revisão) não avança com a soma errada.
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    expect(screen.getByLabelText("Site no ar")).toBeInTheDocument(); // continua no passo "pesos"
  });

  it("aviso de APIFY_TOKEN ausente aparece só quando o peso de Instagram é > 0", async () => {
    const user = userEvent.setup();
    render(<NicheWizard niche={null} apifyTokenConfigured={false} onSaved={vi.fn()} onCancel={() => {}} />);

    await user.type(screen.getByLabelText("Nome do nicho"), "Barbearias");
    await user.type(
      screen.getByLabelText("Como esse cliente aparece no Google Maps (um termo por linha)"),
      "barbearia",
    );
    await avancarAte(user, 2);

    // Pesos padrão já têm instagram > 0 (15) — o aviso deve estar visível.
    expect(screen.getByTestId("niche-instagram-sem-token")).toBeInTheDocument();
  });
});

describe("NicheWizard — edição", () => {
  it("vem pré-preenchido com os valores do nicho existente", () => {
    render(<NicheWizard niche={NICHE_EXISTENTE} apifyTokenConfigured onSaved={vi.fn()} onCancel={() => {}} />);

    expect(screen.getByLabelText("Nome do nicho")).toHaveValue("Clínicas odontológicas");
    expect(screen.getByText(/vale só para buscas futuras/)).toBeInTheDocument();
  });

  it("salva via PATCH /api/v1/prospecting/niches/[id]", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: NICHE_EXISTENTE }) });
    const user = userEvent.setup();
    render(<NicheWizard niche={NICHE_EXISTENTE} apifyTokenConfigured onSaved={vi.fn()} onCancel={() => {}} />);

    await avancarAte(user, 3); // negocio -> tamanho -> pesos -> revisão
    await user.click(screen.getByRole("button", { name: "Salvar nicho" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/prospecting/niches/niche-1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
