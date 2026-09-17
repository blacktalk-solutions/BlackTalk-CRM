-- ============================================================================
-- 0234 — PROSPECÇÃO VIA GOOGLE MAPS: `prospected_searches` + `prospected_places`
--
-- T1 do plano `.specs/features/prospeccao-google-maps/` (design.md / tasks.md).
-- Só schema nesta migration — nenhuma rota, worker ou UI ainda lê/escreve
-- aqui. As duas tabelas são a fundação (Phase 1) de que as demais tasks
-- dependem.
--
-- ─── Por que tabelas novas, e não estender `contacts`/`crm_leads`
--
-- Doutrina DIRC (design.md): entidade diferente (empresa achada no Maps, não
-- pessoa física) e ciclo de vida diferente (resultado bruto de busca, não
-- oportunidade em funil). A promoção para `crm_leads` é ato explícito de uma
-- task futura (T12/T13) — enquanto isso, a organização inteira dos resultados
-- de uma busca vive aqui, fora do motor do CRM.
--
-- ─── `organization_id` denormalizado em `prospected_places`
--
-- Mesmo padrão de `crm_leads`/`crm_lead_activities`: dá para fazer a policy de
-- RLS direto na tabela-filha sem join até `prospected_searches`, e sobrevive
-- ao `on delete cascade` de `search_id` sem ambiguidade de tenant.
--
-- ─── `requested_by` SEM `on delete cascade`, de propósito
--
-- É `not null`: apagar o `auth.users` de quem pediu a busca não pode arrastar
-- a busca inteira (e, por tabela, TODOS os `prospected_places` dela via o
-- cascade de `search_id`) — é exatamente o anti-pattern 7 do CLAUDE.md
-- ("cascade fantasma"), só que na direção mais cara: histórico de negócio da
-- ORGANIZAÇÃO (custou chamada paga à Places API) apagado por conta de um
-- usuário que saiu. Sem `on delete`, o Postgres usa `NO ACTION`: apagar esse
-- `auth.users` com buscas associadas falha alto (FK violation) em vez de
-- apagar em silêncio — a mesma leitura literal do SQL de `design.md`, que
-- também não tinha cascade aqui.
--
-- ─── `status_label` e `site_analysis_status` ganham CHECK
--
-- design.md já documenta os dois vocabulários fechados (`'quente' |
-- 'oportunidade' | 'baixa'` e `'not_applicable' | 'pending' | 'processing' |
-- 'done' | 'failed'`) em comentário — aqui eles viram constraint de banco,
-- mesmo padrão de `crm_tasks.status`/`crm_tasks.priority` (0210) e
-- `demandas.estado`/`demandas.origem` (0136). `service_type` fica SEM check,
-- de propósito: nenhum vocabulário fechado foi definido para ele em
-- design.md (só um default), e fechá-lo aqui seria inventar enum que a task
-- não pediu.
--
-- ─── Uma policy `tenant_isolation_..._all` por tabela, sem gate de papel
--
-- design.md é explícito: RBAC fino (`requireRole('manager')` para buscar e
-- promover) vive na ROTA, não no RLS — "v1 não tem RBAC fino (fora de escopo
-- do spec)". Reusa literalmente o padrão `tenant_isolation_<tabela>_all` via
-- `fn_user_org_ids()` já usado em `crm_leads`/`knowledge_searches`/`demandas`,
-- sem inventar um gate que o design não pede.
--
-- ─── `revoke all ... from anon` nas duas, mesmo a policy já bastando
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
-- TABLES TO anon` (corpo do baseline, herdado do pg_dump) concede ALL a anon
-- em toda tabela nova. A policy já devolve zero linha para JWT anônimo
-- (auth.uid() null ⇒ fn_user_org_ids() vazio), mas o grant que sobra não tem
-- razão de existir — defesa em profundidade, mesmo contrato de
-- `knowledge_searches` (0086) e `crm_tasks` (0210).
--
-- ⚠️ Prova comportamental cross-tenant (JWT simulado + contagem cross-org)
-- fica para a T10 do plano ("Invariantes de RLS e idempotência",
-- tests/invariants/prospecting.test.ts — depende de T1+T4+T8, que ainda não
-- existem). Até T10 aterrissar, a varredura de completude
-- (tests/invariants/rls-completude-varredura.test.ts) vai listar as duas
-- tabelas como "tenant-aware nova sem prova comportamental" — esperado por
-- design do plano, não um defeito desta migration.
-- ============================================================================

create table if not exists public.prospected_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  business_type text not null,
  location text not null,
  service_type text not null default 'venda_de_site',
  -- SEM on delete cascade: ver o cabeçalho acima ("requested_by SEM on delete
  -- cascade"). NO ACTION (default) bloqueia apagar o usuário em vez de
  -- arrastar o histórico de busca da organização em silêncio.
  requested_by uuid not null references auth.users(id),
  result_count integer not null default 0,
  -- true quando a busca bateu no teto de 60 resultados da Places API (New).
  places_api_capped boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.prospected_places (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.prospected_searches(id) on delete cascade,
  -- Denormalizado: mesmo padrão de crm_leads (RLS direto, sem join até a busca).
  organization_id uuid not null references public.organizations(id) on delete cascade,
  place_id text not null, -- id da Google (Places API)
  name text not null,
  address text,
  phone_number text,
  phone_number_normalized text, -- E.164, para o link wa.me
  website_url text,
  rating numeric,
  review_count integer,
  score_initial integer not null,
  score_final integer, -- null até P2 terminar (ou até sempre, se não há site)
  status_label text not null, -- recalculado quando score_final chega
  site_analysis_status text not null default 'not_applicable',
  site_analysis_result jsonb, -- { reachable, mobileResponsive, loadTimeMs, error? }
  email text,
  promoted_lead_id uuid references public.crm_leads(id) on delete set null,
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prospected_places_status_label_check
    check (status_label in ('quente', 'oportunidade', 'baixa')),
  constraint prospected_places_site_analysis_status_check
    check (site_analysis_status in ('not_applicable', 'pending', 'processing', 'done', 'failed')),

  unique (organization_id, search_id, place_id)
);

-- A tela de histórico (`GET /api/v1/prospecting/searches`) lista por organização
-- em ordem de recência.
create index if not exists idx_prospected_searches_org_created
  on public.prospected_searches (organization_id, created_at desc);

-- A tabela de resultados de UMA busca (`ProspectingResultsTable`), e o
-- `on delete cascade` de search_id — sem isto, apagar uma busca com muitas
-- linhas varre `prospected_places` inteira em vez de usar índice.
create index if not exists idx_prospected_places_search_id
  on public.prospected_places (search_id);

alter table public.prospected_searches enable row level security;
alter table public.prospected_places enable row level security;

drop policy if exists tenant_isolation_prospected_searches_all on public.prospected_searches;
create policy tenant_isolation_prospected_searches_all on public.prospected_searches
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_prospected_places_all on public.prospected_places;
create policy tenant_isolation_prospected_places_all on public.prospected_places
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on public.prospected_searches from anon;
revoke all on public.prospected_places from anon;

drop trigger if exists trg_prospected_places_updated_at on public.prospected_places;
create trigger trg_prospected_places_updated_at
  before update on public.prospected_places
  for each row execute function public.fn_set_updated_at();

comment on table public.prospected_searches is
  'Uma execução de busca na Google Places API (New) — P1 da prospecção (design.md). 1:N com prospected_places.';
comment on table public.prospected_places is
  'Um resultado bruto de prospected_searches. Nunca lida pelo motor do CRM: só a promoção explícita (promoted_lead_id) liga uma linha a um crm_leads.';
comment on column public.prospected_places.status_label is
  'Derivado da fórmula de score (lib/prospecting/score.ts), armazenado (não calculado a cada leitura) porque muda de forma assíncrona — ver Nota DIRC em design.md.';
comment on column public.prospected_places.site_analysis_status is
  'not_applicable = sem website_url (nunca entra na fila do worker); pending/processing/done/failed = ciclo de vida de prospected-site-quality-worker (P2).';
