/**
 * Relógio local SÓ da análise de site da prospecção (P2, Playwright).
 *
 * Por que isto existe em vez de `pnpm worker` ou `pnpm dev:crons`: os dois
 * consomem `event_log`/`job_queue` por INTEIRO — inclusive os handlers do
 * agente de IA (WhatsApp). Rodar qualquer um dos dois localmente contra o
 * MESMO Supabase de produção cria um segundo consumidor competindo com o que
 * já roda lá (turno duplicado ou perdido — o mesmo risco documentado em
 * `scripts/dev-crons.ts`). Este script nunca toca `event_log`/`job_queue`:
 * lê e escreve só `prospected_places`, chamando o handler direto.
 *
 * Só processa `pending` (nunca lançado ainda) — de propósito NÃO reprocessa
 * `failed` sozinho: reprocessar automático bateria no mesmo site quebrado
 * sem parar, e o reprocessamento intencional desta feature já é manual, via
 * o botão "Tentar de novo" na tela (mesma doutrina do handler original).
 *
 * Uso (app já no ar):
 *   pnpm dev:prospeccao-worker
 */
import { analyzeProspectSiteQuality } from "../workers/prospecting-site-quality-worker";
import { createAdminClient } from "../lib/supabase/admin";

const POLL_INTERVAL_MS = Number(process.env.DEV_PROSPECCAO_WORKER_INTERVAL_MS ?? "5000");

function supabaseHost(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || "(sem URL)";
  } catch {
    return "(URL inválida)";
  }
}

async function tick(): Promise<void> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("prospected_places")
    .select("id, organization_id, website_url")
    .eq("site_analysis_status", "pending")
    .not("website_url", "is", null);

  if (error) {
    console.error("[dev-prospeccao-worker] erro ao listar pendentes:", error.message);
    return;
  }

  for (const row of data ?? []) {
    console.info(`[dev-prospeccao-worker] analisando ${row.id} (${row.website_url})`);
    const result = await analyzeProspectSiteQuality({
      id: "dev-prospeccao-worker",
      organization_id: row.organization_id,
      event_type: "prospected_place.site_quality_requested",
      entity_kind: "prospected_place",
      entity_id: row.id,
      payload: { prospected_place_id: row.id },
      metadata: {},
      consumed_by: [],
      attempts: 0,
    });
    console.info(`[dev-prospeccao-worker]   -> ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
  }
}

async function main(): Promise<void> {
  console.info("[dev-prospeccao-worker] banco (Supabase)", supabaseHost());
  console.info(`[dev-prospeccao-worker] intervalo ${POLL_INTERVAL_MS}ms — Ctrl+C encerra`);

  await tick();
  setInterval(() => {
    void tick().catch((err: unknown) => {
      console.error("[dev-prospeccao-worker] tick falhou:", err);
    });
  }, POLL_INTERVAL_MS);
}

main();
