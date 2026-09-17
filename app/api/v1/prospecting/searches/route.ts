import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/prospecting/searches — T4 do plano
 * `.specs/features/prospeccao-google-maps/` (design.md "Dois relógios").
 *
 * Orquestra P1 (síncrono, dentro da própria request): valida o body → busca
 * na Google Places API (New) → calcula `scoreInitial` por linha → persiste a
 * busca + os resultados em lote → emite 1 evento
 * `prospected_place.site_quality_requested` por linha COM site (P2, o
 * worker de Playwright que consome esse evento, ainda não existe neste
 * plano — só a emissão é escopo desta task) → `audit()` → responde.
 *
 * Nunca espera o Playwright: erro de Places API não persiste nada (busca
 * inteira falha alto); zero resultados NÃO é erro (busca com 0
 * `prospected_places` é um resultado válido).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  PlacesApiError,
  searchPlaces,
  type PlacesApiErrorCode,
  type RawPlace,
} from "@/lib/prospecting/places-client";
import { scoreInitial } from "@/lib/prospecting/score";
import { prospectingSearchSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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
 *    billing desligado) — mesma forma de `waha_error` (502, chamada a um
 *    terceiro que devolveu erro) em vez de `unavailable`, porque aqui HOUVE
 *    resposta HTTP do lado de fora, só que ela nega o pedido.
 *  - `quota_exceeded`: cota da Google esgotada — 503 (tente mais tarde),
 *    não 429 (`rate_limited` já é o código genérico para "nós limitamos
 *    VOCÊ"; aqui é a Google nos limitando, então o código próprio evita
 *    confundir os dois sentidos).
 *  - `unknown_error`: também cobre falha de TRANSPORTE (DNS, timeout —
 *    ver places-client.ts). Mesmo tratamento de `waha_error`: 502.
 */
const PLACES_ERROR_STATUS: Record<PlacesApiErrorCode, number> = {
  missing_api_key: 503,
  invalid_api_key_or_billing: 502,
  quota_exceeded: 503,
  unknown_error: 502,
};

/** Forma de uma linha de `prospected_places` como o `.select()` devolve. */
interface ProspectedPlaceRow {
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
}

/**
 * DTO de resposta — mesmo shape camelCase de `ProspectedPlace` em design.md
 * (§"Data Models"), o contrato que a UI (tasks futuras) já assume.
 */
interface ProspectedPlaceDTO {
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
}

function toPlaceDTO(row: ProspectedPlaceRow): ProspectedPlaceDTO {
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
  };
}

const PLACES_SELECT_COLUNAS =
  "id, search_id, place_id, name, address, phone_number, phone_number_normalized, " +
  "website_url, rating, review_count, score_initial, score_final, status_label, " +
  "site_analysis_status, site_analysis_result, email, promoted_lead_id, promoted_at";

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

  let input: { businessType: string; location: string; serviceType: "venda_de_site" };
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

  const admin = createAdminClient();

  const { data: search, error: searchErr } = await admin
    .from("prospected_searches")
    .insert({
      organization_id: org.orgId,
      business_type: input.businessType,
      location: input.location,
      service_type: input.serviceType,
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
      const { score, label } = scoreInitial({
        hasWebsite: !!place.websiteUrl,
        rating: place.rating ?? undefined,
        reviewCount: place.reviewCount ?? undefined,
      });
      return {
        search_id: searchId,
        organization_id: org.orgId,
        place_id: place.placeId,
        name: place.name,
        address: place.address,
        phone_number: place.phoneNumber,
        // Normalização E.164 (pro link wa.me) fica fora do escopo desta
        // task — o brief não pede o cálculo, e a coluna aceita null.
        phone_number_normalized: null,
        website_url: place.websiteUrl,
        rating: place.rating,
        review_count: place.reviewCount,
        score_initial: score,
        score_final: null,
        status_label: label,
        site_analysis_status: place.websiteUrl ? "pending" : "not_applicable",
        email: null,
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

  // 1 evento por linha COM site — nunca para linha sem site (não há o que
  // analisar). `event_log` real (migration 0234) não tem coluna
  // `external_id`/constraint de idempotência por ela — design.md e o brief
  // desta task assumiam que existia; não existe, e não é papel desta task
  // inventar a coluna. Reportado como achado, não resolvido aqui.
  const comSite = placeRows.filter((row) => row.website_url !== null);
  if (comSite.length > 0) {
    const emissoes = await Promise.all(
      comSite.map((row) =>
        admin
          .rpc("emit_event", {
            p_event_type: "prospected_place.site_quality_requested",
            p_entity_kind: "prospected_place",
            p_entity_id: row.id,
            p_payload: {
              prospected_place_id: row.id,
              search_id: searchId,
              place_id: row.place_id,
              website_url: row.website_url,
            },
            p_metadata: { request_id: requestId, actor_user_id: user.id },
            p_organization_id: org.orgId,
          })
          .then(({ error }: { error: { message: string } | null }) => ({ id: row.id, error })),
      ),
    );
    for (const emissao of emissoes) {
      if (emissao.error) {
        console.error("[prospecting.search] emit_event falhou", {
          prospectedPlaceId: emissao.id,
          error: emissao.error.message,
        });
      }
    }
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
      service_type: input.serviceType,
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
