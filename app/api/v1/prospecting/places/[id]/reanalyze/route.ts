/**
 * POST /api/v1/prospecting/places/[id]/reanalyze — T11 (manual retry)
 *
 * Retries site analysis for a failed prospected place. Only allowed when
 * `site_analysis_status === 'failed'`. Marks the place back to 'pending' and
 * emits a new `prospected_place.site_quality_requested` event for the worker
 * to process again.
 *
 * Reuses the same event-emission mechanism from T4 (searches/route.ts).
 */

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  PLACES_SELECT_COLUNAS,
  type ProspectedPlaceRow,
} from "../../../searches/route";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: placeId } = await params;

  // Same gate as T4 (search creation): manager+ to trigger analysis
  const authz = await requireRole("manager", { requestId, resource: "prospected_places" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const admin = createAdminClient();

  // Fetch the place: explicit organization_id filter + RLS makes cross-tenant
  // access return 404 (same pattern as searches/[id]/route.ts)
  const { data: place, error: fetchErr } = await admin
    .from("prospected_places")
    .select(PLACES_SELECT_COLUNAS)
    .eq("id", placeId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", fetchErr.message, 500, { requestId });
  }

  if (!place) {
    return fail("not_found", t("Lugar não encontrado."), 404, { requestId });
  }

  const placeRow = place as unknown as ProspectedPlaceRow;

  // Only allow reanalysis if the place failed analysis
  if (placeRow.site_analysis_status !== "failed") {
    return fail(
      "not_reanalyzable",
      t(
        "Este lugar não pode ser analisado novamente. Só é possível tentar novamente quando a análise falhou."
      ),
      409,
      { requestId }
    );
  }

  // Emit the event BEFORE updating status, so if emit fails we don't strand
  // the row at 'pending' with no event queued (see finding #5).
  const emitResult = await admin.rpc("emit_event", {
    p_event_type: "prospected_place.site_quality_requested",
    p_entity_kind: "prospected_place",
    p_entity_id: placeRow.id,
    p_payload: {
      prospected_place_id: placeRow.id,
      search_id: placeRow.search_id,
      place_id: placeRow.place_id,
      website_url: placeRow.website_url,
    },
    p_metadata: { request_id: requestId, actor_user_id: user.id },
    p_organization_id: org.orgId,
  });

  if (emitResult.error) {
    console.error("[prospecting.reanalyze] emit_event falhou", {
      prospectedPlaceId: placeId,
      error: emitResult.error.message,
    });
    // Emit failed: don't update status to 'pending', leave it at 'failed'
    // so the operator can retry via the "Tentar de novo" button.
    return fail(
      "emit_event_failed",
      t("Falha ao emitir evento de análise. Tente novamente."),
      500,
      { requestId }
    );
  }

  // Event emitted successfully: now update status to pending. CAS guard
  // (mesmo padrão do claim otimista do worker, prospecting-site-quality-worker.ts) —
  // só avança se a linha ainda estiver 'failed'. Sem essa guarda, o worker (loop
  // rápido, não cron) poderia processar o evento recém-emitido e gravar
  // 'processing'/'done' ANTES desse update rodar; um update incondicional
  // sobrescreveria isso de volta pra 'pending', perdendo uma análise que já
  // tinha terminado com sucesso, sem chance de recuperação automática.
  const { data: updated, error: updateErr } = await admin
    .from("prospected_places")
    .update({ site_analysis_status: "pending" })
    .eq("id", placeId)
    .eq("organization_id", org.orgId)
    .eq("site_analysis_status", "failed")
    .select("id");

  if (updateErr) {
    return fail(
      "internal_error",
      updateErr.message ?? t("Erro ao atualizar o lugar."),
      500,
      { requestId }
    );
  }

  if (!updated?.length) {
    // O worker já ganhou a corrida e avançou a linha (pra 'processing'/'done')
    // entre o emit_event acima e este update — não é erro, é uma análise que já
    // está em andamento ou já terminou. Trata como sucesso: nada a reverter.
    return ok({ id: placeId, status: "already_progressed" }, { status: 200, requestId });
  }

  void audit({
    action: "prospecting.place_reanalyze",
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
