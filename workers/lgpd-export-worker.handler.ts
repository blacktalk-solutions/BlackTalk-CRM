/**
 * Handler adapter exposing lgpd-export-worker to the event_log dispatcher.
 *
 * Consumed key: `lgpd-export-worker.v1` — recorded in
 * `event_log.consumed_by[]` so retries skip already-completed runs.
 *
 * `handle` importa `processLgpdExport` de forma PREGUIÇOSA (dentro da função,
 * não no topo do módulo) — achado em produção 2026-09-28: `@/workers/lgpd-export-worker`
 * puxa `lib/lgpd/pdf-renderer.tsx`, que puxa `@react-pdf/renderer`, cuja
 * dependência transitiva `@react-pdf/hyphenate` falhava ao resolver (`Package
 * subpath './en-us' is not defined by "exports"`) na imagem publicada. Um
 * import ESTÁTICO faz ISSO derrubar o carregamento do MÓDULO inteiro — e
 * `register-handlers.ts` importa todos os handlers no topo, então a falha
 * de UM (este) impedia os outros 17 de se registrarem, incluindo
 * `aiResponseHandler` (a resposta da IA). Com o import preguiçoso, uma falha
 * aqui vira `status: "error"` só NESTE handler — os demais registram normal.
 */

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

export const LGPD_EXPORT_HANDLER_KEY = "lgpd-export-worker.v1";

export const lgpdExportHandler: EventHandler = {
  key: LGPD_EXPORT_HANDLER_KEY,
  events: ["lgpd.data_request_received"],
  async handle(row: EventRow): Promise<HandlerResult> {
    const { processLgpdExport } = await import("@/workers/lgpd-export-worker");
    return processLgpdExport(row);
  },
};
