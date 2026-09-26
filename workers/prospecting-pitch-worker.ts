/**
 * Consome `prospected_place.pitch_requested` — gera por IA a "venda que
 * cabe" (`justificativa_oportunidade`) e, quando há Instagram confirmado, os
 * "ganchos de abordagem" (`abordagem_instagram`) pra um `prospected_places`.
 *
 * Gatilho MANUAL (rota `app/api/v1/prospecting/places/[placeId]/pitch/route.ts`),
 * nunca automático por resultado — uma busca pode trazer centenas de
 * resultados, e gerar texto por IA em todos seria custo não controlado pro
 * self-hoster (mesma doutrina de `AUDIT_LOG_RETENTION_DAYS`/`APIFY_TOKEN`:
 * nada de custo obrigatório surpresa). Ver o cabeçalho da migration 0238.
 *
 * Estrutura de claim otimista IDÊNTICA aos 3 workers irmãos
 * (`prospecting-site-quality-worker.ts`, `prospecting-cnpj-worker.ts`,
 * `prospecting-instagram-worker.ts`) — mesmo guard por status, mesmo
 * try/catch que nunca deixa exceção escapar sem gravar `'failed'`, mesmo
 * motivo pra devolver `status: "ok"` mesmo depois de 'failed' (evita retry
 * automático do drain; reprocessar é o botão "gerar de novo" na ficha).
 *
 * Diferença dos 3 irmãos: a checagem de `isAiGatewayConfigured()` roda ANTES
 * do claim otimista — a rota que emite este evento já confere a mesma coisa
 * antes de emitir, então chegar aqui sem chave configurada só aconteceria se
 * a chave foi removida entre o clique e o dreno do evento (defesa em
 * profundidade, não o caminho esperado); não faz sentido reivindicar
 * 'processing' pra imediatamente desistir.
 *
 * Telemetria de custo (`lib/ai/log-invocation.ts`) deliberadamente FORA de
 * escopo aqui: o `InvocationKind` daquele módulo é um vocabulário fechado
 * espelhando o CHECK de `ai_invocations.invocation_kind` (não de `llm_calls`,
 * que recebeu a escrita mas não o CHECK — ver `tests/invariants/
 * vocabulario-banco-x-typescript.test.ts`), e `ai_invocations` ainda dispara
 * `trg_ai_invocations_budget` — mexer nesse vocabulário sem medir o efeito no
 * orçamento fica pra quando este worker precisar entrar na tela de custo de
 * IA, não como efeito colateral do redesenho da ficha.
 */
import { generateObject } from "ai";
import { z } from "zod";

import { DEFAULT_BOT_MODEL, isAiGatewayConfigured, resolveLanguageModel } from "@/lib/ai/gateway";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const PROSPECTING_PITCH_CONSUMER_KEY = "prospecting_pitch_v1";

const PITCH_SYSTEM_PROMPT = `Você é um vendedor consultivo brasileiro, especialista em vender serviços de marketing digital (sites, tráfego pago, automação) para pequenas e médias empresas locais.

Escreva SEMPRE em português do Brasil, direto e específico — nunca genérico. Ancore o argumento nas LACUNAS reais que foram encontradas (site fora do ar, sem pixel, sem WhatsApp, rodapé antigo, sem Instagram etc.), nunca invente um dado que não foi informado.

"justificativaOportunidade": 2 a 3 frases, a MELHOR abordagem comercial pra esta empresa específica — o que vender primeiro e por quê, baseado nas lacunas encontradas.

"abordagemInstagram": só preencha se houver dados de Instagram informados — 2 a 3 ganchos curtos e específicos (baseados na bio, no engajamento, ou nos dias sem postar) pra puxar assunto na abordagem. Sem dados de Instagram, devolva null.`;

