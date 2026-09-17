# Prospecção via Google Maps — Tasks

**Design:** `.specs/features/prospeccao-google-maps/design.md`
**Status:** Draft

---

## Execution Plan

### Phase 1: Fundação (paralelo)

```
T1, T2, T3, T7 — nenhuma depende de outra
```

### Phase 2: Busca síncrona (P1)

```
T1, T2, T3 → T4
T1 → T5
T4, T5 → T6
```

### Phase 3: Análise assíncrona de site (P2)

```
T2, T7 → T8
T6, T8 → T9
T1, T4, T8 → T10
```

### Phase 4: Ações e promoção (P3 + P4)

```
T1 → T12
T6, T8 → T11
T6, T12 → T13
```

### Phase 5: E2E

```
T9, T11, T13 → T14
```

---

## Task Breakdown

### T1: Migration `prospected_searches` + `prospected_places`

**What:** Schema das 2 tabelas novas, RLS por `organization_id`, apêndice no `baseline.sql`, linha no `MANIFEST.md`.
**Where:** `supabase/migrations/YYYYMMDDHHMMSS_00xx_prospecting.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
**Depends on:** None
**Reuses:** Padrão `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` já usado em `crm_leads`
**Requirement:** PROSPECT-03

**Tools:** filesystem

**Done when:**

- [ ] `prospected_searches` e `prospected_places` criadas conforme `design.md`
- [ ] RLS habilitada e policy de isolamento nas duas
- [ ] `unique(organization_id, search_id, place_id)` em `prospected_places`
- [ ] Três artefatos (migration + baseline + MANIFEST) juntos no mesmo commit
- [ ] Gate: `pnpm test:db` (install + update do baseline)

**Tests:** integration (invariants harness)
**Gate:** full

**Commit:** `feat(db): tabelas de prospecção via Google Maps`

---

### T2: `lib/prospecting/score.ts`

**What:** `scoreInitial` e `scoreFinal` — fórmula pura conforme `design.md` (base por presença/qualidade de site + ajuste por rating/avaliações + rótulo).
**Where:** `lib/prospecting/score.ts`, `lib/prospecting/score.test.ts`
**Depends on:** None
**Reuses:** Doutrina de `lib/leads/score-formula.ts` ("fórmula, não IA")
**Requirement:** PROSPECT-02, PROSPECT-10

**Tools:** filesystem

**Done when:**

- [ ] `scoreInitial` cobre: sem site, site presente (base neutra), ajustes de rating/reviews, clamp 0-100
- [ ] `scoreFinal` cobre: site inalcançável, não-responsivo/lento, bom, todos com ajuste de rating/reviews
- [ ] Rótulo correto nas três faixas (Quente/Oportunidade/Baixa) nos limites exatos (69/70, 39/40)
- [ ] Gate: `pnpm exec vitest run lib/prospecting/score.test.ts`
- [ ] Test count: ≥10

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): fórmula de score inicial e final`

---

### T3: `lib/prospecting/places-client.ts`

**What:** Wrapper da Google Places API (New) `searchText`, paginação até 60 resultados (3×20), field mask explícito.
**Where:** `lib/prospecting/places-client.ts`, `lib/prospecting/places-client.test.ts`
**Depends on:** None
**Reuses:** Nenhum client existente (é novo)
**Requirement:** PROSPECT-01, PROSPECT-07

**Tools:** filesystem

**Done when:**

