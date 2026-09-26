import { beforeEach, describe, expect, it, vi } from "vitest";

// Mesma ordem/motivo de `tests/unit/prospecting-site-quality-worker.test.ts`:
// `vi.hoisted()` porque o worker testado é importado estaticamente mais
// abaixo, e esse import aciona as factories de `vi.mock` antes de `const`s
// soltos aqui terem rodado.
const { updateSpy, state } = vi.hoisted(() => {
  const updateSpy = vi.fn();
  const state: {
    placeRow: {
      id: string;
      organization_id: string;
      name: string;
      address: string | null;
      cnpj_status: string;
    } | null;
    placeError: { message: string } | null;
    selectThrows: Error | null;
    claimOk: boolean;
    claimError: { message: string } | null;
    finalUpdateError: { message: string } | null;
  } = {
    placeRow: null,
    placeError: null,
    selectThrows: null,
    claimOk: true,
    claimError: null,
    finalUpdateError: null,
  };
  return { updateSpy, state };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "prospected_places") throw new Error(`tabela inesperada no teste: ${table}`);
      return {
        select: (_cols: string) => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (state.selectThrows) throw state.selectThrows;
                return { data: state.placeRow, error: state.placeError };
              },
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateSpy(patch);
          if (patch.cnpj_status === "processing") {
            // claim otimista — 3 .eq() + .select("id")
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    select: async (_cols: string) => ({
                      data: state.claimOk ? [{ id: state.placeRow?.id }] : [],
                      error: state.claimError,
                    }),
                  }),
                }),
              }),
            };
          }
          // gravação final ("done" ou "failed") — 2 .eq(), awaited direto
          return {
            eq: () => ({
              eq: async () => ({ error: state.finalUpdateError }),
            }),
          };
        },
      };
    },
  }),
}));

// Mesmo motivo do `vi.hoisted()` acima: evita TDZ com o import estático do
// worker mais abaixo, que aciona estas factories antes de `const`s soltos.
const { pesquisarGoogleMock, lookupCnpjMock } = vi.hoisted(() => ({
  pesquisarGoogleMock: vi.fn(),
  lookupCnpjMock: vi.fn(),
}));

vi.mock("@/lib/prospecting/pesquisa-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/pesquisa-client")>()),
  pesquisarGoogle: pesquisarGoogleMock,
}));

