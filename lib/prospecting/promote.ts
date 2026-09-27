/**
 * Promoção de resultado de prospeccão Google Maps para o funil do CRM.
 * Segue o padrão de `lib/leads/nascimento-do-lead.ts` (tipagem, sem exceções genéricas).
 *
 * Fluxo determinístico:
 * 1. Lê prospected_places (organização + id)
 * 2. Se já promovido → erro `ja_promovido` (idempotente)
 * 3. Encontra ou cria contact (por phone_number_normalized)
 * 4. Encontra pipeline default
 * 5. Encontra primeira etapa (menor position)
 * 6. Cria crm_leads
 * 7. Cria crm_lead_links (target_kind='external')
 * 8. Atualiza prospected_places com promoted_lead_id/promoted_at
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { normalizePhoneToE164 } from "@/lib/prospecting/contact-utils";

/**
 * Por que um resultado NÃO foi promovido a lead.
 * Segue o padrão de MotivoSemLead de nascimento-do-lead.ts.
 */
export type MotivoSemPromocao =
  | "ja_promovido" // prospected_places.promoted_lead_id já não é null
  | "sem_pipeline_default" // organização não tem pipeline padrão
  | "sem_etapa" // pipeline padrão não tem etapa utilizável
  | "erro"; // qualquer falha de escrita

/**
 * Resultado da promoção.
 * Discriminated union: sucesso vs. motivo de falha.
 */
export type ResultadoPromocao =
  | { promotado: true; leadId: string }
  | { promotado: false; motivo: MotivoSemPromocao; detalhe?: string };

/**
 * Promove um resultado de prospeccão para o funil do CRM.
 *
 * @param db - cliente Supabase (admin ou autenticado)
 * @param organizationId - ID da organização
 * @param placeId - ID da linha de prospected_places
 * @returns Resultado (leadId ou motivo de erro)
 */
export async function promoteToLead(
  db: SupabaseClient,
  organizationId: string,
  placeId: string,
): Promise<ResultadoPromocao> {
  // 1. Lê a linha de prospected_places
  const { data: place, error: placeErr } = await db
    .from("prospected_places")
    .select("id, name, phone_number, address, rating, review_count, place_id, website_url, promoted_lead_id")
    .eq("organization_id", organizationId)
    .eq("id", placeId)
    .maybeSingle();

  if (placeErr || !place) {
    return {
      promotado: false,
      motivo: "erro",
      detalhe: placeErr?.message ?? "Resultado de prospeccão não encontrado",
    };
  }

  // 2. Se já promovido → idempotente, erro tipado
  if (place.promoted_lead_id !== null) {
    return { promotado: false, motivo: "ja_promovido" };
  }

  // 3. Encontra ou cria contact
  let contactId: string;

  // Computa o telefone normalizado a partir do raw phone_number
  const normalizedPhone = normalizePhoneToE164(place.phone_number);

  // Se temos telefone normalizado, procura por duplicata antes de criar
  if (normalizedPhone) {
    const { data: existingContact } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("phone_number", normalizedPhone)
      .maybeSingle();

    if (existingContact) {
      contactId = existingContact.id;
    } else {
      // Cria novo contact (empresa, não pessoa física, mas schema é o que é)
      const { data: newContact, error: contactErr } = await db
        .from("contacts")
        .insert({
          organization_id: organizationId,
          name: place.name,
          display_name: place.name,
          phone_number: normalizedPhone,
          source: "google_maps_prospecting",
          source_metadata: {
            place_id: place.place_id,
            address: place.address,
            rating: place.rating,
            review_count: place.review_count,
          },
        })
        .select("id")
        .single();

      if (contactErr || !newContact) {
        return {
          promotado: false,
          motivo: "erro",
          detalhe: contactErr?.message ?? "Erro ao criar contact",
        };
      }
      contactId = (newContact as { id: string }).id;
    }
  } else {
    // Sem telefone válido: cria contact sem buscar duplicatas
    const { data: newContact, error: contactErr } = await db
      .from("contacts")
      .insert({
        organization_id: organizationId,
        name: place.name,
        display_name: place.name,
        source: "google_maps_prospecting",
        source_metadata: {
          place_id: place.place_id,
          address: place.address,
          rating: place.rating,
          review_count: place.review_count,
        },
      })
      .select("id")
      .single();

    if (contactErr || !newContact) {
      return {
        promotado: false,
        motivo: "erro",
        detalhe: contactErr?.message ?? "Erro ao criar contact",
      };
    }
    contactId = (newContact as { id: string }).id;
  }

  // 4. Encontra pipeline default (mesmo padrão de nascimento-do-lead.ts)
  const { data: pipeline } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();

  if (!pipeline) {
    return { promotado: false, motivo: "sem_pipeline_default" };
  }

  // 5. Encontra primeira etapa (menor position, não won/lost)
  const { data: stage } = await db
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipeline.id)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!stage) {
    return { promotado: false, motivo: "sem_etapa" };
  }

  // 6. Cria crm_leads
  const { data: lead, error: leadErr } = await db
    .from("crm_leads")
    .insert({
      organization_id: organizationId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contactId,
      title: place.name,
      status: "open",
      source: "google_maps_prospecting",
      source_metadata: {
        place_id: place.place_id,
        address: place.address,
        rating: place.rating,
        review_count: place.review_count,
        website_url: place.website_url,
      },
    })
    .select("id")
    .single();

  if (leadErr || !lead) {
    return {
      promotado: false,
      motivo: "erro",
      detalhe: leadErr?.message ?? "Erro ao criar lead",
    };
  }

  const leadId = (lead as { id: string }).id;

  // 7. Cria crm_lead_links (target_kind='external' aponta pra prospected_places)
  const { error: linkErr } = await db.from("crm_lead_links").insert({
    organization_id: organizationId,
    lead_id: leadId,
    target_kind: "external",
    target_id: placeId,
    link_kind: "prospected_place",
  });

  if (linkErr) {
    // Lead foi criado mas link falhou — log, não falha a operação inteira
    // (mesmo padrão de emitLeadActivity em nascimento-do-lead.ts)
    logger.warn("promote-to-lead: crm_lead_links não criado", {
      organization_id: organizationId,
      lead_id: leadId,
      prospected_place_id: placeId,
      error: linkErr.message.slice(0, 120),
    });
  }

  // 8. Atualiza prospected_places
  const { error: updateErr } = await db
    .from("prospected_places")
    .update({
      promoted_lead_id: leadId,
      promoted_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", placeId);

  if (updateErr) {
    // Lead + link foram criados mas update do status falhou — mesma estratégia:
    // log, não reverter (a promoção aconteceu, o estado de prospected_places
    // está levemente defasado).
    logger.warn("promote-to-lead: prospected_places.promoted_at não atualizado", {
      organization_id: organizationId,
      lead_id: leadId,
      prospected_place_id: placeId,
      error: updateErr.message.slice(0, 120),
    });
  }

  return { promotado: true, leadId };
}
