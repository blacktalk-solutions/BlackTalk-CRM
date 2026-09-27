import { beforeEach, describe, expect, it, vi } from "vitest";

// Mesmo motivo de `tests/unit/prospecting-cnpj-worker.test.ts`/
// `prospecting-site-quality-worker.test.ts`: `vi.hoisted()` evita TDZ com o
// import estático do worker mais abaixo.
const { updateSpy, state } = vi.hoisted(() => {
  const updateSpy = vi.fn();
  const state: {
    placeRow: {
      id: string;
      organization_id: string;
      search_id: string;
      name: string;
      address: string | null;
      score_initial: number;
      score_final: number | null;
      instagram_status: string;
    } | null;
    placeError: { message: string } | null;
    claimOk: boolean;
    claimError: { message: string } | null;
    finalUpdateError: { message: string } | null;
    searchRow: { niche_id: string | null } | null;
    nicheRow: { weights: Record<string, number> } | null;
  } = {
    placeRow: null,
    placeError: null,
    claimOk: true,
    claimError: null,
    finalUpdateError: null,
    searchRow: { niche_id: "niche-1" },
    nicheRow: { weights: { instagram: 15 } },
  };
  return { updateSpy, state };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "prospected_searches") {
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.searchRow, error: null }),
            }),
          }),
        };
      }
      if (table === "prospecting_niches") {
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.nicheRow, error: null }),
            }),
          }),
        };
      }
      if (table !== "prospected_places") throw new Error(`tabela inesperada no teste: ${table}`);
      return {
        select: (_cols: string) => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.placeRow, error: state.placeError }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateSpy(patch);
          if (patch.instagram_status === "processing") {
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
          // not_applicable (2 eq, awaited) ou gravação final (2 eq, awaited)
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

const { readInstagramProfileMock, pesquisarGoogleMock } = vi.hoisted(() => ({
  readInstagramProfileMock: vi.fn(),
  pesquisarGoogleMock: vi.fn(),
}));

vi.mock("@/lib/prospecting/apify-client", async (importOriginal) => ({
  // `usuarioDoLink` continua REAL — extração de @ a partir de um link é
  // lógica pura, sem motivo pra mockar.
  ...(await importOriginal<typeof import("@/lib/prospecting/apify-client")>()),
  readInstagramProfile: readInstagramProfileMock,
}));

vi.mock("@/lib/prospecting/pesquisa-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/pesquisa-client")>()),
  pesquisarGoogle: pesquisarGoogleMock,
}));

vi.mock("@/lib/env", () => ({ env: { APIFY_TOKEN: "test-token" } }));

import { env } from "@/lib/env";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { enrichProspectInstagram } from "@/workers/prospecting-instagram-worker";
import type { InstagramProfile } from "@/lib/prospecting/apify-client";

const PERFIL_OSPE: InstagramProfile = {
  usuario: "clinica.ospe",
  nome: "Clínica OSPE",
  seguidores: 2000,
  seguindo: 300,
  posts: 100,
  verificado: false,
  comercial: true,
  categoria: "Dentista",
  bio: "Odontologia em Belo Horizonte",
  linkBio: null,
  ultimoPost: null,
  diasSemPostar: null,
  posts30Dias: 0,
  mediaCurtidas: null,
  mediaComentarios: null,
  engajamentoMedio: null,
};

const PERFIL_GENERICO: InstagramProfile = { ...PERFIL_OSPE, usuario: "perfilqualquer123", nome: "Perfil Qualquer", bio: "" };

function comResultados(items: Array<{ titulo: string; link: string; trecho?: string }>) {
  return async (termos: string[]) =>
    new Map([[termos[0] as string, items.map((i) => ({ titulo: i.titulo, link: i.link, trecho: i.trecho ?? "" }))]]);
}
const semResultados = async (termos: string[]) => new Map([[termos[0] as string, []]]);

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    event_type: "prospected_place.instagram_requested",
    entity_kind: "prospected_place",
    entity_id: "place-1",
    organization_id: "org-1",
    payload: { prospected_place_id: "place-1", search_id: "search-1", place_id: "gp-1", instagram_link: null },
    metadata: {},
    created_at: "2026-09-24T00:00:00.000Z",
    ...overrides,
  } as EventRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  env.APIFY_TOKEN = "test-token";
  state.placeRow = {
    id: "place-1",
    organization_id: "org-1",
    search_id: "search-1",
    name: "Clínica OSPE",
    address: "Belo Horizonte",
    score_initial: 50,
    score_final: null,
    instagram_status: "pending",
  };
  state.placeError = null;
  state.claimOk = true;
  state.claimError = null;
  state.finalUpdateError = null;
  state.searchRow = { niche_id: "niche-1" };
  state.nicheRow = { weights: { instagram: 15 } };
});

