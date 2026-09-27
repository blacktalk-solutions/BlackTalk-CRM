/**
 * GET /api/v1/prospecting/searches/[id] — T5 do plano
 * `.specs/features/prospeccao-google-maps/` (design.md "API": "reabre uma
 * busca persistida (também serve de fallback se Realtime cair: client pode
 * dar poll nela)").
 *
 * Reabre uma busca já persistida (a busca + TODAS as `prospected_places`
 * associadas), sem nova chamada à Google Places API. Leitura pura: nenhuma
 * escrita, nenhuma chamada externa — por isso não passa por
 * `requireSupportWrite()` (esse gate é só pra rota de ESCRITA; mesmo
 * raciocínio do GET de `app/api/v1/contacts/[id]/route.ts` e do GET de
 * `app/api/v1/ai/knowledge/sources/[id]/route.ts`, nenhum dos dois chama).
 *
 * Assinatura do handler (`{ params }: { params: Promise<{ id: string }> }`,
 * `params` como Promise) confirmada em
 * `app/api/v1/ai/knowledge/sources/[id]/route.ts` (GET) — essa mesma rota
 * também é o modelo do "não encontrado" abaixo: filtra por
 * `organization_id` ALÉM da RLS e usa `maybeSingle()` + `fail("not_found",
 * ...)`, de forma que "não existe" e "é de outra organização" cheguem
 * exatamente na mesma resposta (design.md, Error Handling Strategy: "Tenant
 * B tentando acessar busca/lugar do tenant A → RLS bloqueia (0 linhas) →
 * 404, mesmo padrão de `app/app/leads/[id]`: não revelar diferença entre
 * 'não existe' e 'não é seu'").
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import {
  PLACES_SELECT_COLUNAS,
  SEARCH_SELECT_COLUNAS,
  toPlaceDTO,
  toSearchDTO,
  type ProspectedPlaceRow,
  type ProspectedSearchRow,
} from "../route";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: searchId } = await params;

  // Mesmo gate do POST/GET (lista) do arquivo irmão: reabrir uma busca é a
  // mesma classe de ação de manager+ que disparar/listar buscas.
  const authz = await requireRole("manager", { requestId, resource: "prospected_searches" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const supabase = await createClient();

  // Filtro explícito por organization_id ALÉM da RLS (que já bloqueia
  // cross-tenant sozinha via tenant_isolation_prospected_searches_all): é
  // isso que faz `maybeSingle()` devolver null TANTO pra "não existe" QUANTO
  // pra "é de outra organização" — sem os dois casos precisarem de
  // tratamento diferente na resposta (ver cabeçalho do arquivo).
  const { data: search, error: searchErr } = await supabase
    .from("prospected_searches")
    .select(SEARCH_SELECT_COLUNAS)
    .eq("id", searchId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (searchErr) {
    return fail("internal_error", searchErr.message, 500, { requestId });
  }
  if (!search) {
    return fail("not_found", t("Busca não encontrada."), 404, { requestId });
  }

  // Mesma dupla razão de organization_id explícito acima — prospected_places
  // também tem organization_id denormalizado (design.md: "mesmo padrão de
  // crm_leads") justamente pra RLS/filtro não precisarem de join até
  // prospected_searches.
  const { data: places, error: placesErr } = await supabase
    .from("prospected_places")
    .select(PLACES_SELECT_COLUNAS)
    .eq("search_id", searchId)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (placesErr) {
    return fail("internal_error", placesErr.message, 500, { requestId });
  }

  const searchRow = search as unknown as ProspectedSearchRow;
  const placeRows = (places ?? []) as unknown as ProspectedPlaceRow[];

  return ok(
    { search: toSearchDTO(searchRow), places: placeRows.map(toPlaceDTO) },
    { requestId },
  );
}
