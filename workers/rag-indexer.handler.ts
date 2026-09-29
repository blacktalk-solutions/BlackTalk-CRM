/**
 * Adapter that exposes `rag-indexer` to the event_log dispatcher.
 *
 * Kept separate from the worker pipeline file so unit tests can import
 * `processRagIndexer` directly without pulling in the dispatcher registry.
 *
 * `handle` importa `processRagIndexer` de forma PREGUIÇOSA (dentro da função,
 * não no topo do módulo) — achado em produção 2026-09-28: `@/workers/rag-indexer`
 * puxa `lib/ai/rag/extractors/pdf.ts`, que puxa `@react-pdf/renderer`, cuja
 * dependência transitiva `@react-pdf/hyphenate` falhava ao resolver (`Package
 * subpath './en-us' is not defined by "exports"`) na imagem publicada. Um
 * import ESTÁTICO faz ISSO derrubar o carregamento do MÓDULO inteiro — e
 * `register-handlers.ts` importa todos os handlers no topo, então a falha
 * de UM (este) impedia os outros 17 de se registrarem, incluindo
 * `aiResponseHandler` (a resposta da IA). Com o import preguiçoso, uma falha
 * aqui vira `status: "error"` só NESTE handler — os demais registram normal.
 */

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

export const RAG_INDEXER_HANDLER_KEY = "rag-indexer.v1";

export const ragIndexerHandler: EventHandler = {
  key: RAG_INDEXER_HANDLER_KEY,
  events: ["nuvemshop.product_synced", "knowledge_source.updated"],
  async handle(row: EventRow): Promise<HandlerResult> {
    const { processRagIndexer } = await import("@/workers/rag-indexer");
    return processRagIndexer(row);
  },
};
