-- ============================================================================
-- 0237 — ENRIQUECIMENTO DE PROSPECÇÃO: colunas de CNPJ e Instagram
--
-- T2 do plano `.specs/features/prospeccao-nichos-e-enriquecimento/`
-- (design.md / tasks.md). Só schema — nenhum worker ainda escreve nestas
-- colunas (isso é T9/T10); esta migration só abre o espaço pra eles.
--
-- ─── Mesmo formato de `site_analysis_status`/`site_analysis_result` (0234)
--
-- Dois "trilhos" assíncronos novos, cada um com o mesmo trio já usado pro
-- site: `<sinal>_data jsonb` (o que o worker achou), `<sinal>_status text`
-- (ciclo de vida, mesmos 5 valores de `site_analysis_status`) e
-- `<sinal>_consultado_em timestamptz` (quando a última consulta terminou —
-- `site_analysis_status` não tem um equivalente próprio porque `updated_at`
-- da linha já bastava quando só havia UM trilho assíncrono; com três
-- trilhos independentes rodando em paralelo, `updated_at` sozinho não diz
-- QUAL deles foi o último a mexer na linha, daí a coluna dedicada aqui).
--
-- `not_applicable` é o default dos dois — mesma semântica de
-- `site_analysis_status`: `cnpj_requested`/`instagram_requested` (T8/T11)
-- são quem promove pra `pending`; uma linha nunca fica "pending" sem que
-- alguém tenha de fato pedido aquele enriquecimento.
-- ============================================================================

alter table public.prospected_places
  add column if not exists cnpj_data             jsonb,
  add column if not exists cnpj_status            text not null default 'not_applicable',
  add column if not exists cnpj_consultado_em     timestamptz,
  add column if not exists instagram_data         jsonb,
  add column if not exists instagram_status       text not null default 'not_applicable',
  add column if not exists instagram_consultado_em timestamptz;

alter table public.prospected_places
  drop constraint if exists prospected_places_cnpj_status_check,
  add constraint prospected_places_cnpj_status_check
    check (cnpj_status in ('not_applicable', 'pending', 'processing', 'done', 'failed'));

alter table public.prospected_places
  drop constraint if exists prospected_places_instagram_status_check,
  add constraint prospected_places_instagram_status_check
    check (instagram_status in ('not_applicable', 'pending', 'processing', 'done', 'failed'));

comment on column public.prospected_places.cnpj_data is
  'Dados normalizados da Receita (lib/prospecting/receita-client.ts): razão social, sócio-administrador, abertura, porte etc. null quando cnpj_status ainda não é ''done'', ou quando ''done'' sem CNPJ aceito (ver motivo_requisitos-like: o worker T9 grava o motivo em log, não numa coluna própria — mesma decisão de site_analysis_result não ter um campo "motivo" separado).';
comment on column public.prospected_places.cnpj_status is
  'not_applicable = ainda não pedido (T8 emite cnpj_requested pra TODO resultado, então uma linha passa por not_applicable só entre o INSERT e o evento ser drenado); pending/processing/done/failed = ciclo de vida de prospecting-cnpj-worker (T9). Mesmos 5 valores de site_analysis_status (0234), mesma doutrina.';
comment on column public.prospected_places.cnpj_consultado_em is
  'Quando prospecting-cnpj-worker (T9) terminou de processar esta linha (sucesso ou falha) — não existe coluna equivalente para o site porque site_analysis_status era o único trilho assíncrono quando 0234 foi escrita; com 3 trilhos em paralelo (site/cnpj/instagram), updated_at sozinho não diz qual foi o último a mexer.';
comment on column public.prospected_places.instagram_data is
  'Dados normalizados do Instagram (lib/prospecting/apify-client.ts): seguidores, posts, dias sem postar, engajamento médio etc. null quando instagram_status ainda não é ''done'', ou quando ''done'' sem perfil confirmado.';
comment on column public.prospected_places.instagram_status is
  'not_applicable = nicho da busca não dá peso a Instagram (weights.instagram = 0), OU APIFY_TOKEN não configurado (T16); pending/processing/done/failed = ciclo de vida de prospecting-instagram-worker (T10). Mesmos 5 valores de site_analysis_status.';
comment on column public.prospected_places.instagram_consultado_em is
  'Quando prospecting-instagram-worker (T10) terminou de processar esta linha (sucesso ou falha).';
