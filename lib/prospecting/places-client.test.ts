import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "@/lib/env";
import { searchPlaces, PlacesApiError } from "./places-client";

// `lib/env.ts` roda a validação Zod inteira do app (Supabase, WAHA, etc.) no
// import — mockar aqui é o mesmo padrão de lib/supabase/cookie-secure.test.ts:
// devolve um objeto simples e mutável, então cada teste só atribui a chave que
// importa, sem arrastar as ~30 outras variáveis obrigatórias do schema real.
vi.mock("@/lib/env", () => ({
  env: { GOOGLE_PLACES_API_KEY: "test-api-key" },
}));

/** Monta um `Response` fake mínimo — só o que o client lê (`ok`, `status`, `json()`). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Gera N items de `places[]` no formato bruto da API, com id previsível. */
function buildApiPlaces(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    displayName: { text: `Estabelecimento ${prefix} ${i}` },
    formattedAddress: "Rua Teste, 123",
    nationalPhoneNumber: "+55 11 99999-0000",
    websiteUri: "https://example.com",
    rating: 4.5,
    userRatingCount: 30,
  }));
}

function instantDelay(): Promise<void> {
  return Promise.resolve();
}

/** Shape mínima de um mock de fetchImpl que basta pra ler as chamadas gravadas. */
interface RecordedFetchMock {
  mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
}

/** Extrai o `RequestInit` de uma chamada de `fetchImpl`, ou falha o teste se a chamada não aconteceu. */
function initFromCall(fetchImpl: RecordedFetchMock, callIndex = 0): RequestInit {
  const call = fetchImpl.mock.calls[callIndex];
  if (!call) throw new Error(`fetchImpl não foi chamado (call #${callIndex})`);
  const [, init] = call;
  if (!init) throw new Error(`fetchImpl call #${callIndex} não tem init`);
  return init;
}

function parseBody(init: RequestInit): { pageToken?: string } {
  return JSON.parse(init.body as string) as { pageToken?: string };
}

beforeEach(() => {
  env.GOOGLE_PLACES_API_KEY = "test-api-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchPlaces — busca de 1 página", () => {
  it("should return results from a single page with placesApiCapped=false when there's no nextPageToken", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, { places: buildApiPlaces(2, "p1") }),
    );

    const result = await searchPlaces(
      { businessType: "restaurante", location: "São Paulo" },
      { fetchImpl, delayImpl: instantDelay },
    );

    expect(result.placesApiCapped).toBe(false);
    expect(result.places).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("searchPlaces — paginação até o teto (3 páginas / 60 resultados)", () => {
  it("should make exactly 3 fetch calls, chain pageTokens correctly, and set placesApiCapped=true when the 3rd page still has a nextPageToken", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = parseBody(init ?? {});
      if (!body.pageToken) {
        // 1ª chamada: sem pageToken.
        return fakeResponse(200, { places: buildApiPlaces(20, "page1"), nextPageToken: "token-page2" });
      }
      if (body.pageToken === "token-page2") {
        return fakeResponse(200, { places: buildApiPlaces(20, "page2"), nextPageToken: "token-page3" });
      }
      if (body.pageToken === "token-page3") {
        // 3ª página ainda tem nextPageToken — deve ser ignorado (não existe 4ª chamada).
        return fakeResponse(200, { places: buildApiPlaces(20, "page3"), nextPageToken: "token-page4" });
      }
      throw new Error(`unexpected pageToken in test: ${body.pageToken}`);
    });

    const result = await searchPlaces(
      { businessType: "salão de beleza", location: "Curitiba" },
      { fetchImpl, delayImpl: instantDelay },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.places).toHaveLength(60);
    expect(result.placesApiCapped).toBe(true);

    // Confirma o encadeamento exato dos pageTokens entre as 3 chamadas.
    expect(parseBody(initFromCall(fetchImpl, 0)).pageToken).toBeUndefined();
    expect(parseBody(initFromCall(fetchImpl, 1)).pageToken).toBe("token-page2");
    expect(parseBody(initFromCall(fetchImpl, 2)).pageToken).toBe("token-page3");
  });
});

describe("searchPlaces — para antes do teto (2 páginas)", () => {
  it("should stop after 2 fetch calls and set placesApiCapped=false when page 2 has no nextPageToken", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = parseBody(init ?? {});
      if (!body.pageToken) {
        return fakeResponse(200, { places: buildApiPlaces(20, "page1"), nextPageToken: "token-page2" });
      }
      return fakeResponse(200, { places: buildApiPlaces(10, "page2") });
    });
    const delayImpl = vi.fn(instantDelay);

    const result = await searchPlaces(
      { businessType: "pizzaria", location: "Belo Horizonte" },
      { fetchImpl, delayImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.places).toHaveLength(30);
    expect(result.placesApiCapped).toBe(false);
    // Só há espera ENTRE páginas — 2 páginas = 1 delay, não 2.
    expect(delayImpl).toHaveBeenCalledTimes(1);
  });
});