const pitchSchema = z.object({
  justificativaOportunidade: z
    .string()
    .max(600)
    .describe("2 a 3 frases: a melhor abordagem comercial pra esta empresa, ancorada nas lacunas encontradas"),
  abordagemInstagram: z
    .string()
    .max(500)
    .nullable()
    .describe("2 a 3 ganchos curtos pra abordagem no Instagram, ou null quando não há dados de Instagram"),
});

interface ProspectedPlaceForPitch {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  score_final: number | null;
  score_initial: number;
  status_label: string;
  website_url: string | null;
  site_analysis_status: string;
  site_analysis_result: Record<string, unknown> | null;
  cnpj_data: Record<string, unknown> | null;
  instagram_data: Record<string, unknown> | null;
  oportunidade_pitch_status: string;
}

/** Resume o raio-x do site em texto curto pro prompt — lacunas primeiro, é o que vira argumento. */
function resumoRaioX(status: string, result: Record<string, unknown> | null): string {
  if (status !== "done" || !result) return "site ainda não analisado";
  if (result.reachable === false) return "site cadastrado no Maps está FORA DO AR";
  const lacunas: string[] = [];
  if (result.mobileResponsive === false) lacunas.push("sem versão para celular");
  if (!result.hasWhatsappButton) lacunas.push("sem botão de WhatsApp");
  if (!result.hasMetaPixel) lacunas.push("sem pixel da Meta (não anuncia no Instagram)");
  if (!result.hasGoogleAdsPixel) lacunas.push("sem tag do Google Ads");
  if (!result.hasGoogleAnalytics) lacunas.push("sem Google Analytics");
  if (result.desatualizado) lacunas.push(`rodapé desatualizado (ano ${result.copyrightYear ?? "não achado"})`);
  return lacunas.length ? `lacunas no site: ${lacunas.join("; ")}` : "site passou em todos os testes de marketing";
}

function resumoCnpj(data: Record<string, unknown> | null): string {
  if (!data || typeof data.razaoSocial !== "string") return "CNPJ não confirmado";
  const porte = typeof data.porte === "string" ? data.porte : null;
  const abertura = typeof data.abertura === "string" ? data.abertura : null;
  return `empresa "${data.razaoSocial}"${porte ? `, porte ${porte}` : ""}${abertura ? `, aberta em ${abertura}` : ""}`;
}

function resumoInstagram(data: Record<string, unknown> | null): { texto: string; temPerfil: boolean } {
  if (!data || typeof data.seguidores !== "number") {
    return { texto: "sem perfil de Instagram confirmado", temPerfil: false };
  }
  const bio = typeof data.bio === "string" && data.bio ? ` bio: "${data.bio}".` : "";
  const dias = typeof data.diasSemPostar === "number" ? ` ${data.diasSemPostar} dias sem postar.` : "";
  return {
    texto: `Instagram com ${data.seguidores} seguidores.${bio}${dias}`,
    temPerfil: true,
  };
}

function buildPrompt(place: ProspectedPlaceForPitch): { prompt: string; temInstagram: boolean } {
  const score = place.score_final ?? place.score_initial;
  const instagram = resumoInstagram(place.instagram_data);
  const linhas = [
    `Empresa: ${place.name}`,
    place.address ? `Endereço: ${place.address}` : null,
    `Nota da prospecção: ${score}/100 (${place.status_label})`,
    place.website_url ? resumoRaioX(place.site_analysis_status, place.site_analysis_result) : "sem site divulgado no Google Maps",
    resumoCnpj(place.cnpj_data),
    instagram.texto,
  ].filter((l): l is string => Boolean(l));
  return { prompt: linhas.join("\n"), temInstagram: instagram.temPerfil };
}

/**
 * Handler principal — mesma assinatura `(row: EventRow) => Promise<HandlerResult>`
 * dos 3 workers irmãos de enriquecimento.
 */
