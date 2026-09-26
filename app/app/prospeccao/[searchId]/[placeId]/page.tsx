import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { NicheWeights } from "@/lib/prospecting/score";
import { createClient } from "@/lib/supabase/server";
import { CaretLeft } from "@/lib/ui/icons";
import { PlaceFicha } from "./_components/PlaceFicha";

export const dynamic = "force-dynamic";

/**
 * Forma de uma linha de `prospected_places` como esta tela lê — mais larga
 * que `PLACES_SELECT_COLUNAS` (`app/api/v1/prospecting/searches/route.ts`):
 * a listagem não precisa de `cnpj_*`/`instagram_*`, a ficha SÓ existe pra
 * mostrar exatamente isso. Colunas próprias em vez de estender o contrato já
 * estável da listagem/API de busca.
 */
export interface PlaceFichaRow {
  id: string;
  search_id: string;
  place_id: string;
  name: string;
  address: string | null;
  phone_number: string | null;
  phone_number_normalized: string | null;
  website_url: string | null;
  rating: number | null;
  review_count: number | null;
  score_initial: number;
  score_final: number | null;
  status_label: string;
  site_analysis_status: string;
  site_analysis_result: Record<string, unknown> | null;
  email: string | null;
  requisitos_ok: boolean;
  motivo_requisitos: string | null;
  cnpj_status: string;
  cnpj_data: Record<string, unknown> | null;
  cnpj_consultado_em: string | null;
  instagram_status: string;
  instagram_data: Record<string, unknown> | null;
  instagram_consultado_em: string | null;
  promoted_lead_id: string | null;
  lat: number | null;
  lng: number | null;
  google_maps_url: string | null;
  oportunidade_pitch_status: string;
  justificativa_oportunidade: string | null;
  abordagem_instagram: string | null;
  oportunidade_pitch_gerado_em: string | null;
}

/** DTO camelCase — mesmo shape que `PlaceFicha.tsx` (Client) e o Realtime consomem. */
export interface PlaceFichaDTO {
  id: string;
  searchId: string;
  placeId: string;
  name: string;
  address: string | null;
  phoneNumber: string | null;
  phoneNumberNormalized: string | null;
  websiteUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  scoreInitial: number;
  scoreFinal: number | null;
  statusLabel: string;
  siteAnalysisStatus: string;
  siteAnalysisResult: Record<string, unknown> | null;
  email: string | null;
  requisitosOk: boolean;
  motivoRequisitos: string | null;
  cnpjStatus: string;
  cnpjData: Record<string, unknown> | null;
  cnpjConsultadoEm: string | null;
  instagramStatus: string;
  instagramData: Record<string, unknown> | null;
  instagramConsultadoEm: string | null;
  promotedLeadId: string | null;
  lat: number | null;
  lng: number | null;
  googleMapsUrl: string | null;
  oportunidadePitchStatus: string;
  justificativaOportunidade: string | null;
  abordagemInstagram: string | null;
  oportunidadePitchGeradoEm: string | null;
}

export function toPlaceFichaDTO(row: PlaceFichaRow): PlaceFichaDTO {
  return {
    id: row.id,
    searchId: row.search_id,
    placeId: row.place_id,
    name: row.name,
    address: row.address,
    phoneNumber: row.phone_number,
    phoneNumberNormalized: row.phone_number_normalized,
    websiteUrl: row.website_url,
    rating: row.rating,
    reviewCount: row.review_count,
    scoreInitial: row.score_initial,
    scoreFinal: row.score_final,
    statusLabel: row.status_label,
    siteAnalysisStatus: row.site_analysis_status,
    siteAnalysisResult: row.site_analysis_result,
    email: row.email,
    requisitosOk: row.requisitos_ok,
    motivoRequisitos: row.motivo_requisitos,
    cnpjStatus: row.cnpj_status,
    cnpjData: row.cnpj_data,
    cnpjConsultadoEm: row.cnpj_consultado_em,
    instagramStatus: row.instagram_status,
    instagramData: row.instagram_data,
    instagramConsultadoEm: row.instagram_consultado_em,
    promotedLeadId: row.promoted_lead_id,
    lat: row.lat,
    lng: row.lng,
    googleMapsUrl: row.google_maps_url,
    oportunidadePitchStatus: row.oportunidade_pitch_status,
    justificativaOportunidade: row.justificativa_oportunidade,
    abordagemInstagram: row.abordagem_instagram,
    oportunidadePitchGeradoEm: row.oportunidade_pitch_gerado_em,
  };
}

