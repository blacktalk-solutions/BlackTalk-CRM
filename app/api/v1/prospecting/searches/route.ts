import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/prospecting/searches — T4 de `.specs/features/prospeccao-google-maps/`,
 * reescrita por T8 de `.specs/features/prospeccao-nichos-e-enriquecimento/`
 * (design.md "API": "`POST /api/v1/prospecting/searches` (alterado)").
 *
 * Orquestra P1 (síncrono, dentro da própria request): valida o body → carrega
 * o NICHO escolhido, se houver (pesos/requisitos, T7; opcional desde 0239 —
 * sem nicho usa `PESOS_PADRAO` e requisitos vazios) → busca na Google Places
 * API (New) → calcula `scoreInitial`/`checkRequirements` por linha → persiste
 * a busca + os resultados em lote
 * → emite `site_quality_requested` (só quem tem site), `cnpj_requested`
 * (TODO resultado) e `instagram_requested` (só quem NÃO tem site e
 * `weights.instagram > 0` — quem TEM site ganha esse evento depois, do
 * `site-quality-worker`, T11, ainda não construído) → `audit()` → responde.
 *
 * Nunca espera os workers: erro de Places API ou nicho não encontrado não
 * persiste nada (busca inteira falha alto); zero resultados NÃO é erro
 * (busca com 0 `prospected_places` é um resultado válido).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizePhoneToE164 } from "@/lib/prospecting/contact-utils";
import {
  PlacesApiError,
  searchPlaces,
  type PlacesApiErrorCode,
  type RawPlace,
} from "@/lib/prospecting/places-client";
import {
  checkRequirements,
  PESOS_PADRAO,
  scoreInitial,
  type NicheRequirements,
  type NicheWeights,
} from "@/lib/prospecting/score";
import { prospectingSearchSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Forma de uma linha de `prospecting_niches` como esta rota lê (só o que usa). */
interface NicheForSearch {
  id: string;
  service_type: string | null;
  requirements: NicheRequirements | null;
  weights: NicheWeights;
}

/**
 * Status HTTP por `PlacesApiError.code` — não há tabela fixa disso no brief
 * da task, então a escolha (e o porquê) fica registrada aqui:
 *
 *  - `missing_api_key`: a chave nem está configurada no servidor — nunca
 *    chegou a existir uma chamada de rede. É "dependência de config
 *    ausente", o MESMO caso de `fail("unavailable", ..., 503)` já usado em
 *    outras rotas (ex. `lib/impersonate/support.ts`,
 *    `app/api/v1/notifications/push/route.ts`) — 503 por consistência com
 *    esse precedente, não 500: não é bug de código, é operação sem configurar.
 *  - `invalid_api_key_or_billing`: a Google respondeu (chave errada ou
 *    billing desligado) — mesma forma dos erros de terceiro que devolveram
 *    resposta (502) em vez de `unavailable`, porque aqui HOUVE resposta HTTP
 *    do lado de fora, só que ela nega o pedido.
 *  - `quota_exceeded`: cota da Google esgotada — 503 (tente mais tarde),
 *    não 429 (`rate_limited` já é o código genérico para "nós limitamos
 *    VOCÊ"; aqui é a Google nos limitando, então o código próprio evita
 *    confundir os dois sentidos).
 *  - `unknown_error`: também cobre falha de TRANSPORTE (DNS, timeout —
 *    ver places-client.ts). Mesmo tratamento de erro de terceiro: 502.
 */
const PLACES_ERROR_STATUS: Record<PlacesApiErrorCode, number> = {
  missing_api_key: 503,
  invalid_api_key_or_billing: 502,
  quota_exceeded: 503,
  unknown_error: 502,
};

/**
 * Forma de uma linha de `prospected_places` como o `.select()` devolve.
 * `export` porque `[id]/route.ts` (T5, GET de reabertura) reusa o mesmo
 * shape e o mesmo `toPlaceDTO` — as duas rotas devolvem o mesmo contrato de
 * `ProspectedPlace` de design.md, e duplicar o mapeamento é como as duas
 * respostas divergem sem ninguém perceber.
 */
export interface ProspectedPlaceRow {
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
  promoted_lead_id: string | null;
  promoted_at: string | null;
  /** T8: passou nos requisitos do nicho da busca — default `true` para linhas de antes da 0236. */
  requisitos_ok: boolean;
  motivo_requisitos: string | null;
  /** 0238: coordenadas + link direto da Google — null em linhas de antes da migration. */
  lat: number | null;
  lng: number | null;
  google_maps_url: string | null;
}

/**
 * DTO de resposta — mesmo shape camelCase de `ProspectedPlace` em design.md
 * (§"Data Models"), o contrato que a UI (tasks futuras) já assume.
 */
export interface ProspectedPlaceDTO {
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
  promotedLeadId: string | null;
  promotedAt: string | null;
  requisitosOk: boolean;
  motivoRequisitos: string | null;
  lat: number | null;
  lng: number | null;
  googleMapsUrl: string | null;
}

export function toPlaceDTO(row: ProspectedPlaceRow): ProspectedPlaceDTO {
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
    promotedLeadId: row.promoted_lead_id,
    promotedAt: row.promoted_at,
    requisitosOk: row.requisitos_ok,
    motivoRequisitos: row.motivo_requisitos,
    lat: row.lat,
    lng: row.lng,
    googleMapsUrl: row.google_maps_url,
  };
}