- [ ] Pagina até o teto de 60, respeitando delay do `pageToken`
- [ ] Retorna `placesApiCapped=true` quando bate no teto
- [ ] Field mask só com os 7 campos usados
- [ ] Erro de key/billing tratado com tipo de erro específico (não exception genérica)
- [ ] Gate: `pnpm exec vitest run lib/prospecting/places-client.test.ts` (fetch mockado)
- [ ] Test count: ≥6

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): client da Google Places API`

---

### T4: `POST /api/v1/prospecting/searches`

**What:** Rota que orquestra busca: Zod valida input → `requireRole('manager')` → `resolveActiveOrg()` → `places-client` → `score.scoreInitial` por linha → insere `prospected_searches`+`prospected_places` em lote → emite `event_log` (`prospected_place.site_quality_requested`, `external_id=prospected_places.id`) só para linhas com site.
**Where:** `app/api/v1/prospecting/searches/route.ts`, `lib/schemas/prospecting.ts`
**Depends on:** T1, T2, T3
**Reuses:** `ok()`/`fail()`, `requireRole`, `resolveActiveOrg`, `audit()`
**Requirement:** PROSPECT-01, PROSPECT-02, PROSPECT-03, PROSPECT-05, PROSPECT-08, PROSPECT-09

**Tools:** filesystem

**Done when:**

- [ ] Busca válida persiste tudo e retorna `{ searchId, places[] }`
- [ ] Linha sem site **não** gera evento em `event_log`
- [ ] Linha com site gera exatamente 1 evento
- [ ] Erro de Places API (quota/key) retorna `code` específico, sem insert parcial
- [ ] `requireRole('manager')` bloqueia `agent`/`viewer`
- [ ] Gate: `pnpm exec vitest run` da rota/schema + `pnpm typecheck` limpo nesta superfície

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): rota de busca no Google Maps`

---

### T5: `GET /api/v1/prospecting/searches` (+ `[id]`)

**What:** Lista histórico de buscas da organização; detalhe reabre uma busca persistida sem nova chamada à Places API.
**Where:** `app/api/v1/prospecting/searches/route.ts` (GET), `app/api/v1/prospecting/searches/[id]/route.ts`
**Depends on:** T1
**Reuses:** RLS já filtra por organização; `ok()`/`fail()`
**Requirement:** PROSPECT-06

**Tools:** filesystem

**Done when:**

