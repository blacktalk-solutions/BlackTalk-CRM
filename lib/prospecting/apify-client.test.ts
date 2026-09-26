import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "@/lib/env";
import { readInstagramProfile, usuarioDoLink, type InstagramProfile } from "./apify-client";

// Mesmo padrão de `places-client.test.ts` — `lib/env.ts` roda a validação Zod
// inteira do app no import; mockar aqui devolve um objeto simples e mutável.
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

const AGORA = Date.parse("2026-09-24T00:00:00Z");
const fixedNow = () => AGORA;

const PERFIL_ATIVO = {
  username: "clinica.ospe",
  fullName: "Clínica OSPE",
  followersCount: 2300,
  followsCount: 400,
  postsCount: 412,
  verified: false,
  isBusinessAccount: true,
  businessCategoryName: "Dentista",
  biography: "Odontologia em Belo Horizonte",
  externalUrl: "https://clinicaospe.com.br",
  latestPosts: [
    { timestamp: "2026-09-20T10:00:00.000Z", likesCount: 50, commentsCount: 5, type: "Image", caption: "Post recente" },
    { timestamp: "2026-08-01T10:00:00.000Z", likesCount: 30, commentsCount: 3, type: "Image", caption: "Post antigo" },
  ],
};

beforeEach(() => {
  env.APIFY_TOKEN = "test-token";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readInstagramProfile", () => {
  it("perfil válido devolve seguidores, posts, diasSemPostar e engajamentoMedio", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, [PERFIL_ATIVO]));
    const result = await readInstagramProfile("clinica.ospe", { fetchImpl, now: fixedNow });

    expect("erro" in result).toBe(false);
    const perfil = result as InstagramProfile;
    expect(perfil.seguidores).toBe(2300);
    expect(perfil.posts).toBe(412);
    expect(perfil.diasSemPostar).toBe(3); // 20/set 10h -> 24/set 00h = 3 dias e meio, floor = 3
    expect(perfil.engajamentoMedio).toBeGreaterThan(0);
  });

  it("sem APIFY_TOKEN configurado → erro específico, sem chamar a rede", async () => {
    env.APIFY_TOKEN = "";
    const fetchImpl = vi.fn();
    const result = await readInstagramProfile("clinica.ospe", { fetchImpl });
    expect(result).toHaveProperty("erro");
    expect((result as { erro: string }).erro).toContain("APIFY_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("token inválido (401) → mensagem específica, não exception genérica", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, {}));
    const result = await readInstagramProfile("clinica.ospe", { fetchImpl });
    expect(result).toHaveProperty("erro");
    expect((result as { erro: string }).erro).toContain("401");
  });

  it("crédito esgotado (402) → mensagem específica, não exception genérica", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(402, {}));
    const result = await readInstagramProfile("clinica.ospe", { fetchImpl });
    expect(result).toHaveProperty("erro");
    expect((result as { erro: string }).erro).toContain("402");
  });

  it("perfil inexistente/privado (Apify devolve `error`) → erro, não exception", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, [{ error: "not found or private" }]));
    const result = await readInstagramProfile("perfil-inexistente", { fetchImpl });
    expect(result).toHaveProperty("erro");
    expect((result as { erro: string }).erro).toContain("não encontrado");
  });

  it("erro de rede (fetch rejeita) é tratado sem exception não capturada", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(readInstagramProfile("clinica.ospe", { fetchImpl })).resolves.toHaveProperty("erro");
  });

  it("perfil sem posts (curtida escondida/sem atividade) não quebra o cálculo de engajamento", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, [{ ...PERFIL_ATIVO, latestPosts: [] }]),
    );
    const result = await readInstagramProfile("clinica.ospe", { fetchImpl, now: fixedNow });
    expect("erro" in result).toBe(false);
    const perfil = result as InstagramProfile;
    expect(perfil.diasSemPostar).toBeNull();
    expect(perfil.engajamentoMedio).toBeNull();
  });
});

describe("usuarioDoLink", () => {
  it("extrai o usuário de um link de perfil", () => {
    expect(usuarioDoLink("https://www.instagram.com/clinica.ospe/?hl=pt")).toBe("clinica.ospe");
  });

  it("descarta link de post (não é perfil)", () => {
    expect(usuarioDoLink("https://www.instagram.com/p/Cabc123/")).toBeNull();
  });

  it("descarta link de reel (não é perfil)", () => {
    expect(usuarioDoLink("https://www.instagram.com/reel/Cabc123/")).toBeNull();
  });

  it("link que não é do Instagram devolve null", () => {
    expect(usuarioDoLink("https://exemplo.com.br")).toBeNull();
  });
});