vi.mock("@/lib/prospecting/receita-client", async (importOriginal) => ({
  // `cnpjValido` continua REAL — é ele quem filtra os candidatos achados por
  // regex antes de gastar uma chamada de `lookupCnpj`; mockar isso também
  // esconderia bug real na extração.
  ...(await importOriginal<typeof import("@/lib/prospecting/receita-client")>()),
  lookupCnpj: lookupCnpjMock,
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { enrichProspectCnpj } from "@/workers/prospecting-cnpj-worker";
import type { CnpjData } from "@/lib/prospecting/receita-client";

/** CNPJ real (dígito verificador válido) usado nos textos de busca fake. */
const CNPJ_VALIDO_FMT = "11.444.777/0001-61";
const CNPJ_INVALIDO_FMT = "12.345.678/0001-99"; // dígito verificador errado — regex casa, cnpjValido rejeita

const DADOS_CNPJ: CnpjData = {
  cnpj: CNPJ_VALIDO_FMT,
  razaoSocial: "Clinica Exemplo Ltda",
  nomeFantasia: null,
  situacao: "ATIVA",
  abertura: "2010-05-01",
  capitalSocial: null,
  porte: "DEMAIS",
  atividade: null,
  cnae: null,
  naturezaJuridica: null,
  cep: "01310100",
  municipio: "SAO PAULO",
  uf: "SP",
  telefones: [],
  email: null,
  socios: [],
  socioAdministrador: "Marta Souza",
};

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    event_type: "prospected_place.cnpj_requested",
    entity_kind: "prospected_place",
    entity_id: "place-1",
    organization_id: "org-1",
    payload: { prospected_place_id: "place-1", search_id: "search-1", place_id: "gp-1" },
    metadata: {},
    created_at: "2026-09-24T00:00:00.000Z",
    ...overrides,
  } as EventRow;
}

/**
 * Resolve `pesquisarGoogle([termo])` devolvendo os `items` sob a chave DO
 * PRÓPRIO termo recebido (não um valor fixo) — o worker sempre chama com 1
 * termo por vez e lê de volta pela mesma chave, então o dublê tem que ecoar
 * o termo real, não um placeholder que nunca bate.
 */
function comResultados(items: Array<{ titulo: string; link: string; trecho?: string }>) {
  return async (termos: string[]) =>
    new Map([[termos[0] as string, items.map((i) => ({ titulo: i.titulo, link: i.link, trecho: i.trecho ?? "" }))]]);
}

const semResultados = async (termos: string[]) => new Map([[termos[0] as string, []]]);

beforeEach(() => {
  vi.clearAllMocks();
  state.placeRow = {
    id: "place-1",
    organization_id: "org-1",
    name: "Clínica OSPE",
    address: "Av. Paulista, 1000 - 01310-100, São Paulo - SP",
    cnpj_status: "pending",
  };
  state.placeError = null;
  state.selectThrows = null;
  state.claimOk = true;
  state.claimError = null;
  state.finalUpdateError = null;
});

describe("enrichProspectCnpj", () => {
  it("achado na 1ª tentativa → grava e sai, sem gastar a 2ª/3ª pesquisa", async () => {
    pesquisarGoogleMock.mockImplementationOnce(
      comResultados([{ titulo: "Clínica OSPE", link: "https://exemplo.com", trecho: `CNPJ ${CNPJ_VALIDO_FMT}` }]),
    );
    lookupCnpjMock.mockResolvedValueOnce(DADOS_CNPJ);

    const result = await enrichProspectCnpj(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_cnpj_v1", status: "ok" });
    expect(pesquisarGoogleMock).toHaveBeenCalledTimes(1);
    expect(lookupCnpjMock).toHaveBeenCalledTimes(1);
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.cnpj_status === "done")?.[0];
    expect(finalPatch.cnpj_data).toEqual(DADOS_CNPJ);
  });

  it("não achado na 1ª tentativa → cai pra 2ª, acha lá", async () => {
    pesquisarGoogleMock.mockImplementationOnce(semResultados); // 1ª: sem resultado nenhum
    pesquisarGoogleMock.mockImplementationOnce(
      comResultados([{ titulo: "OSPE", link: "https://x.com", trecho: CNPJ_VALIDO_FMT }]),
    );
    lookupCnpjMock.mockResolvedValueOnce(DADOS_CNPJ);

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("ok");
    expect(pesquisarGoogleMock).toHaveBeenCalledTimes(2);
  });

  it("candidato com dígito verificador inválido é descartado sem chamar a Receita", async () => {
    pesquisarGoogleMock.mockImplementationOnce(
      comResultados([{ titulo: "OSPE", link: "https://x.com", trecho: CNPJ_INVALIDO_FMT }]),
    );
    pesquisarGoogleMock.mockImplementationOnce(semResultados);
    pesquisarGoogleMock.mockImplementationOnce(semResultados);

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("ok");
    expect(lookupCnpjMock).not.toHaveBeenCalled();
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.cnpj_status === "done")?.[0];
    expect(finalPatch.cnpj_data).toEqual({ motivo: expect.any(String) });
  });

  it("candidato não bate o CEP → tenta o próximo candidato/tentativa antes de desistir", async () => {
    pesquisarGoogleMock.mockImplementationOnce(
      comResultados([{ titulo: "Homônima", link: "https://x.com", trecho: CNPJ_VALIDO_FMT }]),
    );
    lookupCnpjMock.mockResolvedValueOnce({ motivo: "CEP não bate" }); // 1º candidato descartado
    pesquisarGoogleMock.mockImplementationOnce(semResultados);
    pesquisarGoogleMock.mockImplementationOnce(semResultados);

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("ok");
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.cnpj_status === "done")?.[0];
    expect(finalPatch.cnpj_data).toEqual({ motivo: expect.any(String) });
  });

  it("nenhum candidato bate em nenhuma das 3 tentativas → cnpj_status='done', cnpj_data=null (NÃO é 'failed')", async () => {
    pesquisarGoogleMock.mockImplementation(semResultados);

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("ok");
    expect(pesquisarGoogleMock).toHaveBeenCalledTimes(3);
    const patches = updateSpy.mock.calls.map(([p]) => p);
    expect(patches).not.toContainEqual(expect.objectContaining({ cnpj_status: "failed" }));
    const finalPatch = patches.find((p) => p.cnpj_status === "done");
    expect(finalPatch.cnpj_data).toEqual({ motivo: expect.any(String) });
  });

  it("erro de rede na pesquisa → cnpj_status='failed', não derruba o worker (devolve status ok)", async () => {
    pesquisarGoogleMock.mockRejectedValue(new Error("ETIMEDOUT"));

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("ok"); // evento consumido, sem retry automático
    expect(updateSpy).toHaveBeenCalledWith({ cnpj_status: "failed" });
  });

  it("gravação de 'failed' também falha → devolve status error (deixa o drain reagendar)", async () => {
    pesquisarGoogleMock.mockRejectedValue(new Error("ETIMEDOUT"));
    state.finalUpdateError = { message: "db fora do ar" };

    const result = await enrichProspectCnpj(eventRow());

    expect(result.status).toBe("error");
  });

  it("já cnpj_status='done' → skipped, sem pesquisar de novo", async () => {
    state.placeRow!.cnpj_status = "done";
    const result = await enrichProspectCnpj(eventRow());
    expect(result).toEqual({ consumer_key: "prospecting_cnpj_v1", status: "skipped", detail: "already done" });
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
  });

  it("já cnpj_status='processing' → skipped", async () => {
    state.placeRow!.cnpj_status = "processing";
    const result = await enrichProspectCnpj(eventRow());
    expect(result.status).toBe("skipped");
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
  });

  it("claim concorrente perdido → no-op, nunca chama a pesquisa", async () => {
    state.claimOk = false;
    const result = await enrichProspectCnpj(eventRow());
    expect(result).toEqual({
      consumer_key: "prospecting_cnpj_v1",
      status: "skipped",
      detail: "concurrent claim lost",
    });
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
  });

  it("prospected_place não encontrado → skipped", async () => {
    state.placeRow = null;
    const result = await enrichProspectCnpj(eventRow());
    expect(result.status).toBe("skipped");
  });

  it("sem prospected_place_id no evento → skipped, nem consulta o banco", async () => {
    const result = await enrichProspectCnpj(eventRow({ payload: {}, entity_id: null as unknown as string }));
    expect(result).toEqual({ consumer_key: "prospecting_cnpj_v1", status: "skipped", detail: "no prospected_place_id" });
  });
});