export const PLACES_SELECT_COLUNAS =
  "id, search_id, place_id, name, address, phone_number, phone_number_normalized, " +
  "website_url, rating, review_count, score_initial, score_final, status_label, " +
  "site_analysis_status, site_analysis_result, email, promoted_lead_id, promoted_at, " +
  "requisitos_ok, motivo_requisitos, lat, lng, google_maps_url";

/**
 * Forma de uma linha de `prospected_searches` como a listagem (GET deste
 * arquivo) e a reabertura (`[id]/route.ts`, GET) devolvem — resumo de
 * histórico, bem mais enxuto que o insert do POST acima: sem
 * `organization_id` nem `requested_by`, que nenhuma das duas rotas expõe.
 */
export interface ProspectedSearchRow {
  id: string;
  business_type: string;
  location: string;
  service_type: string;
  niche_id: string | null;
  result_count: number;
  places_api_capped: boolean;
  created_at: string;
}

/** DTO de resposta — mesmo shape camelCase de `ProspectedPlaceDTO` acima. */
export interface ProspectedSearchDTO {
  id: string;
  businessType: string;
  location: string;
  serviceType: string;
  /** `null` = busca ad-hoc, sem nicho vinculado (0239) — a tela de resultados usa isto pra oferecer "salvar como nicho". */
  nicheId: string | null;
  resultCount: number;
  placesApiCapped: boolean;
  createdAt: string;
}

export function toSearchDTO(row: ProspectedSearchRow): ProspectedSearchDTO {
  return {
    id: row.id,
    businessType: row.business_type,
    location: row.location,
    serviceType: row.service_type,
    nicheId: row.niche_id,
    resultCount: row.result_count,
    placesApiCapped: row.places_api_capped,
    createdAt: row.created_at,
  };
}

