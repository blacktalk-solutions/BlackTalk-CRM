-- ============================================================================
-- 0238 — FICHA DE PROSPECÇÃO AVANÇADA: coordenadas do Maps + pitch de venda por IA
--
-- Duas adições independentes, aditivas, que nascem juntas porque saíram da
-- mesma sessão de trabalho (redesenho da ficha em
-- app/app/prospeccao/[searchId]/[placeId]/_components/PlaceFicha.tsx):
--
-- ─── 1. `lat`/`lng`/`google_maps_url`
--
-- Capturados na busca (T4/T8, app/api/v1/prospecting/searches/route.ts) a
-- partir dos campos `places.location`/`places.googleMapsUri` da Google
-- Places API (New) — ambos tier Pro, sem custo adicional sobre o tier
-- Enterprise que `rating`/`nationalPhoneNumber`/`websiteUri` (já pedidos)
-- já pagam: a Places API cobra pelo campo MAIS CARO do request, não por
-- campo adicional (developers.google.com/maps/documentation/places/
-- web-service/usage-and-billing). Usados pra embutir o mapa e o link "abrir
-- no Google Maps" na ficha sem depender do fallback por endereço.
--
-- ─── 2. Trio `oportunidade_pitch_*`
--
-- MESMO formato de trio (`<sinal>_status`/`<sinal>_gerado_em` + campo de
-- dado) já usado por `site_analysis_*` (0234) e `cnpj_*`/`instagram_*`
-- (0237), mesmos 5 valores de status. Diferença: aqui o "dado" são DOIS
-- campos de texto (`justificativa_oportunidade`, `abordagem_instagram`),
-- não um jsonb — geração por IA (worker novo, T pitch) é texto livre, não
-- estrutura tipada como cnpj_data/instagram_data.
--
-- `not_applicable` é o default — nunca `pending` sozinho: só quem chama
-- `POST /api/v1/prospecting/places/[placeId]/pitch` (gatilho MANUAL, não
-- automático por resultado — ver o comentário da rota) promove pra
-- `pending`. Diferente de cnpj/instagram, que a busca promove pra `pending`
-- pra TODO resultado (ou todo resultado sem site): gerar texto de venda por
-- IA custa dinheiro por chamada, e uma busca pode trazer centenas de
-- resultados — automatizar isso por resultado seria custo não controlado
-- pro self-hoster (mesma doutrina de AUDIT_LOG_RETENTION_DAYS/APIFY_TOKEN:
-- nada de custo obrigatório surpresa).
-- ============================================================================

alter table public.prospected_places
  add column if not exists lat                          numeric,
  add column if not exists lng                           numeric,
  add column if not exists google_maps_url               text,
  add column if not exists oportunidade_pitch_status     text not null default 'not_applicable',
  add column if not exists justificativa_oportunidade    text,
  add column if not exists abordagem_instagram           text,
  add column if not exists oportunidade_pitch_gerado_em  timestamptz;

alter table public.prospected_places
  drop constraint if exists prospected_places_oportunidade_pitch_status_check,
  add constraint prospected_places_oportunidade_pitch_status_check
    check (oportunidade_pitch_status in ('not_applicable', 'pending', 'processing', 'done', 'failed'));

comment on column public.prospected_places.lat is
  'Latitude do place (Google Places API "location", tier Pro) — null em linhas gravadas antes desta migration; a ficha cai no fallback de mapa por endereço nesse caso.';
comment on column public.prospected_places.lng is
  'Longitude do place — mesma nota de `lat`.';
comment on column public.prospected_places.google_maps_url is
  '`googleMapsUri` da Places API (link direto pro place no Maps) — null em linhas antigas; a ficha cai no fallback de URL de busca por nome+endereço.';
comment on column public.prospected_places.oportunidade_pitch_status is
  'not_applicable = ninguém pediu ainda (default; gatilho é MANUAL, ver app/api/v1/prospecting/places/[placeId]/pitch/route.ts) — nunca promovido em massa pela busca, ao contrário de cnpj_status/instagram_status. pending/processing/done/failed = ciclo de vida do worker de pitch. Mesmos 5 valores de site_analysis_status (0234).';
comment on column public.prospected_places.justificativa_oportunidade is
  '"A venda que cabe" — texto curto gerado por IA (workers/prospecting-pitch-worker.ts) explicando a melhor abordagem comercial pra este prospect, a partir do score/raio-x do site/CNPJ/Instagram já coletados. null até oportunidade_pitch_status=''done''.';
comment on column public.prospected_places.abordagem_instagram is
  'Ganchos de abordagem pro Instagram, gerados por IA — só preenchido quando há instagram_data com perfil confirmado; null quando não há Instagram pra ancorar a sugestão, mesmo com pitch ''done''.';
comment on column public.prospected_places.oportunidade_pitch_gerado_em is
  'Quando o worker de pitch terminou de processar esta linha (sucesso ou falha) — mesmo papel de cnpj_consultado_em/instagram_consultado_em.';
