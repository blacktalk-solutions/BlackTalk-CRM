/**
 * Achado em produção (2026-09-28): `@/workers/rag-indexer` e
 * `@/workers/lgpd-export-worker` puxam `@react-pdf/renderer`, cuja dependência
 * transitiva `@react-pdf/hyphenate` falhava ao resolver um subpath na imagem
 * publicada (`Package subpath './en-us' is not defined by "exports"`).
 *
 * `register-handlers.ts` importava os DOIS handlers no topo do módulo — import
 * ESTÁTICO. A falha de UM deles derrubava o `import` do arquivo inteiro, e como
 * é o mesmo arquivo que registra `aiResponseHandler` (quem dispara a resposta
 * da IA a mensagem recebida), a IA inteira caía para o cron `event-log-drain`
 * (1×/min, com múltiplos saltos encadeados) — o sintoma medido foi resposta
 * chegando minutos depois, não segundos.
 *
 * A correção: `rag-indexer.handler.ts` e `lgpd-export-worker.handler.ts` agora
 * importam sua implementação PREGUIÇOSAMENTE, dentro de `handle()` — uma
 * falha ali vira `status: "error"` só NAQUELE handler (o dispatcher já
 * envolve cada `handle()` em try/catch, `lib/event-log/dispatcher.ts`).
 *
 * Este teste prova a propriedade que importa: mesmo com a implementação de
 * `rag-indexer` QUEBRADA na importação, `ensureHandlersRegistered()` continua
 * registrando TODOS os handlers — incluindo `aiResponseHandler`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workers/rag-indexer", () => {
  throw new Error(
    "Package subpath './en-us' is not defined by \"exports\" in .../@react-pdf/hyphenate/package.json",
  );
});

describe("registro de handlers sobrevive a um import quebrado", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/workers/rag-indexer");
  });

  it("ensureHandlersRegistered() não lança mesmo com @/workers/rag-indexer quebrado no import", async () => {
    const { ensureHandlersRegistered } = await import("@/lib/event-log/register-handlers");
    expect(() => ensureHandlersRegistered()).not.toThrow();
  });

  it("aiResponseHandler (dispara a resposta da IA) continua registrado mesmo com rag-indexer quebrado", async () => {
    const { ensureHandlersRegistered } = await import("@/lib/event-log/register-handlers");
    const { getRegisteredHandlers } = await import("@/lib/event-log/dispatcher");
    const { AI_RESPONSE_HANDLER_KEY } = await import("@/workers/ai-response-worker.handler");

    ensureHandlersRegistered();

    const chaves = getRegisteredHandlers().map((h) => h.key);
    expect(chaves).toContain(AI_RESPONSE_HANDLER_KEY);
  });
});
