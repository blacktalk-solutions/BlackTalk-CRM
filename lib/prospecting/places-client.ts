/**
 * Client da Google Places API (New) — busca de estabelecimentos por texto.
 *
 * Server-only por construção: lê `GOOGLE_PLACES_API_KEY` de `lib/env.ts`
 * (validada via Zod, junto de toda outra chave externa — WAHA, Resend,
 * Google Agenda etc.) e nunca deveria ser importado por um Client Component.
 * Não há `"use client"` neste arquivo nem chamada de browser API — só
 * `fetch`/`setTimeout`, que existem tanto em Node quanto em browser, então a
 * fronteira aqui é de IMPORT (nenhuma rota/componente client deve importar
 * este módulo), não de runtime. Se algum dia isso vazar para o bundle do
 * cliente, a chave da Google apareceria só se alguém também expusesse
 * `GOOGLE_PLACES_API_KEY` como `NEXT_PUBLIC_*` — o que `lib/env.ts` não faz.
 */

import { env } from "@/lib/env";

/** Um resultado bruto de place, já mapeado dos nomes da API pros nossos. */
export interface RawPlace {
  placeId: string;
  name: string;
  address: string | null;
  phoneNumber: string | null;
  websiteUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  lat: number | null;
  lng: number | null;
  googleMapsUrl: string | null;
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
 * Os campos que `RawPlace` de fato usa, mais `nextPageToken`. A Places API
 * (New) só devolve o que está listado no field mask — inclusive campos de
 * TOPO como `nextPageToken`, não só os de `places[]`. Sem ele aqui, a Google
 * nunca manda o token de próxima página mesmo quando existem mais de 20
 * resultados, e a busca capa silenciosamente em 20 sempre (achado ao
 * investigar relato real: "Pizzaria em São Paulo" trazendo só 20 quando a
 * própria Google confirma ter mais, testado direto com curl/fetch cru).
 * Fora isso, nenhum campo extra: a New API cobra por SKU conforme os campos
 * pedidos, então cada um a mais é custo recorrente sem uso no produto.
 *
 * `location`/`googleMapsUri` são exceção deliberada a essa regra — mas não
 * custo novo: as duas são tier Pro, e `nationalPhoneNumber`/`websiteUri`/
 * `rating` (já pedidos acima) já são tier Enterprise. A Places API cobra pelo
 * campo MAIS CARO do request, não por campo adicional — um request que já
 * paga Enterprise não fica mais caro ao ganhar campos Pro (confirmado em
 * developers.google.com/maps/documentation/places/web-service/usage-and-billing,
 * set/2026). Reconfira lá se o pricing mudar antes de assumir isto de novo.
 */
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location,places.googleMapsUri,nextPageToken";

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
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
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
    lat: item.location?.latitude ?? null,
    lng: item.location?.longitude ?? null,
    googleMapsUrl: item.googleMapsUri ?? null,
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
 *   `invalid_api_key_or_billing`, `quota_exceeded`, ou `unknown_error`
 *   (também usado pra falha de transporte — DNS, timeout, conexão recusada).
 */
export async function searchPlaces(
  query: SearchPlacesQuery,
  deps: SearchPlacesDeps = {},
): Promise<SearchPlacesResult> {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
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
    let response: Response;
    try {
      response = await fetchImpl(PLACES_SEARCH_URL, {
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
    } catch (transportError) {
      // Falha de TRANSPORTE (DNS, timeout, conexão recusada) — nunca chegou a
      // haver resposta HTTP, então não há status pra classificar. Ainda assim
      // vira PlacesApiError (doutrina do módulo: nunca exception genérica),
      // reaproveitando "unknown_error" — não é billing/quota/chave, é a rede.
      const detalhe = transportError instanceof Error ? transportError.message : String(transportError);
      throw new PlacesApiError("unknown_error", `Google Places API: falha de transporte (${detalhe})`);
    }

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
