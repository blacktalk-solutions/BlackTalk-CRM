import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import {
  PLACES_SELECT_COLUNAS,
  SEARCH_SELECT_COLUNAS,
  toPlaceDTO,
  toSearchDTO,
  type ProspectedPlaceRow,
  type ProspectedSearchRow,
} from "@/app/api/v1/prospecting/searches/route";
import { ProspectingResultsTable } from "../_components/ProspectingResultsTable";

export const dynamic = "force-dynamic";

/**
 * `/app/prospeccao/[searchId]` — reabre uma busca persistida com os
 * resultados completos (T6 do plano `.specs/features/prospeccao-google-maps/`).
 *
 * Mesma guarda de auth/org/role de `app/app/prospeccao/page.tsx` (ver o
 * comentário lá para a fonte do padrão de role gate).
 *
 * Busca os dados DIRETO via Supabase no servidor — mesmo padrão de
 * `app/app/contacts/[id]/page.tsx` (query com `.eq("organization_id", ...)`
 * além da RLS, `notFound()` se a linha não aparecer) — em vez de a página
 * chamar a própria `GET /api/v1/prospecting/searches/[id]` por HTTP. Reusa a
 * MESMA seleção de colunas e o mesmo mapeamento pra DTO que essa rota usa
 * (`PLACES_SELECT_COLUNAS`/`toPlaceDTO`, `SEARCH_SELECT_COLUNAS`/
 * `toSearchDTO`, exportados de `app/api/v1/prospecting/searches/route.ts`
 * pro próprio `[id]/route.ts` já reusar) — evita esta tela e as rotas de API
 * divergirem sobre o formato de uma busca/lugar.
 *
 * "Não existe" e "é de outra organização" caem no MESMO `notFound()`, sem
 * distinção — mesmo padrão de `app/app/leads/[id]/page.tsx` e do 404 da rota
 * de API irmã (`[id]/route.ts`): não revelar a diferença entre os dois casos.
 */
export default async function ProspeccaoDetailPage({
  params,
}: {
  params: Promise<{ searchId: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const { searchId } = await params;
  const supabase = await createClient();

  const { data: searchRow } = await supabase
    .from("prospected_searches")
    .select(SEARCH_SELECT_COLUNAS)
    .eq("id", searchId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!searchRow) notFound();

  const search = toSearchDTO(searchRow as unknown as ProspectedSearchRow);

  const { data: placeRows } = await supabase
    .from("prospected_places")
    .select(PLACES_SELECT_COLUNAS)
    .eq("search_id", searchId)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  const places = ((placeRows ?? []) as unknown as ProspectedPlaceRow[]).map(toPlaceDTO);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/app/prospeccao"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t("Nova busca")}
        </Link>
        <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
          {/* businessType/location são DADO (texto digitado na busca), não
              cópia da interface — não passam por t(). */}
          {search.businessType} · {search.location}
        </h1>
        <p className="text-sm text-muted-foreground">
          {new Date(search.createdAt).toLocaleDateString(idioma, {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })}
        </p>
      </header>

      <ProspectingResultsTable
        searchId={search.id}
        initialPlaces={places}
        placesApiCapped={search.placesApiCapped}
      />
    </div>
  );
}
