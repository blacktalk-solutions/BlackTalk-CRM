/**
 * POST /api/v1/prospecting/places/[id]/pitch — geração por IA da "venda que
 * cabe" (`justificativa_oportunidade`) + ganchos de Instagram
 * (`abordagem_instagram`), migration 0238.
 *
 * Gatilho MANUAL — nunca disparado em massa pela busca (diferente de
 * `cnpj_requested`/`instagram_requested`, T8): uma busca pode trazer
 * centenas de resultados, e gerar texto por IA em todos seria custo não
 * controlado pro self-hoster. Só quem abre a ficha e clica no botão paga
 * a chamada. Ver o cabeçalho da migration 0238 e de
 * `workers/prospecting-pitch-worker.ts`.
 *
 * Mesmo formato de `../reanalyze/route.ts`: emite o evento ANTES de
 * atualizar o status (se o emit falhar, a linha não fica travada em
 * `pending` sem evento na fila), depois faz o CAS de status com `.select()`
 * pra saber se ganhou a corrida — sem CAS, um clique duplo emitiria dois
 * eventos e o segundo `update` incondicional poderia sobrescrever um
 * `'processing'`/`'done'` que o worker já tinha alcançado.
 */

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { isAiGatewayConfigured } from "@/lib/ai/gateway";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface PlaceForPitchRoute {
  id: string;
  search_id: string;
  place_id: string;
  organization_id: string;
  oportunidade_pitch_status: string;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: placeId } = await params;

  // Mesmo piso de `reanalyze`/T4 (busca): gerar por IA custa dinheiro — manager+.
  const authz = await requireRole("manager", { requestId, resource: "prospected_places" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  if (!isAiGatewayConfigured()) {
    // Feedback imediato, sem passar pelo ciclo pending→failed do event_log —
    // mesmo padrão defensivo do aviso de APIFY_TOKEN em NicheWizard.tsx, só
    // que aqui a ação inteira é bloqueada em vez de degradar um peso.
    return fail(
      "ai_gateway_not_configured",
      t("Nenhuma chave de IA configurada no servidor. Configure AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY ou OPENROUTER_API_KEY."),
      503,
      { requestId },
    );
  }

  const admin = createAdminClient();

  const { data: place, error: fetchErr } = await admin
    .from("prospected_places")
    .select("id, search_id, place_id, organization_id, oportunidade_pitch_status")
    .eq("id", placeId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", fetchErr.message, 500, { requestId });
  }
  if (!place) {
    return fail("not_found", t("Lugar não encontrado."), 404, { requestId });
  }

  const placeRow = place as PlaceForPitchRoute;

  // pending/processing: já em voo — no-op idempotente, não emite de novo.
  if (placeRow.oportunidade_pitch_status === "pending" || placeRow.oportunidade_pitch_status === "processing") {
    return ok({ id: placeId, status: placeRow.oportunidade_pitch_status }, { status: 200, requestId });
  }
  // done: já gerado — reprocessar é uma decisão explícita (mesmo motivo de
  // reanalyze só aceitar 'failed'), mas aqui aceitamos regenerar mesmo com
  // 'done' porque não há um botão "tentar de novo" separado — o próprio botão
  // "gerar sugestão de venda" vira "gerar de novo" na ficha quando falha, e
  // 'done' não bloqueia porque o operador pode querer uma sugestão nova depois
  // de mais enriquecimento chegar (CNPJ/Instagram concluídos depois do 1º pitch).

  const emitResult = await admin.rpc("emit_event", {
    p_event_type: "prospected_place.pitch_requested",
    p_entity_kind: "prospected_place",
    p_entity_id: placeRow.id,
    p_payload: {
      prospected_place_id: placeRow.id,
      search_id: placeRow.search_id,
      place_id: placeRow.place_id,
    },
    p_metadata: { request_id: requestId, actor_user_id: user.id },
    p_organization_id: org.orgId,
  });

  if (emitResult.error) {
    console.error("[prospecting.pitch] emit_event falhou", {
      prospectedPlaceId: placeId,
      error: emitResult.error.message,
    });
    return fail("emit_event_failed", t("Falha ao emitir evento de geração. Tente novamente."), 500, { requestId });
  }

  // CAS: só avança se ainda estiver no status que acabamos de ler (evita
  // sobrescrever um 'processing'/'done' que o worker já alcançou entre o
  // emit acima e este update).
  const { data: updated, error: updateErr } = await admin
    .from("prospected_places")
    .update({ oportunidade_pitch_status: "pending" })
    .eq("id", placeId)
    .eq("organization_id", org.orgId)
    .eq("oportunidade_pitch_status", placeRow.oportunidade_pitch_status)
    .select("id");

  if (updateErr) {
    return fail("internal_error", updateErr.message ?? t("Erro ao atualizar o lugar."), 500, { requestId });
  }

  if (!updated?.length) {
    return ok({ id: placeId, status: "already_progressed" }, { status: 200, requestId });
  }

  void audit({
    action: "prospecting.place_pitch_generate",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "prospected_place",
    resourceId: placeId,
    requestId,
    metadata: {
      search_id: placeRow.search_id,
      place_id: placeRow.place_id,
    },
  });

  return ok({ id: placeId, status: "pending" }, { status: 200, requestId });
}
