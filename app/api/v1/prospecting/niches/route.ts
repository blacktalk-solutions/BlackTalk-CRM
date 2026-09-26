import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST/GET /api/v1/prospecting/niches — T7 do plano
 * `.specs/features/prospeccao-nichos-e-enriquecimento/` (design.md "API").
 *
 * CRUD de nicho — critério configurável por organização (termos, requisitos,
 * pesos) que substitui o `serviceType` fixo (`"venda_de_site"`) da feature
 * anterior. `PATCH /[id]` fica em `[id]/route.ts` (edição, T7 também).
 *
 * Pesos somando 100 é regra de NEGÓCIO, não de forma — checada aqui, depois
 * do Zod (que só valida 0-100 por campo), porque a recusa precisa de um
 * `code` próprio (`weights_not_100`) e mostrar o total, coisa que o caminho
 * automático de erro Zod (`422 validation_error` genérico) não devolve.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  prospectingNicheCreateSchema,
  sumNicheWeights,
  type ProspectingNicheCreateInput,
} from "@/lib/schemas/prospecting";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Tolerância de ponto flutuante — pesos são números, `99.999999999` não deveria recusar por arredondamento de IEEE754. */
const TOLERANCIA_SOMA = 0.01;

/** Forma de uma linha de `prospecting_niches` como o `.select()` devolve. */
export interface NicheRow {
  id: string;
  name: string;
  service_type: string;
  search_terms: string[];
  requirements: Record<string, unknown>;
  weights: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** DTO de resposta — mesmo shape camelCase das outras rotas de prospecção. */
export interface NicheDTO {
  id: string;
  name: string;
  serviceType: string;
  searchTerms: string[];
  requirements: Record<string, unknown>;
  weights: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function toNicheDTO(row: NicheRow): NicheDTO {
  return {
    id: row.id,
    name: row.name,
    serviceType: row.service_type,
    searchTerms: row.search_terms,
    requirements: row.requirements,
    weights: row.weights,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const NICHE_SELECT_COLUNAS = "id, name, service_type, search_terms, requirements, weights, created_at, updated_at";

/**
 * `400 weights_not_100` quando a soma dos 9 pesos não fecha em 100 — o mesmo
 * check serve `POST` (aqui) e `PATCH` (`[id]/route.ts`), por isso é exportado.
 */
export function checkWeightsSum(
  weights: ProspectingNicheCreateInput["weights"],
  requestId: string,
): Response | null {
  const total = sumNicheWeights(weights);
  if (Math.abs(total - 100) > TOLERANCIA_SOMA) {
    return fail(
      "weights_not_100",
      `Os pesos somam ${total}, mas precisam somar 100.`,
      400,
      { requestId, details: { total } },
    );
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Criar nicho muda o critério que TODA busca futura da organização vai
  // usar (design.md, Tech Decisions) — mesmo piso manager+ da busca em si.
  const authz = await requireRole("manager", { requestId, resource: "prospecting_niches" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = prospectingNicheCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail(
      "validation_error",
      t(parsed.error.issues[0]?.message ?? "Corpo inválido."),
      422,
      { requestId, details: { fieldErrors: parsed.error.flatten().fieldErrors } },
    );
  }
  const input = parsed.data;

  const somaInvalida = checkWeightsSum(input.weights, requestId);
  if (somaInvalida) return somaInvalida;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("prospecting_niches")
    .insert({
      organization_id: org.orgId,
      name: input.name,
      service_type: input.serviceType,
      search_terms: input.searchTerms,
      requirements: input.requirements,
      weights: input.weights,
      created_by: user.id,
    })
    .select(NICHE_SELECT_COLUNAS)
    .single();

  if (error || !data) {
    return fail("internal_error", error?.message ?? t("Erro ao criar o nicho."), 500, { requestId });
  }

  const niche = data as unknown as NicheRow;

  void audit({
    action: "prospecting.niche_created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "prospecting_niche",
    resourceId: niche.id,
    requestId,
    metadata: { name: input.name, service_type: input.serviceType, weights: input.weights },
  });

  return ok(toNicheDTO(niche), { status: 201, requestId });
}

/**
 * GET — lista os nichos da organização ATIVA (RLS já restringe às
 * organizações de que o usuário é membro; o `.eq` abaixo restringe mais um
 * passo, mesmo padrão de `app/api/v1/prospecting/searches/route.ts`).
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "prospecting_niches" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_niches")
    .select(NICHE_SELECT_COLUNAS)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = (data ?? []) as unknown as NicheRow[];
  return ok(rows.map(toNicheDTO), { requestId });
}
