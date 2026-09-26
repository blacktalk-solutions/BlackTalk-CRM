-- ============================================================================
-- 0236 — NICHOS DE PROSPECÇÃO CONFIGURÁVEIS: `prospecting_niches`
--
-- T1 do plano `.specs/features/prospeccao-nichos-e-enriquecimento/`
-- (design.md / tasks.md). Continuação da feature `prospeccao-google-maps`
-- (migration 0234): aquela deixou de propósito fora de escopo um `score.ts`
-- configurável e um `service_type` livre — esta migration é a fundação de
-- schema pra isso.
--
-- ─── Por que tabela nova, e não um campo único na organização
--
-- Confirmado com o Thiago (spec.md, Problem Statement): uma organização pode
-- prospectar mais de um tipo de cliente ao mesmo tempo, igual ao
-- `prospeccao-kit-aluno` (`nichos/*.json`, um arquivo por nicho). Por isso
-- `organization_id` : `prospecting_niches` é 1:N, não 1:1.
--
-- ─── `weights`/`requirements` em jsonb, não colunas soltas
--
-- Mesmo formato do kit (JSON por nicho) — validado por semanas de uso real
-- antes desta feature. A soma de `weights` a 100 é validada na ESCRITA
-- (rota `POST /api/v1/prospecting/niches`, T7), não aqui: um CHECK de soma
-- de campos dentro de um jsonb é frágil e ilegível; a doutrina de "fechar o
-- vocabulário na borda, não duas vezes" já apareceu na migration 0234 pro
-- `service_type` e vale aqui pro mesmo motivo.
--
-- ─── `prospected_searches.niche_id` SEM `on delete cascade`
--
-- Mesma doutrina do `requested_by` em 0234: apagar um nicho com buscas
-- vinculadas não pode arrastar o histórico de busca da organização em
-- silêncio. Sem `on delete`, o Postgres usa `NO ACTION` — apagar um nicho
-- referenciado falha alto (FK violation) em vez de apagar em silêncio. A
-- rota de nicho (T7) trata esse erro como `409 niche_in_use` antes de deixar
-- o Postgres reclamar.
--
-- ─── `prospected_places.requisitos_ok` default `true`
--
-- Linhas gravadas ANTES desta migration (da feature 0234, sem nicho) não têm
-- como saber se "passaram" num requisito que não existia — `true` como
-- default trata dado antigo como "não reprovado" (neutro), nunca como
-- "reprovado silenciosamente". Todo INSERT novo (T8) grava o valor real,
-- calculado por `checkRequirements` (T3).
--
-- ─── RLS: mesmo padrão de 0234, sem gate de papel
--
-- `tenant_isolation_prospecting_niches_all` via `fn_user_org_ids()`, igual
-- às outras duas tabelas da prospecção. RBAC fino (quem pode criar/editar
-- nicho) vive na rota (`requireRole('manager')`, T7), não no RLS — mesma
-- doutrina de 0234.
-- ============================================================================

create table if not exists public.prospecting_niches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  service_type      text not null,
  search_terms      text[] not null,
  requirements      jsonb not null default '{}'::jsonb, -- { avaliacoesMin?, avaliacoesMax?, exigeCelular?, exigeSite? }
  weights           jsonb not null default '{}'::jsonb, -- { site, instagram, whatsapp, email, telefone, reputacao, cnpj, endereco, linkedin } — soma 100, validada na escrita
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_prospecting_niches_org
  on public.prospecting_niches (organization_id, created_at desc);

alter table public.prospecting_niches enable row level security;

drop policy if exists tenant_isolation_prospecting_niches_all on public.prospecting_niches;
create policy tenant_isolation_prospecting_niches_all on public.prospecting_niches
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on public.prospecting_niches from anon;

drop trigger if exists trg_prospecting_niches_updated_at on public.prospecting_niches;
create trigger trg_prospecting_niches_updated_at
  before update on public.prospecting_niches
  for each row execute function public.fn_set_updated_at();

comment on table public.prospecting_niches is
  'Critério configurável de prospecção por organização (termos, requisitos, pesos) — substitui o service_type fixo de 0234. 1:N com organizations.';

-- ─── Colunas novas em prospected_searches e prospected_places (0234) ────────

alter table public.prospected_searches
  add column if not exists niche_id uuid references public.prospecting_niches(id);

comment on column public.prospected_searches.niche_id is
  'Nicho escolhido para esta busca (0236). service_type continua sendo uma CÓPIA do service_type do nicho no momento da busca — não um join ao vivo — para que editar o nicho depois não mude o histórico.';

alter table public.prospected_places
  add column if not exists requisitos_ok      boolean not null default true,
  add column if not exists motivo_requisitos  text;

comment on column public.prospected_places.requisitos_ok is
  'Passou nos requisitos do nicho da busca (faixa de avaliações, celular, site) — default true trata linhas anteriores a esta migration (sem nicho) como não reprovadas, nunca como reprovadas em silêncio. Distinto de status_label: nota baixa e "fora do perfil" são informações diferentes (mesma distinção do prospeccao-kit-aluno).';