- [ ] Lista retorna só buscas da organização ativa
- [ ] Detalhe retorna busca + todas as `prospected_places` associadas
- [ ] Busca de outra organização → 404 (mesmo padrão de `app/app/leads/[id]`)
- [ ] Gate: `pnpm exec vitest run` das rotas

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): histórico e reabertura de buscas`

---

### T6: UI `/app/prospeccao` — formulário e tabela paginada

**What:** Página nova (padrão `app/app/radar/page.tsx`): formulário (tipo de negócio, localidade, serviço fixo) + tabela paginada 15/15 dos até 60 resultados, aviso quando `placesApiCapped=true`.
**Where:** `app/app/prospeccao/page.tsx`, `app/app/prospeccao/[searchId]/page.tsx`, `app/app/prospeccao/_components/ProspectingSearchForm.tsx`, `app/app/prospeccao/_components/ProspectingResultsTable.tsx`
**Depends on:** T4, T5
**Reuses:** `requireAuth`/`resolveActiveOrg`/`requireRole` herdados de `app/app/layout.tsx`; padrão de Server Component + `_components/` Client Component
**Requirement:** PROSPECT-01, PROSPECT-02, PROSPECT-04, PROSPECT-07

**Tools:** filesystem

**Done when:**

- [ ] Buscar mostra resultados sem reload; erro de API vira mensagem amigável
- [ ] Paginação 15/15 sem nova chamada de rede entre páginas
- [ ] Teto de 60 mostra aviso explicando (não bota botão de "carregar mais")
- [ ] `agent`/`viewer` não acessa a rota (redirect/403)
- [ ] Gate: `pnpm lint` + `pnpm typecheck` nos arquivos novos

**Tests:** unit (smoke de paginação) — e2e completo fica em T14
**Gate:** quick

**Commit:** `feat(prospecting): tela de busca e resultados`

---

### T7: Chromium no `Dockerfile.worker`

**What:** Mover `playwright` de devDependencies para dependency do worker; instalar Chromium na imagem (`npx playwright install --with-deps chromium` ou base image equivalente).
**Where:** `Dockerfile.worker`, `package.json`
**Depends on:** None
**Reuses:** `Dockerfile.worker` já existe separado da imagem principal (não precisa criar)
**Requirement:** Pré-requisito de infraestrutura para PROSPECT-10 (não tem ID de spec próprio)

**Tools:** Docker

**Done when:**

- [ ] `docker build -f Dockerfile.worker .` conclui com Chromium instalado
- [ ] Imagem principal (`Dockerfile`, não `.worker`) **não** ganha peso do Chromium
- [ ] Gate: build local do worker + smoke (`chromium.launch()` roda sem erro dentro do container)

**Tests:** manual (build + smoke), sem automação de CI nesta task
**Gate:** full

**Commit:** `build(worker): instala Chromium para Playwright em produção`

---

### T8: `prospecting-site-quality-worker` + handler

**What:** Consome `prospected_place.site_quality_requested`; abre o site (Playwright, timeout 15s), mede indicadores, extrai e-mail, chama `score.scoreFinal`, persiste em `prospected_places`.
**Where:** `workers/prospecting-site-quality-worker.ts`, `workers/prospecting-site-quality-worker.handler.ts`, `workers/prospecting-site-quality-worker.test.ts`
**Depends on:** T2, T7
**Reuses:** Formato de `workers/media-persist-worker.handler.ts` (par lógica + registro no dispatcher); `lib/supabase/admin.ts`
**Requirement:** PROSPECT-10, PROSPECT-11

**Tools:** filesystem · Playwright

**Done when:**

- [ ] Sucesso: `site_analysis_status='done'`, `score_final` recalculado, `email` preenchido se encontrado
- [ ] Timeout/erro: `site_analysis_status='failed'`, `site_analysis_result.error` preenchido, **não** propaga exceção pro dispatcher
- [ ] Nenhuma exceção de um site derruba o processamento de outro evento
- [ ] Gate: `pnpm exec vitest run workers/prospecting-site-quality-worker.test.ts` (Playwright mockado)
- [ ] Test count: ≥6

**Tests:** unit
**Gate:** quick (unit) — integração real depende de T7 estar deployado

**Commit:** `feat(prospecting): worker de análise de qualidade de site`

---

### T9: Realtime na tabela de resultados

**What:** `ProspectingResultsTable` assina `postgres_changes` em `prospected_places` filtrado por `search_id`; atualiza a linha (score, rótulo, e-mail, status) quando o worker termina, sem refresh manual.
**Where:** `app/app/prospeccao/_components/ProspectingResultsTable.tsx` (estende T6)
**Depends on:** T6, T8
**Reuses:** Padrão de assinatura Realtime já usado em inbox/kanban
**Requirement:** PROSPECT-12

**Tools:** filesystem

**Done when:**

- [ ] Linha com site nasce com indicador "analisando..."
- [ ] Quando o worker atualiza a linha no banco, a UI reflete sem reload (testável simulando update direto na tabela)
- [ ] Desmonta a assinatura ao sair da tela (sem vazamento de conexão)
- [ ] Gate: `pnpm typecheck` + teste manual com update simulado

**Tests:** unit (mock do canal Realtime)
**Gate:** quick

**Commit:** `feat(prospecting): atualização em tempo real da análise de site`

---

### T10: Invariantes de RLS e idempotência

**What:** Testes de integração: isolamento cross-tenant nas 2 tabelas novas; segunda análise pedida pra mesma linha não gera job duplicado (`unique(organization_id, external_id)` + captura `23505`).
**Where:** `tests/invariants/prospecting.test.ts`
**Depends on:** T1, T4, T8
**Reuses:** Fixtures de org A/B já usadas nos outros invariantes
**Requirement:** PROSPECT-13

**Tools:** filesystem · Docker

**Done when:**

- [ ] Tenant B não lê `prospected_searches`/`prospected_places` do tenant A
- [ ] Dois pedidos de análise pra mesma linha → 1 evento só processado (o segundo é no-op, sem erro visível pro operador)
- [ ] Gate: `pnpm test:db`

**Tests:** integration
**Gate:** full

**Commit:** `test(db): isolamento e idempotência da prospecção`

---

### T11: Ações manuais — WhatsApp, exportar CSV, tentar de novo

**What:** Botão WhatsApp (`wa.me` com mensagem pronta, desabilitado sem telefone válido), botão exportar CSV (com e-mail), botão "tentar de novo" visível só quando `site_analysis_status='failed'` (chama `POST .../reanalyze`).
**Where:** `app/app/prospeccao/_components/ProspectingResultsTable.tsx` (estende T9), `app/api/v1/prospecting/places/[id]/reanalyze/route.ts`
**Depends on:** T6, T8
**Reuses:** Nenhuma automação existente (deliberadamente não usa `sendMessageHandler`)
**Requirement:** PROSPECT-14, PROSPECT-15, PROSPECT-16

**Tools:** filesystem

**Done when:**

- [ ] Telefone válido → link `wa.me` correto com mensagem pré-preenchida
- [ ] Telefone ausente/inválido → botão desabilitado, sem link quebrado
- [ ] CSV exportado tem todas as colunas incluindo e-mail (vazio quando não houver)
- [ ] "Tentar de novo" só aparece com `status='failed'`, reemite evento respeitando idempotência (T10)
- [ ] Gate: `pnpm lint` + `pnpm exec vitest run` da rota de reanalyze

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): ações manuais de contato e exportação`

