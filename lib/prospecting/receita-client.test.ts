import { describe, it, expect, vi } from "vitest";
import { lookupCnpj, cnpjValido, mesmoEndereco, type CnpjData } from "./receita-client";

/** Monta um `Response` fake mínimo — só o que o client lê (`ok`, `status`, `json()`). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CNPJ_VALIDO = "11.444.777/0001-61";
const CNPJ_INVALIDO = "12.345.678/0001-99"; // dígito verificador errado

const BRASIL_API_OK = {
  cnpj: "11444777000161",
  razao_social: "Clinica Exemplo Ltda",
  nome_fantasia: "Clinica Exemplo",
  descricao_situacao_cadastral: "ATIVA",
  data_inicio_atividade: "2010-05-01",
  capital_social: 50000,
  porte: "DEMAIS",
  cnae_fiscal_descricao: "Atividade odontológica",
  cnae_fiscal: 8630501,
  natureza_juridica: "206-2 - Sociedade Empresária Limitada",
  cep: "01310-100",
  municipio: "SAO PAULO",
  uf: "SP",
  ddd_telefone_1: "1130001000",
  email: "contato@exemplo.com",
  qsa: [
    { nome_socio: "Marta Souza", qualificacao_socio: "Sócio-Administrador", data_entrada_sociedade: "2010-05-01", faixa_etaria: "41 a 50" },
  ],
};

describe("cnpjValido", () => {
  it("aceita um CNPJ com dígito verificador correto", () => {
    expect(cnpjValido(CNPJ_VALIDO)).toBe(true);
  });

  it("rejeita um CNPJ com dígito verificador errado", () => {
    expect(cnpjValido(CNPJ_INVALIDO)).toBe(false);
  });

  it("rejeita CNPJ com todos os dígitos iguais", () => {
    expect(cnpjValido("11111111111111")).toBe(false);
  });
});

describe("mesmoEndereco", () => {
  const dados = { cep: "01310100", municipio: "SAO PAULO" } as CnpjData;

  it("bate pelos 5 primeiros dígitos do CEP", () => {
    expect(mesmoEndereco("Av. Paulista, 1000 - 01310-100, São Paulo - SP", dados)).toBe(true);
  });

  it("não bate quando o CEP é de outra região", () => {
    expect(mesmoEndereco("Rua X, 1 - 20000-000, Rio de Janeiro - RJ", dados)).toBe(false);
  });

  it("sem CEP no endereço, cai pro município", () => {
    expect(mesmoEndereco("Av. Paulista, 1000, São Paulo - SP", dados)).toBe(true);
  });
});

describe("lookupCnpj", () => {
  it("CNPJ com dígito verificador inválido é rejeitado sem chamar a rede", async () => {
    const fetchImpl = vi.fn();
    const result = await lookupCnpj(CNPJ_INVALIDO, "qualquer endereço", { fetchImpl });
    expect("motivo" in result).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CEP bate → devolve razão social, sócio-administrador, abertura e porte", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, BRASIL_API_OK));
    const result = await lookupCnpj(CNPJ_VALIDO, "Av. Paulista, 1000 - 01310-100, São Paulo - SP", { fetchImpl });
    expect("motivo" in result).toBe(false);
    const dados = result as CnpjData;
    expect(dados.razaoSocial).toBe("Clinica Exemplo Ltda");
    expect(dados.socioAdministrador).toBe("Marta Souza");
    expect(dados.abertura).toBe("2010-05-01");
    expect(dados.porte).toBe("DEMAIS");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CEP não bate → devolve motivo, não aceita o CNPJ", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, BRASIL_API_OK));
    const result = await lookupCnpj(CNPJ_VALIDO, "Rua X, 1 - 20000-000, Rio de Janeiro - RJ", { fetchImpl });
    expect("motivo" in result).toBe(true);
    expect((result as { motivo: string }).motivo).toContain("não bate");
  });

  it("BrasilAPI 404 é definitivo (CNPJ não existe) — não tenta a reserva", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(404, {}));
    const result = await lookupCnpj(CNPJ_VALIDO, "qualquer endereço", { fetchImpl });
    expect("motivo" in result).toBe(true);
    expect((result as { motivo: string }).motivo).toContain("não encontrado");
    // Mesma semântica do kit (`lib/cnpj.mjs`): 404 da BrasilAPI só cai pra
    // reserva dentro do `catch` (falha de TRANSPORTE) — um 404 limpo é
    // "BrasilAPI confirma que não existe", não "BrasilAPI indisponível".
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("BrasilAPI indisponível (erro de rede) cai pra reserva (cnpj.ws) e aceita se o CEP bater", async () => {
    const cnpjWsBody = {
      razao_social: "Clinica Exemplo Ltda",
      capital_social: 50000,
      porte: { descricao: "DEMAIS" },
      natureza_juridica: { descricao: "Sociedade Empresária Limitada" },
      estabelecimento: {
        cnpj: "11444777000161",
        nome_fantasia: "Clinica Exemplo",
        situacao_cadastral: "ATIVA",
        data_inicio_atividade: "2010-05-01",
        atividade_principal: { id: "8630501", descricao: "Atividade odontológica" },
        cep: "01310-100",
        cidade: { nome: "SAO PAULO" },
        estado: { sigla: "SP" },
      },
      socios: [{ nome: "Marta Souza", qualificacao_socio: { descricao: "Sócio-Administrador" }, data_entrada: "2010-05-01" }],
    };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET")) // BrasilAPI fora do ar
      .mockResolvedValueOnce(fakeResponse(200, cnpjWsBody)); // reserva responde

    const result = await lookupCnpj(CNPJ_VALIDO, "Av. Paulista, 1000 - 01310-100, São Paulo - SP", { fetchImpl });
    expect("motivo" in result).toBe(false);
    expect((result as CnpjData).razaoSocial).toBe("Clinica Exemplo Ltda");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("as duas APIs indisponíveis (erro de rede nas duas) → motivo, não exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await lookupCnpj(CNPJ_VALIDO, "qualquer endereço", { fetchImpl });
    expect("motivo" in result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // tentou BrasilAPI, depois a reserva
  });

  it("erro de rede (fetch rejeita) é tratado sem exception não capturada", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(lookupCnpj(CNPJ_VALIDO, "qualquer endereço", { fetchImpl })).resolves.toHaveProperty("motivo");
  });

  it("cnpj.ws com rate limit (429) não trava esperando — devolve motivo direto", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET")) // BrasilAPI fora do ar, cai pra reserva
      .mockResolvedValueOnce(fakeResponse(429, {})); // reserva com rate limit
    const inicio = Date.now();
    const result = await lookupCnpj(CNPJ_VALIDO, "qualquer endereço", { fetchImpl });
    // Nunca deveria chegar perto de 61s (o `espera(61_000)` do kit, ver nota
    // no topo do arquivo) — a espera de verdade não roda aqui de propósito.
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect("motivo" in result).toBe(true);
  });
});
