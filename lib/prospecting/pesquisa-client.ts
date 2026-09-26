/**
 * Client de pesquisa no Google via Apify — T6
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Réplica de `prospeccao-kit-aluno/lib/pesquisa.mjs` — SÓ o caminho Apify
 * (`apify~google-search-scraper`): a decisão já tomada nesta feature
 * (`design.md`, "Tech Decisions") é não adotar Serper como segundo provedor,
 * padronizando em Apify pra Maps + Instagram + pesquisa. O kit tinha os dois
 * caminhos (Serper OU Apify); aqui existe só o que o `.env.local` real desta
 * feature usa.
 *
 * Server-only por construção — mesma nota de `places-client.ts`/`apify-client.ts`:
 * lê `APIFY_TOKEN` de `lib/env.ts`, nunca deveria ser importado por um Client
 * Component.
 *
 * Dois níveis, como no kit:
 * - `pesquisarGoogle` — o primitivo em LOTE (uma chamada Apify pra N queries,
 *   mesmo formato do `googleApify` do kit).
 * - `buscarComTentativas` — o padrão "até 3 tentativas, formatos diferentes,
 *   para na primeira que trouxer algo" que `procurarSite`/`procurarInstagram`/
 *   `acharCnpj` do kit repetem cada um à sua moda. Aqui fica genérico: quem
 *   monta os textos das até 3 tentativas (site vs Instagram vs CNPJ) são os
 *   workers que consomem este client (T9/T10) — este módulo não sabe o que é
 *   "site" ou "CNPJ", só sabe pesquisar e parar cedo quando acha.
 */

import { env } from "@/lib/env";

const ATOR = "apify~google-search-scraper";

/** Um resultado orgânico do Google — mesmo shape do kit (`titulo`/`link`/`trecho`). */
export interface SearchResultItem {
  titulo: string;
  link: string;
  trecho: string;
}

/**
 * Taxonomia de erro — nunca uma exception genérica, mesma doutrina de
 * `places-client.ts` (`PlacesApiError`).
 */
export type PesquisaApifyErrorCode = "missing_api_key" | "invalid_token" | "quota_exceeded" | "unknown_error";

export class PesquisaApifyError extends Error {
  code: PesquisaApifyErrorCode;

  constructor(code: PesquisaApifyErrorCode, message: string) {
    super(message);
    this.name = "PesquisaApifyError";
    this.code = code;
  }
}

/** Dependências injetáveis — produção usa `fetch` real; testes injetam um mock. */
export interface PesquisaClientDeps {
  fetchImpl?: typeof fetch;
}

const normalizarTermo = (q: string): string => q.replace(/\s+/g, " ").trim();

/** Forma (parcial) de uma "página" do dataset do `google-search-scraper`. */
interface ApifySearchPage {
  searchQuery?: { term?: string };
  organicResults?: Array<{ title?: string; url?: string; description?: string }>;
}

/**
 * Pesquisa em LOTE: uma chamada só ao Apify pra todas as `termos` (mesmo
 * formato de `googleApify` do kit — `queries` separadas por `\n`). Devolve um
 * `Map` termo(normalizado) → resultados; termo que o Apify não devolveu vira
 * lista vazia (não repete a busca, mesma nota do kit).
 *
 * @throws {PesquisaApifyError} `missing_api_key` (sem nem chamar fetch),
 *   `invalid_token` (401), `quota_exceeded` (402), ou `unknown_error`
 *   (qualquer outro HTTP, ou falha de transporte).
 */
