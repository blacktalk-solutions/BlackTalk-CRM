import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import {
  SEARCH_SELECT_COLUNAS,
  toSearchDTO,
  type ProspectedSearchRow,
} from "@/app/api/v1/prospecting/searches/route";
import { ProspectingSearchForm } from "./_components/ProspectingSearchForm";

export const dynamic = "force-dynamic";

/**
 * `/app/prospeccao` — formulário de busca + histórico (T6 do plano
 * `.specs/features/prospeccao-google-maps/`).
 *
 * Guarda de auth/org: mesmo padrão de `app/app/radar/page.tsx` (Server
 * Component, `requireAuth()` + `resolveActiveOrg()`, redirect se sem org
 * ativa — não há `middleware.ts` neste projeto).
 *
 * Guarda de ROLE: não existe um helper único pra gate de role em Server
 * Component (isso é `requireRole()`, e ele só serve rota de API — devolve
 * `NextResponse`, não dá pra `redirect()` com ele). O precedente real está em
 * `app/app/ai/cases/page.tsx` e `app/app/lgpd/requests/page.tsx`: comparar
 * `ROLE_RANK[activeOrg.role]` contra o mínimo e `redirect()` na mão. Aqui o
 * mínimo é `manager`, o MESMO piso que `requireRole("manager")` já cobra nas
 * rotas de `/api/v1/prospecting/*` (busca custa chamada paga à Places API —
 * ver `app/api/v1/prospecting/searches/route.ts`).
 */
export default async function ProspeccaoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  // Histórico de buscas — direto via Supabase no servidor, sem passar pela
  // própria API HTTP (mesmo padrão de `app/app/contacts/[id]/page.tsx`).
  // Reusa a mesma seleção de colunas e o mesmo mapeamento pra DTO que
  // `GET /api/v1/prospecting/searches` usa, em vez de duplicar os dois: as
  // duas telas que leem `prospected_searches` (esta e a de detalhe) e as duas
  // rotas de API precisam concordar sobre o formato de uma busca, e duplicar
  // esse mapeamento é como elas divergem sem ninguém perceber (mesmo
  // raciocínio do comentário em `[id]/route.ts` para POST vs. GET).
  const supabase = await createClient();
  const { data } = await supabase
    .from("prospected_searches")
    .select(SEARCH_SELECT_COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(20);

  const historico = ((data ?? []) as unknown as ProspectedSearchRow[]).map(toSearchDTO);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Prospecção")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Busque negócios no Google Maps por tipo e localidade. Cada resultado já sai com um score de oportunidade para venda de site.",
          )}
        </p>
      </header>

      <ProspectingSearchForm />

      {historico.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">{t("Buscas anteriores")}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {historico.map((busca) => (
              <li key={busca.id}>
                <Link
                  href={`/app/prospeccao/${busca.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm transition-colors hover:bg-accent/50"
                >
                  {/* businessType/location são DADO — texto que o operador
                      digitou na busca, não cópia da interface. Traduzir seria
                      errado (mesma fronteira que o guarda de i18n documenta
                      para nome de funil / rótulo de etapa). */}
                  <span className="min-w-0 truncate font-medium">
                    {busca.businessType} · {busca.location}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {busca.resultCount} {t(busca.resultCount === 1 ? "resultado" : "resultados")}
                    {" · "}
                    {new Date(busca.createdAt).toLocaleDateString(idioma, {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
