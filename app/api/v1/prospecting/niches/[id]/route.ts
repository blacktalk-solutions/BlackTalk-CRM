import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/prospecting/niches/[id] — T7 do plano
 * `.specs/features/prospeccao-nichos-e-enriquecimento/` (design.md "API").
 *
 * Edição parcial de um nicho já existente. Nota DIRC (design.md, "Data
 * Models"): `prospected_searches.service_type` é uma CÓPIA do `service_type`
 * do nicho no momento da busca, não um join ao vivo — editar um nicho aqui
 * NUNCA muda `score_initial`/`score_final`/`service_type` de uma busca já
 * feita. Este handler é um `UPDATE` simples, sem nenhum trigger de
 * recomputo — é a ausência de recomputo, não uma lógica extra, que garante
 * essa invariante (por isso não há teste "roda recompute" aqui: não existe
 * recompute pra rodar).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { prospectingNicheUpdateSchema } from "@/lib/schemas/prospecting";
import { createAdminClient } from "@/lib/supabase/admin";

import { checkWeightsSum, toNicheDTO, NICHE_SELECT_COLUNAS, type NicheRow } from "../route";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("manager", { requestId, resource: "prospecting_niches" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = prospectingNicheUpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail(
      "validation_error",
      t(parsed.error.issues[0]?.message ?? "Corpo inválido."),
      422,
      { requestId, details: { fieldErrors: parsed.error.flatten().fieldErrors } },
    );
  }
  const input = parsed.data;

  if (input.weights) {
    const somaInvalida = checkWeightsSum(input.weights, requestId);
    if (somaInvalida) return somaInvalida;
  }

  // Monta o patch só com o que veio no body — mesmo espírito de
  // `app/api/v1/agenda/tipos/route.ts` (PATCH): recusa em vez de UPDATE
  // vazio, "alterei" sobre nada é a mesma família de mentira do "Marcado ✓"
  // sem linha no banco.
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.serviceType !== undefined) patch.service_type = input.serviceType;
  if (input.searchTerms !== undefined) patch.search_terms = input.searchTerms;
  if (input.requirements !== undefined) patch.requirements = input.requirements;
  if (input.weights !== undefined) patch.weights = input.weights;

  if (Object.keys(patch).length === 0) {
    return fail("validation_error", t("Nenhum campo para alterar."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("prospecting_niches")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(NICHE_SELECT_COLUNAS)
    .maybeSingle();

  if (error) {
    // 23503 (FK) não se aplica a um UPDATE de nicho — não há FK que este
    // patch possa violar (search_terms é array de texto, não referência).
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Nicho não encontrado."), 404, { requestId });
  }

  const niche = data as unknown as NicheRow;

  void audit({
    action: "prospecting.niche_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "prospecting_niche",
    resourceId: niche.id,
    requestId,
    metadata: { campos: Object.keys(patch) },
  });

  return ok(toNicheDTO(niche), { requestId });
}
