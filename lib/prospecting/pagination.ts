/**
 * Paginação client-side pura da tabela de resultados de prospecção
 * (`app/app/prospeccao/_components/ProspectingResultsTable.tsx`).
 *
 * Os dados já vieram TODOS do servidor numa única resposta (até
 * `PLACES_API_CAP`, hoje 60 — PROSPECT-01/PROSPECT-07). Isto aqui só decide
 * quais linhas mostrar na página atual; nunca dispara requisição nova
 * (PROSPECT-04: "paginação 15/15 sem nova chamada"). Extraído em função pura,
 * sem depender de React nem do componente, para ser testável isolado — mesma
 * doutrina de `lib/prospecting/score.ts` ("é fórmula, não IA", auditável).
 */

/** Linhas por página da tabela de resultados (PROSPECT-04: "15/15"). */
export const RESULTS_PAGE_SIZE = 15;

/**
 * Teto de resultados que a Google Places API devolve por busca
 * (PROSPECT-01/PROSPECT-07). Não corta array nenhum aqui — a API já garante
 * isso antes dos dados chegarem à UI — só documenta o número que o aviso de
 * teto (`placesApiCapped`) cita.
 */
export const PLACES_API_CAP = 60;

/**
 * Quantas páginas de `pageSize` itens cabem em `itemCount`.
 *
 * Lista vazia ainda é 1 página, não 0: "Página 1/1" é o estado certo para uma
 * tabela sem resultados — zero páginas seria ausência de paginação, uma
 * afirmação diferente (e falsa: a tabela existe, só que vazia).
 */
export function totalResultPages(
  itemCount: number,
  pageSize: number = RESULTS_PAGE_SIZE,
): number {
  if (itemCount <= 0) return 1;
  return Math.ceil(itemCount / pageSize);
}

/** Mantém `page` dentro de `[1, totalResultPages(itemCount, pageSize)]`. */
export function clampResultPage(
  page: number,
  itemCount: number,
  pageSize: number = RESULTS_PAGE_SIZE,
): number {
  const total = totalResultPages(itemCount, pageSize);
  return Math.min(Math.max(1, page), total);
}

/**
 * A fatia de `items` que pertence à página `page` (1-indexed).
 *
 * `page` fora do intervalo é grampeado (`clampResultPage`) em vez de devolver
 * vazio — um clique perdido de "próxima" na última página não pode fazer a
 * tabela desaparecer.
 */
export function paginateResults<T>(
  items: readonly T[],
  page: number,
  pageSize: number = RESULTS_PAGE_SIZE,
): T[] {
  const safePage = clampResultPage(page, items.length, pageSize);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