export const SEARCH_SELECT_COLUNAS =
  "id, business_type, location, service_type, niche_id, result_count, places_api_capped, created_at";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Busca custa chamada paga à Places API — piso manager+ (design.md, Tech
  // Decisions: "v1 não tem RBAC fino, mas precisa de algum gate").
  const authz = await requireRole("manager", { requestId, resource: "prospected_searches" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  let input: { businessType: string; location: string; nicheId?: string };
  try {
    input = await validateRequest(prospectingSearchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();

  // 0239: nicho virou OPCIONAL — achado validando em produção que a busca
  // travava por inteiro sem nenhum nicho cadastrado (wizard de 4 passos
  // antes da primeira busca). Sem `nicheId`, a busca segue ad-hoc: pesos
  // caem no `PESOS_PADRAO` (mesma sugestão do wizard) e requisitos ficam
  // vazios — `checkRequirements({}, {})` já trata isso como "nada reprova".
  //
  // Carrega o nicho ANTES de gastar a chamada paga à Places API — um nicho
  // inexistente/de outra organização não deveria custar cota da Google.
  // `.eq("organization_id", ...)` além do filtro por id: RLS já restringe,
  // isto é defesa em profundidade e o que faz "nicho de outra organização"
  // devolver 404 (não vaza "existe, mas não é seu" via 403).
  let niche: NicheForSearch | null = null;
  if (input.nicheId) {
    const { data: nicheRow, error: nicheErr } = await admin
      .from("prospecting_niches")
      .select("id, service_type, requirements, weights")
      .eq("id", input.nicheId)
      .eq("organization_id", org.orgId)
      .maybeSingle();

    if (nicheErr) {
      return fail("internal_error", nicheErr.message, 500, { requestId });
    }
    if (!nicheRow) {
      return fail("not_found", t("Nicho não encontrado."), 404, { requestId });
    }
    niche = nicheRow as unknown as NicheForSearch;
  }
  const weights = niche?.weights ?? PESOS_PADRAO;
  const requirements = niche?.requirements ?? {};

  let places: RawPlace[];
  let placesApiCapped: boolean;
  try {
    const result = await searchPlaces({
      businessType: input.businessType,
      location: input.location,
    });
    places = result.places;
    placesApiCapped = result.placesApiCapped;
  } catch (err) {
    if (err instanceof PlacesApiError) {
      // Nenhum insert acontece neste caminho — nada parcial no banco.
      return fail(err.code, err.message, PLACES_ERROR_STATUS[err.code], { requestId });
    }
    throw err;
  }

  const { data: search, error: searchErr } = await admin
    .from("prospected_searches")
    .insert({
      organization_id: org.orgId,
      business_type: input.businessType,
      location: input.location,
      // CÓPIA do service_type do nicho NO MOMENTO da busca, não um join ao
      // vivo (design.md, "Data Models") — editar o nicho depois (T7 PATCH)
      // nunca muda o texto gravado aqui. Sem nicho (0239): omite a chave e
      // deixa o DEFAULT da coluna ('venda_de_site') resolver — dado morto,
      // mas inofensivo, não vale outra migration só por isto.
      ...(niche?.service_type ? { service_type: niche.service_type } : {}),
      niche_id: niche?.id ?? null,
      requested_by: user.id,
      result_count: places.length,
      places_api_capped: placesApiCapped,
    })
    .select("id")
    .single();

  if (searchErr || !search) {
    return fail("internal_error", searchErr?.message ?? t("Erro ao registrar a busca."), 500, {
      requestId,
    });
  }
  const searchId = (search as { id: string }).id;

  // Zero resultados da Places API não é erro: a busca é registrada com 0
  // `prospected_places` e a resposta segue o caminho normal.
  let placeRows: ProspectedPlaceRow[] = [];
  if (places.length > 0) {
    const rowsToInsert = places.map((place) => {
      const phoneE164 = normalizePhoneToE164(place.phoneNumber);
      const { score, label } = scoreInitial(
        {
          hasWebsite: !!place.websiteUrl,
          rating: place.rating ?? undefined,
          reviewCount: place.reviewCount ?? undefined,
        },
        weights,
      );
      // O que ELIMINA (T8/T3) — separado da nota acima, mesma distinção do
      // `prospeccao-kit-aluno`. Roda AQUI (na busca), contra os dados que
      // existem NESTE momento: `exigeSite` só sabe "tem site cadastrado no
      // Maps ou não" — o `site-quality-worker` (T11) ainda não rodou.
      const { ok: requisitosOk, motivo: motivoRequisitos } = checkRequirements(
        {
          hasWebsite: !!place.websiteUrl,
          reviewCount: place.reviewCount ?? undefined,
          phoneE164,
        },
        requirements,
      );
      return {
        search_id: searchId,
        organization_id: org.orgId,
        place_id: place.placeId,
        name: place.name,
        address: place.address,
        phone_number: place.phoneNumber,
        // Achado ao ligar `checkRequirements` (T8): esta rota já calcula o
        // E.164 do telefone pra checar `exigeCelular` — gravar aqui fecha um
        // gap real da task original (T4), que deixava a coluna sempre null e
        // o link wa.me (`lib/prospecting/contact-utils.ts`) sem dado nenhum
        // pra funcionar. Nenhuma chamada de rede a mais: mesmo valor.
        phone_number_normalized: phoneE164,
        website_url: place.websiteUrl,
        rating: place.rating,
        review_count: place.reviewCount,
        score_initial: score,
        score_final: null,
        status_label: label,
        site_analysis_status: place.websiteUrl ? "pending" : "not_applicable",
        email: null,
        requisitos_ok: requisitosOk,
        motivo_requisitos: motivoRequisitos ?? null,
        lat: place.lat,
        lng: place.lng,
        google_maps_url: place.googleMapsUrl,
      };
    });

    const { data: insertedPlaces, error: placesErr } = await admin
      .from("prospected_places")
      .insert(rowsToInsert)
      .select(PLACES_SELECT_COLUNAS);

    if (placesErr || !insertedPlaces) {
      // Pai sem filho é busca inconsistente (result_count > 0, zero linhas):
      // desfaz o registro em vez de responder ok() com dado pela metade.
      // Mesmo padrão de app/api/v1/ai/knowledge/sources/route.ts.
      await admin.from("prospected_searches").delete().eq("id", searchId);
      return fail(
        "internal_error",
        placesErr?.message ?? t("Erro ao gravar os resultados da busca."),
        500,
        { requestId },
      );
    }
    placeRows = insertedPlaces as unknown as ProspectedPlaceRow[];
  }

  // `event_log` real (migration 0234) não tem coluna `external_id`/
  // constraint de idempotência por ela — design.md e o brief da task original
  // (T4) assumiam que existia; não existe, e não é papel desta task inventar
  // a coluna. Reportado como achado, não resolvido aqui (idempotência dos
  // workers novos vive na APLICAÇÃO — claim otimista por status, T9/T10).
  async function emitirEventos(
    rows: ProspectedPlaceRow[],
    eventType: string,
    payload: (row: ProspectedPlaceRow) => Record<string, unknown>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const emissoes = await Promise.all(
      rows.map((row) =>
        admin
          .rpc("emit_event", {
            p_event_type: eventType,
            p_entity_kind: "prospected_place",
            p_entity_id: row.id,
            p_payload: payload(row),
            p_metadata: { request_id: requestId, actor_user_id: user.id },
            p_organization_id: org.orgId,
          })
          .then(({ error }: { error: { message: string } | null }) => ({ id: row.id, error })),
      ),
    );
    for (const emissao of emissoes) {
      if (emissao.error) {
        console.error("[prospecting.search] emit_event falhou", {
          eventType,
          prospectedPlaceId: emissao.id,
          error: emissao.error.message,
        });
      }
    }
  }

  // 1 evento por linha COM site — nunca para linha sem site (não há o que
  // analisar). P2 original, inalterado por T8.
  const comSite = placeRows.filter((row) => row.website_url !== null);
  await emitirEventos(comSite, "prospected_place.site_quality_requested", (row) => ({
    prospected_place_id: row.id,
    search_id: searchId,
    place_id: row.place_id,
    website_url: row.website_url,
  }));

  // T8/T9: CNPJ é grátis (Receita pública + pesquisa quando precisa) e não
  // depende de site (busca é por nome+cidade) — emitido pra TODO resultado,
  // sem checar peso (design.md, Tech Decisions: "pular consulta com peso 0"
  // só vale pro Instagram, que é pago via Apify).
  await emitirEventos(placeRows, "prospected_place.cnpj_requested", (row) => ({
    prospected_place_id: row.id,
    search_id: searchId,
    place_id: row.place_id,
    name: row.name,
    address: row.address,
  }));

  // T8/T10: só quem NÃO tem site (nada a esperar) e só se o nicho dá peso a
  // Instagram (design.md, "Gatilho do Instagram"). Quem TEM site ganha este
  // evento depois, do `site-quality-worker` (T11, ainda não construído) —
  // que tenta achar o link no HTML já baixado antes de cair pra pesquisa.
  if (weights.instagram > 0) {
    const semSite = placeRows.filter((row) => row.website_url === null);
    await emitirEventos(semSite, "prospected_place.instagram_requested", (row) => ({
      prospected_place_id: row.id,
      search_id: searchId,
      place_id: row.place_id,
      name: row.name,
      address: row.address,
      instagram_link: null, // sem site, ninguém já achou um link — o worker (T10) pesquisa
    }));
  }

  void audit({
    action: "prospecting.search_run",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "prospected_search",
    resourceId: searchId,
    requestId,
    metadata: {
      business_type: input.businessType,
      location: input.location,
      niche_id: niche?.id ?? null,
      service_type: niche?.service_type ?? null,
      result_count: placeRows.length,
      places_api_capped: placesApiCapped,
      with_website_count: comSite.length,
    },
  });

  return ok(
    { searchId, places: placeRows.map(toPlaceDTO) },
    { status: 201, requestId },
  );
}

/**
 * GET /api/v1/prospecting/searches — T5 do plano
 * `.specs/features/prospeccao-google-maps/` (design.md "API": "histórico
 * (lista)").
 *
 * Menu de histórico: só o resumo de cada busca, sem os `prospected_places`
 * associados (isso é o GET de `[id]/route.ts`, que reabre uma busca com os
 * resultados completos). Mesmo gate do POST acima
 * (`requireRole('manager')`) — ver o histórico de buscas que custaram
 * chamada paga à Places API é a mesma classe de ação que disparar uma nova.
 *
 * RLS (`tenant_isolation_prospected_searches_all`) já restringe às
 * organizações de que o usuário é MEMBRO — o `.eq("organization_id", ...)`
 * abaixo restringe mais um passo, só à organização ATIVA da sessão (não
 * "todas as organizações de que sou membro"), mesmo padrão do GET de
 * `app/api/v1/ai/knowledge/sources/[id]/route.ts`.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "prospected_searches" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  // Mesmo clamping de app/api/v1/leads/[id]/timeline/route.ts. Sem cursor:
  // o brief desta task marca paginação como opcional e só se trivial — não
  // há um padrão de cursor pronto pra copiar pra esta listagem simples.
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospected_searches")
    .select(SEARCH_SELECT_COLUNAS)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = (data ?? []) as unknown as ProspectedSearchRow[];
  return ok(rows.map(toSearchDTO), { requestId });
}
