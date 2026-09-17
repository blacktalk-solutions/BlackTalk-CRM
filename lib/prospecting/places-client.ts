/**
 * Client da Google Places API (New) — busca de estabelecimentos por texto.
 *
 * Server-only por construção: lê `GOOGLE_PLACES_API_KEY` de `process.env` e
 * nunca deveria ser importado por um Client Component. Não há `"use client"`
 * neste arquivo nem chamada de browser API — só `fetch`/`setTimeout`, que
 * existem tanto em Node quanto em browser, então a fronteira aqui é de
 * IMPORT (nenhuma rota/componente client deve importar este módulo), não de
 * runtime. Se algum dia isso vazar para o bundle do cliente, a chave da
 * Google apareceria só se alguém também expusesse `GOOGLE_PLACES_API_KEY`
 * como `NEXT_PUBLIC_*` — o que este módulo não faz.
 */

/** Um resultado bruto de place, já mapeado dos nomes da API pros nossos. */
export interface RawPlace {
  placeId: string;
  name: string;
  address: string | null;
  phoneNumber: string | null;
  websiteUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
}

/** Resultado agregado de todas as páginas buscadas. */
export interface SearchPlacesResult {
  places: RawPlace[];
  /**
   * `true` quando a busca bateu no teto de 3 páginas (60 resultados) e a
   * última página ainda tinha `nextPageToken` — ou seja, existem mais
   * resultados na Google que este client deliberadamente não foi buscar.
   * `false` quando a busca esgotou os resultados antes do teto.
   */
  placesApiCapped: boolean;
}

/**
 * Taxonomia de erro da Places API — nunca uma exception genérica, porque
 * cada código pede uma reação diferente de quem chama (avisar o operador que
 * falta configurar a chave vs. dizer ao usuário "tente de novo mais tarde").
 */
export type PlacesApiErrorCode =
  | "missing_api_key"
  | "invalid_api_key_or_billing"
  | "quota_exceeded"
  | "unknown_error";

export class PlacesApiError extends Error {
  code: PlacesApiErrorCode;

  constructor(code: PlacesApiErrorCode, message: string) {
    super(message);
    this.name = "PlacesApiError";
    this.code = code;
  }
}

/** Parâmetros de busca aceitos pelo caller. */
export interface SearchPlacesQuery {
  businessType: string;
  location: string;
}

/** Dependências injetáveis — produção usa os defaults reais. */
export interface SearchPlacesDeps {
  fetchImpl?: typeof fetch;
  /** Espera entre páginas em ms. Default real usa `setTimeout`; testes injetam um mock instantâneo. */
  delayImpl?: (ms: number) => Promise<void>;
}

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Só os 7 campos que `RawPlace` de fato usa — nada além disso. A Places API
 * (New) cobra por SKU conforme os campos pedidos no field mask, então cada
 * campo extra aqui é custo recorrente sem uso no produto.
 */
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;

/**
 * A Google exige uma pequena espera antes que um `pageToken` retornado fique
 * válido para a próxima chamada; chamar imediatamente pode devolver erro ou
 * página vazia. ~2s é o que funciona na prática.
 */
const PAGE_TOKEN_DELAY_MS = 2000;

async function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Forma (parcial, só o que lemos) de um item de `places[]` na resposta da API. */
interface PlacesApiResponseItem {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
}

interface PlacesApiSearchTextResponse {
  places?: PlacesApiResponseItem[];
  nextPageToken?: string;
}

/** Envelope de erro padrão das Google APIs: `{ error: { code, message, status } }`. */
interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

function mapRawPlace(item: PlacesApiResponseItem): RawPlace {
  return {
    // id e displayName.text vêm garantidos pela API quando pedidos no field
    // mask (são os identificadores do resultado); "" é só um piso defensivo
    // contra corpo malformado, não um caso esperado.
    placeId: item.id ?? "",
    name: item.displayName?.text ?? "",
    address: item.formattedAddress ?? null,
    phoneNumber: item.nationalPhoneNumber ?? null,
    websiteUrl: item.websiteUri ?? null,
    rating: item.rating ?? null,
    reviewCount: item.userRatingCount ?? null,
  };
}

/**
 * Classifica um HTTP não-2xx da Places API num `PlacesApiErrorCode`.
 *
 * Prioriza o status HTTP (o sinal mais confiável), com o corpo do erro como
 * reforço — a Google às vezes devolve `INVALID_ARGUMENT`/400 para chave
 * malformada em vez do 403 "esperado", então checar palavras-chave no corpo
 * cobre esse caso sem depender só do código de status.
 */
async function buildApiError(response: Response): Promise<PlacesApiError> {
  const status = response.status;
  const body = (await response.json().catch(() => null)) as GoogleApiErrorBody | null;
  const haystack = `${body?.error?.status ?? ""} ${body?.error?.message ?? ""}`.toLowerCase();

  const indicaBillingOuChaveInvalida =
    status === 403 ||
    haystack.includes("permission_denied") ||
    haystack.includes("api key not valid") ||
    haystack.includes("api_key_invalid") ||
    haystack.includes("billing");
  if (indicaBillingOuChaveInvalida) {
    return new PlacesApiError(
      "invalid_api_key_or_billing",
      `Google Places API: chave inválida ou billing desabilitado (HTTP ${status})`,
    );
  }

  const indicaQuota = status === 429 || haystack.includes("resource_exhausted") || haystack.includes("quota");
  if (indicaQuota) {
    return new PlacesApiError("quota_exceeded", `Google Places API: quota excedida (HTTP ${status})`);
  }

  return new PlacesApiError("unknown_error", `Google Places API: erro inesperado (HTTP ${status})`);
}

/**
 * Busca estabelecimentos na Google Places API (New), paginando até 60
 * resultados (3 páginas de 20).
 *
 * @param query `businessType` + `location` — vira `"<businessType> em <location>"`.
 * @param deps `fetchImpl`/`delayImpl` injetáveis; produção usa os defaults reais.
 * @throws {PlacesApiError} `missing_api_key` (sem nem chamar fetch),
 *   `invalid_api_key_or_billing`, `quota_exceeded`, ou `unknown_error`.
 */
export async function searchPlaces(
  query: SearchPlacesQuery,
  deps: SearchPlacesDeps = {},
): Promise<SearchPlacesResult> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new PlacesApiError(
      "missing_api_key",
      "GOOGLE_PLACES_API_KEY não configurada — a busca de prospecção não pode rodar sem ela.",
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const delayImpl = deps.delayImpl ?? defaultDelay;

  const places: RawPlace[] = [];
  let placesApiCapped = false;
  let pageToken: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchImpl(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `${query.businessType} em ${query.location}`,
        pageSize: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      }),
    });

    if (!response.ok) {
      throw await buildApiError(response);
    }

    const data = ((await response.json().catch(() => ({}))) ?? {}) as PlacesApiSearchTextResponse;
    for (const item of data.places ?? []) {
      places.push(mapRawPlace(item));
    }

    const nextPageToken = data.nextPageToken;
    if (!nextPageToken) {
      // Busca esgotou antes do teto: não há mais páginas, não é capped.
      placesApiCapped = false;
      break;
    }

    if (page === MAX_PAGES) {
      // 3ª página ainda tem nextPageToken — existe mais, mas não há 4ª chamada.
      placesApiCapped = true;
      break;
    }

    pageToken = nextPageToken;
    await delayImpl(PAGE_TOKEN_DELAY_MS);
  }

  return { places, placesApiCapped };
}
