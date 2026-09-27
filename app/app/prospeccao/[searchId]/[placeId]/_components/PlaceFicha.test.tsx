/**
 * Smoke test da ficha por empresa (T15) — os seis blocos aparecem, estado
 * "ainda não consultado" pra etapa que não rodou, "não encontrado" + motivo
 * pra etapa que rodou sem achar nada, e o Realtime aplicado via
 * `applyFichaUpdate` (função pura, mesmo padrão de `applyPlaceUpdate`).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: vi.fn() }));

import { PlaceFicha, applyFichaUpdate } from "./PlaceFicha";
import type { PlaceFichaDTO } from "../page";

function place(overrides: Partial<PlaceFichaDTO> = {}): PlaceFichaDTO {
  return {
    id: "p1",
    searchId: "s1",
    placeId: "gp1",
    name: "Clínica OSPE",
    address: "Av. Paulista, 1000",
    phoneNumber: "+5511988887777",
    phoneNumberNormalized: "+5511988887777",
    websiteUrl: null,
    rating: 4.8,
    reviewCount: 30,
    scoreInitial: 60,
    scoreFinal: null,
    statusLabel: "oportunidade",
    siteAnalysisStatus: "not_applicable",
    siteAnalysisResult: null,
    email: null,
    requisitosOk: true,
    motivoRequisitos: null,
    cnpjStatus: "pending",
    cnpjData: null,
    cnpjConsultadoEm: null,
    instagramStatus: "not_applicable",
    instagramData: null,
    instagramConsultadoEm: null,
    promotedLeadId: null,
    lat: null,
    lng: null,
    googleMapsUrl: null,
    oportunidadePitchStatus: "not_applicable",
    justificativaOportunidade: null,
    abordagemInstagram: null,
    oportunidadePitchGeradoEm: null,
    ...overrides,
  };
}

describe("PlaceFicha", () => {
  it("renderiza os 6 blocos", () => {
    render(<PlaceFicha initialPlace={place()} />);
    expect(screen.getByTestId("ficha-bloco-google")).toBeInTheDocument();
    expect(screen.getByTestId("ficha-bloco-instagram")).toBeInTheDocument();
    expect(screen.getByTestId("ficha-bloco-site")).toBeInTheDocument();
    expect(screen.getByTestId("ficha-bloco-receita")).toBeInTheDocument();
    expect(screen.getByTestId("ficha-bloco-contato")).toBeInTheDocument();
    expect(screen.getByTestId("ficha-bloco-venda")).toBeInTheDocument();
  });

  it("etapa que não rodou (pending) mostra 'ainda não consultado', nunca um erro", () => {
    render(<PlaceFicha initialPlace={place({ cnpjStatus: "pending" })} />);
    expect(screen.getByTestId("ficha-bloco-receita")).toHaveTextContent("Ainda não consultado");
    expect(screen.getByTestId("ficha-bloco-receita")).not.toHaveTextContent("Não foi possível");
  });

  it("etapa done sem achado mostra 'não encontrado' + motivo, distinto de 'não consultado'", () => {
    render(
      <PlaceFicha
        initialPlace={place({ cnpjStatus: "done", cnpjData: { motivo: "nenhum CNPJ encontrado na pesquisa" } })}
      />,
    );
    const bloco = screen.getByTestId("ficha-bloco-receita");
    expect(bloco).toHaveTextContent("Não encontrado.");
    expect(bloco).toHaveTextContent("nenhum CNPJ encontrado na pesquisa");
    expect(bloco).not.toHaveTextContent("Ainda não consultado");
  });

  it("etapa done com achado mostra os dados (Receita)", () => {
    render(
      <PlaceFicha
        initialPlace={place({
          cnpjStatus: "done",
          cnpjData: { razaoSocial: "Clínica Exemplo Ltda", socioAdministrador: "Marta Souza", abertura: "2010-05-01", porte: "DEMAIS" },
        })}
      />,
    );
    const bloco = screen.getByTestId("ficha-bloco-receita");
    expect(bloco).toHaveTextContent("Clínica Exemplo Ltda");
    expect(bloco).toHaveTextContent("Marta Souza");
  });

  it("Instagram not_applicable explica o motivo (peso zero ou sem token), sem erro", () => {
    render(<PlaceFicha initialPlace={place({ instagramStatus: "not_applicable" })} />);
    expect(screen.getByTestId("ficha-bloco-instagram")).toHaveTextContent(/não pede este dado|Apify/);
  });

  it("fora do perfil do nicho aparece no bloco Google e no bloco Venda", () => {
    render(<PlaceFicha initialPlace={place({ requisitosOk: false, motivoRequisitos: "3 avaliações (mínimo 10)" })} />);
    expect(screen.getByTestId("ficha-fora-do-perfil")).toHaveTextContent("3 avaliações (mínimo 10)");
    expect(screen.getByTestId("ficha-bloco-venda")).toHaveTextContent("Fora do perfil");
  });

  it("site sem website_url mostra estado vazio específico, sem status_analysis nenhum", () => {
    render(<PlaceFicha initialPlace={place({ websiteUrl: null })} />);
    expect(screen.getByTestId("ficha-bloco-site")).toHaveTextContent("Sem site divulgado no Maps.");
  });
});

describe("applyFichaUpdate — Realtime", () => {
  it("aplica um UPDATE de conclusão do worker de CNPJ sem tocar outros campos", () => {
    const atual = place({ cnpjStatus: "pending" });
    const atualizado = applyFichaUpdate(atual, {
      cnpj_status: "done",
      cnpj_data: { razaoSocial: "X" },
      cnpj_consultado_em: "2026-09-24T00:00:00.000Z",
    });
    expect(atualizado.cnpjStatus).toBe("done");
    expect(atualizado.cnpjData).toEqual({ razaoSocial: "X" });
    expect(atualizado.name).toBe(atual.name); // resto preservado
  });

  it("ignora chaves desconhecidas do payload", () => {
    const atual = place();
    const atualizado = applyFichaUpdate(atual, { alguma_coluna_nova: "x" });
    expect(atualizado).toEqual(atual);
  });
});