export async function generateProspectPitch(row: EventRow): Promise<HandlerResult> {
  const consumer_key = PROSPECTING_PITCH_CONSUMER_KEY;

  const prospectedPlaceId =
    (row.payload.prospected_place_id as string | undefined) ?? row.entity_id ?? undefined;
  if (!prospectedPlaceId) {
    return { consumer_key, status: "skipped", detail: "no prospected_place_id" };
  }

  const admin = createAdminClient();

  try {
    const { data, error } = await admin
      .from("prospected_places")
      .select(
        "id, organization_id, name, address, score_final, score_initial, status_label, website_url, " +
          "site_analysis_status, site_analysis_result, cnpj_data, instagram_data, oportunidade_pitch_status",
      )
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (error) return { consumer_key, status: "error", detail: error.message };

    const place = data as ProspectedPlaceForPitch | null;
    if (!place) return { consumer_key, status: "skipped", detail: "prospected_place not found" };

    // ─── GUARD DE IDEMPOTÊNCIA (mesmo padrão dos outros 3 workers) ─────────
    if (place.oportunidade_pitch_status === "done" || place.oportunidade_pitch_status === "processing") {
      return { consumer_key, status: "skipped", detail: `already ${place.oportunidade_pitch_status}` };
    }

    // Checado ANTES do claim — ver nota de topo do arquivo.
    const model = isAiGatewayConfigured() ? resolveLanguageModel(DEFAULT_BOT_MODEL) : null;
    if (!model) {
      logger.warn("[prospecting-pitch] sem chave de IA configurada no momento do dreno", {
        prospected_place_id: place.id,
      });
      const { error: failErr } = await admin
        .from("prospected_places")
        .update({ oportunidade_pitch_status: "failed" })
        .eq("id", place.id)
        .eq("organization_id", place.organization_id)
        .eq("oportunidade_pitch_status", place.oportunidade_pitch_status);
      if (failErr) return { consumer_key, status: "error", detail: failErr.message };
      return { consumer_key, status: "ok" };
    }

    // Claim otimista — CAS por `oportunidade_pitch_status`.
    const { data: claimed, error: claimErr } = await admin
      .from("prospected_places")
      .update({ oportunidade_pitch_status: "processing" })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id)
      .eq("oportunidade_pitch_status", place.oportunidade_pitch_status)
      .select("id");
    if (claimErr) return { consumer_key, status: "error", detail: claimErr.message };
    if (!claimed?.length) {
      return { consumer_key, status: "skipped", detail: "concurrent claim lost" };
    }

    const { prompt, temInstagram } = buildPrompt(place);

    const generated = await generateObject({
      model,
      schema: pitchSchema,
      system: PITCH_SYSTEM_PROMPT,
      prompt,
      temperature: 0.4,
      maxOutputTokens: 500,
    });

    const { error: updErr } = await admin
      .from("prospected_places")
      .update({
        oportunidade_pitch_status: "done",
        justificativa_oportunidade: generated.object.justificativaOportunidade,
        // Sem Instagram confirmado, nunca grava um gancho — mesmo com o
        // modelo tentando preencher (instrução do prompt reforça null, mas
        // não confiamos só nela).
        abordagem_instagram: temInstagram ? generated.object.abordagemInstagram : null,
        oportunidade_pitch_gerado_em: new Date().toISOString(),
      })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id);
    if (updErr) throw new Error(`update (done) failed: ${updErr.message}`);

    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting-pitch] geração falhou", {
      prospected_place_id: prospectedPlaceId,
      detail,
    });

    const { error: failErr } = await admin
      .from("prospected_places")
      .update({ oportunidade_pitch_status: "failed" })
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id);

    if (failErr) {
      logger.error("[prospecting-pitch] gravação de 'failed' também falhou", {
        prospected_place_id: prospectedPlaceId,
        detail: failErr.message,
      });
      return { consumer_key, status: "error", detail: `${detail}; also failed to persist: ${failErr.message}` };
    }

    // Mesma razão dos outros 3 workers: "ok" marca o evento como consumido,
    // sem retry automático do drain sobre uma geração que falhou.
    return { consumer_key, status: "ok" };
  }
}
