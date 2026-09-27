import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "@/lib/env";
import { pesquisarGoogle, buscarComTentativas, ehSiteProprio, PesquisaApifyError } from "./pesquisa-client";

// Mesmo padrão de `places-client.test.ts`/`apify-client.test.ts`.
vi.mock("@/lib/env", () => ({
  env: { APIFY_TOKEN: "test-token" },
}));

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Uma "página" do dataset do Apify — um item por termo pesquisado. */
function apifyPage(term: string, resultados: Array<{ titulo: string; link: string; trecho?: string }>) {
  return {
    searchQuery: { term },
    organicResults: resultados.map((r) => ({ title: r.titulo, url: r.link, description: r.trecho ?? "" })),
  };
}

beforeEach(() => {
  env.APIFY_TOKEN = "test-token";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pesquisarGoogle", () => {
  it("busca em lote: várias queries numa chamada Apify só", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, [
        apifyPage("clinica a belo horizonte", [{ titulo: "Clínica A", link: "https://clinicaa.com.br" }]),
        apifyPage("clinica b belo horizonte", [{ titulo: "Clínica B", link: "https://clinicab.com.br" }]),
      ]),
    );

    const mapa = await pesquisarGoogle(["clinica a belo horizonte", "clinica b belo horizonte"], { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { queries: string };
    expect(body.queries.split("\n")).toHaveLength(2);
    expect(mapa.get("clinica a belo horizonte")).toHaveLength(1);
    expect(mapa.get("clinica b belo horizonte")).toHaveLength(1);
  });

  it("termo que o Apify não devolveu vira lista vazia (não repete a busca)", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, [apifyPage("achou", [{ titulo: "X", link: "https://x.com.br" }])]));
    const mapa = await pesquisarGoogle(["achou", "nao achou"], { fetchImpl });
    expect(mapa.get("nao achou")).toEqual([]);
  });

  it("sem APIFY_TOKEN → PesquisaApifyError missing_api_key, sem chamar a rede", async () => {
    env.APIFY_TOKEN = "";
    const fetchImpl = vi.fn();
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toMatchObject({
      code: "missing_api_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("token inválido (401) → PesquisaApifyError invalid_token, não exception genérica", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, {}));
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toBeInstanceOf(PesquisaApifyError);
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("crédito esgotado (402) → PesquisaApifyError quota_exceeded", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(402, {}));
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("erro de rede/timeout → PesquisaApifyError unknown_error, não exception crua", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toBeInstanceOf(PesquisaApifyError);
    await expect(pesquisarGoogle(["termo"], { fetchImpl })).rejects.toMatchObject({ code: "unknown_error" });
  });
});

describe("buscarComTentativas", () => {
  it("para na primeira tentativa que trouxer resultado (não gasta a 2ª/3ª)", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, [apifyPage("clinica ospe belo horizonte", [{ titulo: "OSPE", link: "https://ospe.com.br" }])]),
    );
    const itens = await buscarComTentativas(["clinica ospe belo horizonte", "clinica ospe site oficial"], { fetchImpl });
    expect(itens).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("3 tentativas com formatos diferentes; não achou na terceira → lista vazia, sem 4ª chamada", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, []));
    const itens = await buscarComTentativas(
      ["tentativa 1", "tentativa 2", "tentativa 3", "tentativa 4 nunca deveria rodar"],
      { fetchImpl },
    );
    expect(itens).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("acha só na 3ª tentativa", async () => {
    let chamada = 0;
    const fetchImpl = vi.fn(async () => {
      chamada++;
      if (chamada < 3) return fakeResponse(200, []);
      return fakeResponse(200, [apifyPage("tentativa 3", [{ titulo: "Achou", link: "https://achou.com.br" }])]);
    });
    const itens = await buscarComTentativas(["tentativa 1", "tentativa 2", "tentativa 3"], { fetchImpl });
    expect(itens).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("ehSiteProprio", () => {
  it("aceita um domínio comercial comum", () => {
    expect(ehSiteProprio("https://clinicaospe.com.br")).toBe(true);
  });

  it("descarta Instagram", () => {
    expect(ehSiteProprio("https://www.instagram.com/clinica.ospe/")).toBe(false);
  });

  it("descarta diretório/marketplace (ex.: doctoralia, ifood)", () => {
    expect(ehSiteProprio("https://www.doctoralia.com.br/clinica-x")).toBe(false);
    expect(ehSiteProprio("https://www.ifood.com.br/delivery/clinica-x")).toBe(false);
  });

  it("link malformado devolve false, não lança", () => {
    expect(ehSiteProprio("não é uma url")).toBe(false);
  });
});
