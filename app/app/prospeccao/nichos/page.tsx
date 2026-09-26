import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { NICHE_SELECT_COLUNAS, toNicheDTO, type NicheRow } from "@/app/api/v1/prospecting/niches/route";
import { NichosManager } from "./_components/NichosManager";

export const dynamic = "force-dynamic";

/**
 * `/app/prospeccao/nichos` — T13 do plano
 * `.specs/features/prospeccao-nichos-e-enriquecimento/` (design.md
 * "Components", `app/app/prospeccao/nichos/page.tsx`).
 *
 * Mesmo padrão de guarda de `app/app/prospeccao/page.tsx`: Server Component,
 * `requireAuth()` + `resolveActiveOrg()`, `redirect()` na mão comparando
 * `ROLE_RANK` (não existe helper de gate de role pra Server Component — isso
 * é `requireRole()`, que só serve rota de API). Mesmo piso `manager` da API
 * de nichos (`app/api/v1/prospecting/niches/route.ts`).
 */
export default async function NichosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  // Direto via Supabase no servidor, sem passar pela própria API HTTP —
  // mesmo padrão de `app/app/prospeccao/page.tsx` pro histórico de buscas.
  const supabase = await createClient();
  const { data } = await supabase
    .from("prospecting_niches")
    .select(NICHE_SELECT_COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const niches = ((data ?? []) as unknown as NicheRow[]).map(toNicheDTO);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Nichos de prospecção")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Cada nicho define os termos de busca, os requisitos e os pesos que decidem se um resultado é um bom lead. Toda busca em Prospecção exige escolher um.",
          )}
        </p>
      </header>

      <NichosManager initialNiches={niches} apifyTokenConfigured={Boolean(env.APIFY_TOKEN)} />
    </div>
  );
}