export async function pesquisarGoogle(
  termos: string[],
  deps: PesquisaClientDeps = {},
): Promise<Map<string, SearchResultItem[]>> {
  const token = env.APIFY_TOKEN;
  if (!token) {
    throw new PesquisaApifyError(
      "missing_api_key",
      "APIFY_TOKEN não configurado — pesquisa no Google desativada.",
    );
  }

  const queries = [...new Set(termos.map(normalizarTermo))].filter(Boolean);
  const resultado = new Map<string, SearchResultItem[]>();
  if (!queries.length) return resultado;

  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.apify.com/v2/acts/${ATOR}/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: queries.join("\n"),
          countryCode: "br",
          languageCode: "pt-BR",
          maxPagesPerQuery: 1,
        }),
      },
    );
  } catch (transportError) {
    const detalhe = transportError instanceof Error ? transportError.message : String(transportError);
    throw new PesquisaApifyError("unknown_error", `Falha de transporte ao consultar o Apify: ${detalhe}`);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new PesquisaApifyError(
        "invalid_token",
        "APIFY_TOKEN inválido (401). Gere um novo em console.apify.com/settings/integrations.",
      );
    }
    if (response.status === 402) {
      throw new PesquisaApifyError("quota_exceeded", "Crédito do Apify esgotado (402). O plano gratuito renova todo mês.");
    }
    const corpo = (await response.text().catch(() => "")).slice(0, 200);
    throw new PesquisaApifyError("unknown_error", `Apify pesquisa respondeu ${response.status}: ${corpo}`);
  }

  const paginas = ((await response.json().catch(() => [])) ?? []) as ApifySearchPage[];
  for (const p of paginas) {
    const termo = normalizarTermo(String(p.searchQuery?.term ?? ""));
    const itens = (p.organicResults ?? []).map((o) => ({
      titulo: o.title ?? "",
      link: o.url ?? "",
      trecho: o.description ?? "",
    }));
    resultado.set(termo, itens);
  }
  for (const q of queries) {
    if (!resultado.has(q)) resultado.set(q, []);
  }

  return resultado;
}

/** Teto de tentativas por "coisa procurada" (site, Instagram, CNPJ) — mesmo valor do kit. */
export const TENTATIVAS = 3;

/**
 * Tenta, em ordem, cada uma das (até `TENTATIVAS`) variantes de busca já
 * montadas pelo caller — mesmo padrão de `procurarSite`/`procurarInstagram`/
 * `acharCnpj` do kit: para na primeira tentativa que trouxer QUALQUER
 * resultado; se a terceira também vier vazia, devolve lista vazia sem uma
 * 4ª chamada (cada chamada é uma execução paga do ator no Apify).
 *
 * Cada tentativa é uma chamada separada a `pesquisarGoogle` (não um lote só)
 * de propósito: é o que permite parar cedo sem gastar a 2ª/3ª tentativa
 * quando a 1ª já resolve.
 *
 * @param tentativas Textos de busca já formatados pelo caller, do mais
 *   preciso ao mais amplo. Só os 3 primeiros são usados.
 */
export async function buscarComTentativas(
  tentativas: string[],
  deps: PesquisaClientDeps = {},
): Promise<SearchResultItem[]> {
  for (const termo of tentativas.slice(0, TENTATIVAS)) {
    const mapa = await pesquisarGoogle([termo], deps);
    const itens = mapa.get(normalizarTermo(termo)) ?? [];
    if (itens.length > 0) return itens;
  }
  return [];
}

/**
 * Onde o Google mostra a empresa mas não é o site DELA: rede social,
 * diretório, marketplace, cadastro de CNPJ. Mesma lista do kit
 * (`lib/pesquisa.mjs`, `NAO_E_SITE`) — usada pra descartar candidato a
 * "site próprio" achado numa pesquisa (T9/T10 chamam `ehSiteProprio` sobre
 * cada `link` de `SearchResultItem` antes de aceitar como site/Instagram).
 */
export const NAO_E_SITE = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "linkedin.com",
  "wa.me",
  "whatsapp.com",
  "google.com",
  "goo.gl",
  "g.page",
  "waze.com",
  "tripadvisor",
  "ifood.com.br",
  "rappi",
  "ubereats",
  "apontador.com.br",
  "yelp",
  "guiamais.com.br",
  "telelistas",
  "solutudo",
  "doctoralia",
  "boaconsulta",
  "reclameaqui",
  "cnpj.biz",
  "casadosdados",
  "econodata",
  "empresaqui",
  "cnpja",
  "cnpj.ws",
  "consultasocio",
  "jusbrasil",
  "escavador",
  "wikipedia",
  "mercadolivre",
  "olx.com.br",
  "gov.br",
  "infobel",
  "cylex",
  "hotfrog",
  "encontra",
  "listamais",
  "kekanto",
  "foursquare",
  "glassdoor",
  "indeed",
  "catho",
  "infojobs",
];

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * `true` quando o link é candidato a "site próprio" da empresa — não está na
 * lista `NAO_E_SITE` (rede social/diretório/marketplace) e é uma URL válida.
 * Não confirma que É o site dela (isso ainda exige bater marca/telefone,
 * responsabilidade do worker que chama isto) — só descarta o que
 * definitivamente NÃO é.
 */
export function ehSiteProprio(link: string): boolean {
  const h = host(link);
  if (!h) return false;
  return !NAO_E_SITE.some((d) => h.includes(d));
}