---

### T12: `lib/prospecting/promote.ts` + rota de promoção

**What:** `promoteToLead` — cria/reaproveita `contacts`, cria `crm_leads` (`source='google_maps_prospecting'`) no pipeline default/etapa de menor `position`, cria `crm_lead_links` (`target_kind='external'`) de volta pra `prospected_places`.
**Where:** `lib/prospecting/promote.ts`, `lib/prospecting/promote.test.ts`, `app/api/v1/prospecting/places/[id]/promote/route.ts`
**Depends on:** T1
**Reuses:** Padrão de `lib/leads/nascimento-do-lead.ts` (motivos tipados, pipeline default, etapa de menor `position`)
**Requirement:** PROSPECT-17, PROSPECT-18

**Tools:** filesystem

**Done when:**

- [ ] Telefone já existente em `contacts` da org → reaproveita, não duplica
- [ ] Cria `crm_leads` com `source`/`source_metadata` corretos, no pipeline default
- [ ] Cria `crm_lead_links` com `target_kind='external'` apontando pra `prospected_places.id`
- [ ] Linha já promovida → erro tipado `ja_promovido`, sem segunda promoção
- [ ] Gate: `pnpm exec vitest run lib/prospecting/promote.test.ts`
- [ ] Test count: ≥6

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): promoção de resultado para o funil do CRM`

---

### T13: Coluna de observação com link pro lead promovido

**What:** Linha promovida (`promoted_lead_id` não nulo) mostra nota (ex.: etapa atual) com link pra `/app/leads/[promotedLeadId]`, no lugar do botão de promover.
**Where:** `app/app/prospeccao/_components/ProspectingResultsTable.tsx` (estende T9/T11)
**Depends on:** T6, T12
**Reuses:** `app/app/leads/[id]/page.tsx` como destino (rota já existe, não cria nada nova)
**Requirement:** PROSPECT-19

**Tools:** filesystem

**Done when:**

- [ ] Linha promovida mostra link, não mais o botão "Promover"
- [ ] Clicar no link abre `/app/leads/[id]` do lead certo
- [ ] Gate: `pnpm typecheck` + `pnpm lint`

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): link direto pro lead promovido na tabela`

---

### T14: E2E completo

**What:** Playwright: buscar → ver resultados com score inicial → aguardar/mockar análise de site → promover uma linha → conferir link pro lead na tabela e o card no Kanban.
**Where:** `tests/e2e/prospeccao.spec.ts`
**Depends on:** T9, T11, T13
**Reuses:** Helpers de credenciais/seed dos specs e2e existentes
**Requirement:** Cobertura de todas as fases (evidência final)

**Tools:** Playwright

**Done when:**

- [ ] Spec verde contra app + banco semeado
- [ ] Evidência visual: tabela com scores + card no Kanban após promoção
- [ ] Gate: spec Playwright deste arquivo

**Tests:** e2e
**Gate:** full

**Commit:** `test(e2e): fluxo completo de prospecção via Google Maps`

---

## Parallel Execution Map

