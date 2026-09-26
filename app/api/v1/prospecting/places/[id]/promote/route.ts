/**
 * POST /api/v1/prospecting/places/[id]/promote — T12
 *
 * Promove um resultado de prospeccão (linha de prospected_places) para o funil
 * do CRM (cria contact + lead + links, atualiza prospected_places).
 *
 * Padrão: `requireRole('manager')`, resolução de organização, 404
 * indistinguível, `audit()`, mesmas convenções de outras rotas desta feature.
 */

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { promoteToLead } from "@/lib/prospecting/promote";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: placeId } = await params;

  const authz = await requireRole("manager", {
    requestId,
    resource: "prospected_places",
  });
  if (!authz.ok) return authz.response;

  const { user, org } = authz;
  const admin = createAdminClient();

  // Garante que o resultado existe E pertence à organização (RLS já protege,
  // mas o gate 404 indistinguível evita de-anonimizar a existência de um
  // resultado).
  const { data: place, error: placeCheckErr } = await admin
    .from("prospected_places")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("id", placeId)
    .maybeSingle();

  if (placeCheckErr || !place) {
    // 404 indistinguível (mesmo resultado de "não existe" e "não é seu")
    return fail("not_found", "Resultado de prospeccão não encontrado.", 404, { requestId });
  }

  // Chama a lógica de promoção
  const resultado = await promoteToLead(admin, org.orgId, placeId);

  if (!resultado.promotado) {
    const { motivo, detalhe } = resultado;

    // Map motivos to HTTP status codes
    let status: number;
    let msg: string;

    switch (motivo) {
      case "ja_promovido":
        status = 409; // Conflict: já foi promovido
        msg = "Este resultado já foi promovido para o funil.";
        break;

      case "sem_pipeline_default":
        status = 422; // Unprocessable Entity: erro de config da org
        msg = "Organização não tem um funil padrão configurado.";
        break;

      case "sem_etapa":
        status = 422; // Unprocessable Entity: erro de config da org
        msg = "Funil padrão não tem etapas configuradas.";
        break;

      case "erro":
      default:
        status = 500; // Internal Server Error
        msg = "Erro ao promover resultado para o funil.";
        break;
    }

    return fail(motivo, msg, status, { requestId, details: detalhe });
  }

  // Sucesso: emite audit e retorna leadId
  void audit({
    action: "prospecting.place_promoted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "crm_lead",
    resourceId: resultado.leadId,
    requestId,
    metadata: {
      prospected_place_id: placeId,
    },
  });

  return ok({ leadId: resultado.leadId }, { status: 201, requestId });
}