describe("enrichProspectInstagram", () => {
  it("link vindo do evento (do site) → lê direto, sem pesquisar", async () => {
    readInstagramProfileMock.mockResolvedValueOnce(PERFIL_OSPE);

    const result = await enrichProspectInstagram(
      eventRow({ payload: { prospected_place_id: "place-1", instagram_link: "https://www.instagram.com/clinica.ospe/" } }),
    );

    expect(result.status).toBe("ok");
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
    expect(readInstagramProfileMock).toHaveBeenCalledWith("clinica.ospe");
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.instagram_data).toEqual(PERFIL_OSPE);
  });

  it("sem link → pesquisa, acha candidato pela marca, lê e aceita", async () => {
    pesquisarGoogleMock.mockImplementationOnce(
      comResultados([{ titulo: "Clínica OSPE (@clinica.ospe) · Belo Horizonte", link: "https://instagram.com/clinica.ospe/", trecho: "clinica ospe belo horizonte" }]),
    );
    readInstagramProfileMock.mockResolvedValueOnce(PERFIL_OSPE);

    const result = await enrichProspectInstagram(eventRow());

    expect(result.status).toBe("ok");
    expect(pesquisarGoogleMock).toHaveBeenCalled();
    expect(readInstagramProfileMock).toHaveBeenCalledWith("clinica.ospe");
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.instagram_data).toEqual(PERFIL_OSPE);
  });

  it("candidato inválido (perfil genérico, sem marca) → descartado, instagram_data=null", async () => {
    readInstagramProfileMock.mockResolvedValueOnce(PERFIL_GENERICO);

    const result = await enrichProspectInstagram(
      eventRow({ payload: { prospected_place_id: "place-1", instagram_link: "https://www.instagram.com/perfilqualquer123/" } }),
    );

    expect(result.status).toBe("ok");
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.instagram_data).toEqual({ motivo: expect.any(String) });
  });

  it("perfil aceito → score_final recalculado somando o peso de Instagram do nicho", async () => {
    readInstagramProfileMock.mockResolvedValueOnce(PERFIL_OSPE);
    state.placeRow!.score_final = 50;
    state.nicheRow = { weights: { instagram: 15 } };

    await enrichProspectInstagram(
      eventRow({ payload: { prospected_place_id: "place-1", instagram_link: "https://www.instagram.com/clinica.ospe/" } }),
    );

    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.score_final).toBe(65);
    expect(finalPatch.status_label).toBeDefined();
  });

  it("perfil descartado → score NÃO é tocado (sem score_final no patch)", async () => {
    readInstagramProfileMock.mockResolvedValueOnce(PERFIL_GENERICO);

    await enrichProspectInstagram(
      eventRow({ payload: { prospected_place_id: "place-1", instagram_link: "https://www.instagram.com/perfilqualquer123/" } }),
    );

    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.score_final).toBeUndefined();
  });

  it("APIFY_TOKEN vazio → instagram_status='not_applicable' direto, sem tentar nada, sem erro", async () => {
    env.APIFY_TOKEN = "";

    const result = await enrichProspectInstagram(eventRow());

    expect(result).toEqual({ consumer_key: "prospecting_instagram_v1", status: "ok" });
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
    expect(readInstagramProfileMock).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({ instagram_status: "not_applicable" });
  });

  it("perfil não encontrado (readInstagramProfile devolve erro) → done com data null", async () => {
    readInstagramProfileMock.mockResolvedValueOnce({ erro: "Perfil não encontrado ou privado." });

    const result = await enrichProspectInstagram(
      eventRow({ payload: { prospected_place_id: "place-1", instagram_link: "https://www.instagram.com/clinica.ospe/" } }),
    );

    expect(result.status).toBe("ok");
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.instagram_data).toEqual({ motivo: expect.any(String) });
  });

  it("pesquisa não acha ninguém → done com data null, nunca chama readInstagramProfile", async () => {
    pesquisarGoogleMock.mockImplementation(semResultados);

    const result = await enrichProspectInstagram(eventRow());

    expect(result.status).toBe("ok");
    expect(readInstagramProfileMock).not.toHaveBeenCalled();
    const finalPatch = updateSpy.mock.calls.find(([p]) => p.instagram_status === "done")?.[0];
    expect(finalPatch.instagram_data).toEqual({ motivo: expect.any(String) });
  });

  it("falha isolada (erro de rede) → instagram_status='failed', devolve status ok (sem retry automático)", async () => {
    pesquisarGoogleMock.mockRejectedValue(new Error("ETIMEDOUT"));

    const result = await enrichProspectInstagram(eventRow());

    expect(result.status).toBe("ok");
    expect(updateSpy).toHaveBeenCalledWith({ instagram_status: "failed" });
  });

  it("gravação de 'failed' também falha → devolve status error", async () => {
    pesquisarGoogleMock.mockRejectedValue(new Error("ETIMEDOUT"));
    state.finalUpdateError = { message: "db fora do ar" };

    const result = await enrichProspectInstagram(eventRow());

    expect(result.status).toBe("error");
  });

  it("já instagram_status='done' → skipped, sem pesquisar de novo", async () => {
    state.placeRow!.instagram_status = "done";
    const result = await enrichProspectInstagram(eventRow());
    expect(result.status).toBe("skipped");
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
  });

  it("já instagram_status='processing' → skipped", async () => {
    state.placeRow!.instagram_status = "processing";
    const result = await enrichProspectInstagram(eventRow());
    expect(result.status).toBe("skipped");
  });

  it("claim concorrente perdido → no-op, nunca pesquisa nem lê perfil", async () => {
    state.claimOk = false;
    const result = await enrichProspectInstagram(eventRow());
    expect(result).toEqual({
      consumer_key: "prospecting_instagram_v1",
      status: "skipped",
      detail: "concurrent claim lost",
    });
    expect(pesquisarGoogleMock).not.toHaveBeenCalled();
  });

  it("prospected_place não encontrado → skipped", async () => {
    state.placeRow = null;
    const result = await enrichProspectInstagram(eventRow());
    expect(result.status).toBe("skipped");
  });

  it("sem prospected_place_id no evento → skipped", async () => {
    const result = await enrichProspectInstagram(eventRow({ payload: {}, entity_id: null as unknown as string }));
    expect(result).toEqual({
      consumer_key: "prospecting_instagram_v1",
      status: "skipped",
      detail: "no prospected_place_id",
    });
  });
});