describe("searchPlaces — taxonomia de erro", () => {
  it("should throw PlacesApiError with code 'missing_api_key' WITHOUT calling fetch when the env var is absent", async () => {
    // "" é exatamente o que `lib/env.ts` devolve pra GOOGLE_PLACES_API_KEY
    // ausente (z.string().optional().default("")) — nunca undefined.
    env.GOOGLE_PLACES_API_KEY = "";
    const fetchImpl = vi.fn();

    await expect(
      searchPlaces({ businessType: "clínica", location: "Recife" }, { fetchImpl, delayImpl: instantDelay }),
    ).rejects.toMatchObject({ code: "missing_api_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should throw PlacesApiError with code 'invalid_api_key_or_billing' on HTTP 403", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }),
    );

    const promise = searchPlaces(
      { businessType: "academia", location: "Porto Alegre" },
      { fetchImpl, delayImpl: instantDelay },
    );

    await expect(promise).rejects.toBeInstanceOf(PlacesApiError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_api_key_or_billing" });
  });

  it("should throw PlacesApiError with code 'quota_exceeded' on HTTP 429", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }),
    );

    await expect(
      searchPlaces({ businessType: "barbearia", location: "Salvador" }, { fetchImpl, delayImpl: instantDelay }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("should throw PlacesApiError with code 'unknown_error' on any other non-2xx HTTP status", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(500, { error: { code: 500, status: "INTERNAL", message: "Internal error" } }),
    );

    await expect(
      searchPlaces({ businessType: "escritório", location: "Fortaleza" }, { fetchImpl, delayImpl: instantDelay }),
    ).rejects.toMatchObject({ code: "unknown_error" });
  });

  it("should wrap a transport-level fetch rejection (DNS/timeout/connection refused) as PlacesApiError with code 'unknown_error'", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network timeout");
    });

    const promise = searchPlaces(
      { businessType: "veterinária", location: "Goiânia" },
      { fetchImpl, delayImpl: instantDelay },
    );

    await expect(promise).rejects.toBeInstanceOf(PlacesApiError);
    await expect(promise).rejects.toMatchObject({ code: "unknown_error" });
    // A mensagem original não pode se perder — é o que torna o erro depurável.
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("network timeout") });
  });
});

describe("searchPlaces — zero resultados", () => {
  it("should return an empty list with placesApiCapped=false (not an error) when the 'places' array is absent", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, {}));

    const result = await searchPlaces(
      { businessType: "vulcanizadora", location: "Manaus" },
      { fetchImpl, delayImpl: instantDelay },
    );

    expect(result.places).toEqual([]);
    expect(result.placesApiCapped).toBe(false);
  });
});

describe("searchPlaces — mapeamento de campos ausentes", () => {
  it("should map missing optional fields (rating, address, phone, website, reviewCount) to null", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, {
        places: [
          {
            id: "place-sem-rating",
            displayName: { text: "Padaria do Zé" },
            // formattedAddress, nationalPhoneNumber, websiteUri, rating,
            // userRatingCount — todos ausentes de propósito.
          },
        ],
      }),
    );

    const result = await searchPlaces(
      { businessType: "padaria", location: "Brasília" },
      { fetchImpl, delayImpl: instantDelay },
    );

    expect(result.places).toEqual([
      {
        placeId: "place-sem-rating",
        name: "Padaria do Zé",
        address: null,
        phoneNumber: null,
        websiteUrl: null,
        rating: null,
        reviewCount: null,
      },
    ]);
  });
});

describe("searchPlaces — field mask", () => {
  it("should send exactly the 7 expected fields in the X-Goog-FieldMask header, no more and no less", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => fakeResponse(200, { places: [] }));

    await searchPlaces(
      { businessType: "loja de roupas", location: "Florianópolis" },
      { fetchImpl, delayImpl: instantDelay },
    );

    const headers = initFromCall(fetchImpl).headers as Record<string, string>;
    const fieldMask = headers["X-Goog-FieldMask"];

    const expectedFields = [
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.nationalPhoneNumber",
      "places.websiteUri",
      "places.rating",
      "places.userRatingCount",
    ];

    expect(fieldMask).toBeDefined();
    expect(fieldMask!.split(",")).toEqual(expectedFields);
  });

  it("should read the API key from env.GOOGLE_PLACES_API_KEY (lib/env.ts) into X-Goog-Api-Key", async () => {
    env.GOOGLE_PLACES_API_KEY = "minha-chave-secreta";
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => fakeResponse(200, { places: [] }));

    await searchPlaces(
      { businessType: "farmácia", location: "Vitória" },
      { fetchImpl, delayImpl: instantDelay },
    );

    const headers = initFromCall(fetchImpl).headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("minha-chave-secreta");
  });
});