```
Phase 1: T1 [P], T2 [P], T3 [P], T7 [P] — nenhuma depende de outra
Phase 2: T4 após T1+T2+T3; T5 após T1 (T5 é [P] com T2/T3/T4, só precisa de T1)
         T6 após T4+T5
Phase 3: T8 após T2+T7; T9 após T6+T8; T10 após T1+T4+T8
         T9 e T10 são [P] entre si (arquivos diferentes: UI vs. teste de invariantes)
Phase 4: T12 após T1 apenas — pode rodar bem cedo, em paralelo com toda a Fase 2/3 [P]
         T11 após T6+T8; T13 após T6+T12
         T11 e T13 são [P] entre si (arquivos diferentes: ações vs. coluna de observação — cuidado: ambos tocam ProspectingResultsTable.tsx, então na prática são sequenciais nesse arquivo, mesmo sendo logicamente independentes)
Phase 5: T14 após T9+T11+T13 — não é [P], é o fechamento
```

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 migration | 3 arquivos, 1 conceito | ⚠️ cohesivo (obrigatório junto, doutrina de baseline) |
| T2 score | 1 módulo + teste | ✅ |
| T3 places-client | 1 módulo + teste | ✅ |
| T4 rota de busca | rota + schema | ⚠️ cohesivo |
| T5 rotas de histórico | 2 rotas, 1 conceito | ⚠️ cohesivo |
| T6 UI busca | pasta, 1 conceito | ⚠️ pasta |
| T7 Docker | 2 arquivos, 1 conceito | ⚠️ cohesivo |
| T8 worker | par lógica+handler+teste (padrão fixo) | ✅ |
| T9 realtime | 1 componente (estende T6) | ✅ |
| T10 invariantes | 1 arquivo teste | ✅ |
| T11 ações manuais | componente + 1 rota | ⚠️ cohesivo |
| T12 promote | lib + 1 rota | ⚠️ cohesivo |
| T13 link observação | 1 componente (estende T9/T11) | ✅ |
| T14 e2e | 1 spec | ✅ |

T1/T4/T5/T6/T7/T11/T12 são 2–3 arquivos do mesmo conceito — OK, mesmo padrão aceito no exemplo de referência (`crm-automacao-fluxos`).

---

## Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram | Status |
| --- | --- | --- | --- |
| T1 | None | Phase 1 | ✅ |
| T2 | None | Phase 1 | ✅ |
| T3 | None | Phase 1 | ✅ |
| T4 | T1, T2, T3 | Phase 2 | ✅ |
| T5 | T1 | Phase 2 | ✅ |
| T6 | T4, T5 | Phase 2 | ✅ |
| T7 | None | Phase 1 | ✅ |
| T8 | T2, T7 | Phase 3 | ✅ |
| T9 | T6, T8 | Phase 3 | ✅ |
| T10 | T1, T4, T8 | Phase 3 | ✅ |
| T11 | T6, T8 | Phase 4 | ✅ |
| T12 | T1 | Phase 4 | ✅ |
| T13 | T6, T12 | Phase 4 | ✅ |
| T14 | T9, T11, T13 | Phase 5 | ✅ |

Todos batem — diagrama foi derivado direto da coluna "Depends on", não escrito separadamente.

---

## Test Co-location Validation

| Task | Layer | Matrix | Task Tests | Status |
| --- | --- | --- | --- | --- |
| T1 | db/schema | integration | integration | ✅ |
| T2 | lib | unit | unit | ✅ |
| T3 | lib | unit | unit | ✅ |
| T4 | API | unit | unit | ✅ |
| T5 | API | unit | unit | ✅ |
| T6 | UI | unit/typecheck | unit | ✅ |
| T7 | infra | build manual | manual | ✅ (sem matrix automatizada — infra) |
| T8 | worker | unit | unit | ✅ |
| T9 | UI | unit | unit | ✅ |
| T10 | db | integration | integration | ✅ |
| T11 | UI + API | unit | unit | ✅ |
| T12 | lib + API | unit | unit | ✅ |
| T13 | UI | unit | unit | ✅ |
| T14 | UI journey | e2e | e2e | ✅ |

---

## Requirement mapping

| ID | Tasks |
| --- | --- |
| PROSPECT-01 | T3, T4, T6 |
| PROSPECT-02 | T2, T4, T6 |
| PROSPECT-03 | T1, T4 |
| PROSPECT-04 | T6 |
| PROSPECT-05 | T4 |
| PROSPECT-06 | T5 |
| PROSPECT-07 | T3, T6 |
| PROSPECT-08 | T4 |
| PROSPECT-09 | T4 |
| PROSPECT-10 | T2, T7, T8 |
| PROSPECT-11 | T8 |
| PROSPECT-12 | T9 |
| PROSPECT-13 | T4, T10 |
| PROSPECT-14 | T11 |
| PROSPECT-15 | T11 |
| PROSPECT-16 | T11 |
| PROSPECT-17 | T12 |
| PROSPECT-18 | T12 |
| PROSPECT-19 | T12, T13 |

Coverage: 19/19 mapped.