export const PLACE_FICHA_SELECT_COLUNAS =
  "id, search_id, place_id, name, address, phone_number, phone_number_normalized, website_url, " +
  "rating, review_count, score_initial, score_final, status_label, site_analysis_status, " +
  "site_analysis_result, email, requisitos_ok, motivo_requisitos, cnpj_status, cnpj_data, " +
  "cnpj_consultado_em, instagram_status, instagram_data, instagram_consultado_em, promoted_lead_id, " +
  "lat, lng, google_maps_url, oportunidade_pitch_status, justificativa_oportunidade, " +
  "abordagem_instagram, oportunidade_pitch_gerado_em";

/**
 * `/app/prospeccao/[searchId]/[placeId]` — ficha por empresa, T15
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`). Seis blocos
 * coloridos (Google/Instagram/Site/Receita/Contato/Venda) — ver
 * `_components/PlaceFicha.tsx`.
 *
 * Sem entrada de menu própria (design.md, "Navegação"): chega-se aqui
 * clicando numa linha de `ProspectingResultsTable` (T14). `[searchId]` e
 * `[placeId]` são segmentos dinâmicos — `tests/unit/navegacao-completude.test.ts`
 * já os ignora na varredura (rotas com `[` no nome não entram no inventário),
 * então esta rota não precisa de registro nem de allowlist.
 *
 * Mesma guarda de auth/org/role de `app/app/prospeccao/page.tsx` e
 * `[searchId]/page.tsx`. `searchId` E `placeId` são conferidos juntos
 * (`.eq("id", placeId).eq("search_id", searchId)`) — um `placeId` de outra
 * busca (mesma organização ou não) cai no mesmo `notFound()`.
 */
export default async function PlaceFichaPage({
  params,
}: {
  params: Promise<{ searchId: string; placeId: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);
  const { searchId, placeId } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("prospected_places")
    .select(PLACE_FICHA_SELECT_COLUNAS)
    .eq("id", placeId)
    .eq("search_id", searchId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!data) notFound();

  const place = toPlaceFichaDTO(data as unknown as PlaceFichaRow);

  // Pesos DE VERDADE do nicho da busca, pro bloco "De onde vem a nota"
  // (`scoreBreakdown`, lib/prospecting/score.ts) — mesmo lookup em 2 passos
  // (search_id → niche_id → weights) já usado pelos 3 workers de
  // enriquecimento. Nicho apagado/dado legado sem niche_id: `nicheWeights`
  // fica `null` e a ficha simplesmente não mostra o bloco (degrada, não quebra).
  const { data: searchRow } = await supabase
    .from("prospected_searches")
    .select("niche_id")
    .eq("id", searchId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  let nicheWeights: NicheWeights | null = null;
  let nicheName: string | null = null;
  if (searchRow?.niche_id) {
    const { data: nicheRow } = await supabase
      .from("prospecting_niches")
      .select("name, weights")
      .eq("id", searchRow.niche_id as string)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (nicheRow) {
      nicheWeights = nicheRow.weights as unknown as NicheWeights;
      nicheName = nicheRow.name as string;
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <Link
        href={`/app/prospeccao/${searchId}`}
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        <CaretLeft size={14} aria-hidden />
        {t("Voltar para os resultados")}
      </Link>

      <PlaceFicha initialPlace={place} nicheWeights={nicheWeights} nicheName={nicheName} />
    </div>
  );
}
