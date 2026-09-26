# Prospecção — Nichos e Enriquecimento — Tasks

**Design:** `.specs/features/prospeccao-nichos-e-enriquecimento/design.md`
**Status:** Draft

---

## Execution Plan

### Phase 1: Fundação (paralelo)

```
T1, T3, T4, T5, T6, T16 — nenhuma depende de outra
```

### Phase 2: Schema de enriquecimento + API de nicho

```
T1 → T2
T1 → T7
```

### Phase 3: Rota de busca + workers

```
T1, T3 → T8
T2, T4, T6, T16 → T9
T2, T5, T6, T16 → T10
T1 → T11
```

### Phase 4: Invariantes + UI base

```
T1, T7 → T12
T7 → T13
T8, T13 → T14
```

### Phase 5: UI final

```
T9, T10, T11, T14 → T15
```

### Phase 6: E2E

```
T14, T15, T12 → T17
```

---

## Task Breakdown

### T1: Migration `prospecting_niches`

**What:** Tabela nova de nichos por organização (`name`, `service_type`, `search_terms`, `requirements` jsonb, `weights` jsonb), RLS, + `prospected_searches.niche_id` (FK not null) + `prospected_places.requisitos_ok`/`motivo_requisitos`.
**Where:** `supabase/migrations/YYYYMMDDHHMMSS_0236_prospeccao_nichos.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
**Depends on:** None
**Reuses:** Padrão `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`
**Requirement:** PROSPECT2-01

**Tools:** filesystem

**Done when:**

- [ ] `prospecting_niches` criada conforme `design.md`, RLS + policy de isolamento
- [ ] `prospected_searches.niche_id` adicionada (FK, not null, sem cascade)
- [ ] `prospected_places.requisitos_ok` (default `true`) e `motivo_requisitos` adicionadas
- [ ] Três artefatos (migration + baseline + MANIFEST) juntos no mesmo commit
- [ ] Gate: `pnpm test:db`

**Tests:** integration (invariants harness)
**Gate:** full

**Commit:** `feat(db): tabela de nichos de prospecção`

---

### T2: Migration enriquecimento — colunas de CNPJ e Instagram

**What:** Em `prospected_places`: `cnpj_data`/`cnpj_status`/`cnpj_consultado_em`, `instagram_data`/`instagram_status`/`instagram_consultado_em`, mesmos 5 valores de status que `site_analysis_status` já usa.
**Where:** `supabase/migrations/YYYYMMDDHHMMSS_0237_prospeccao_enriquecimento.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
**Depends on:** T1
**Reuses:** Mesmo formato de `site_analysis_status`/`site_analysis_result` (migration 0234)
**Requirement:** habilita PROSPECT2-07, PROSPECT2-08, PROSPECT2-09 (schema, sem comportamento próprio)

**Tools:** filesystem

**Done when:**

- [ ] 6 colunas novas criadas com os CHECK de status corretos
- [ ] Realtime já cobre (publicação é por tabela, não por coluna — conferir que nada precisa mudar em `0235`)
- [ ] Gate: `pnpm test:db`

**Tests:** integration (invariants harness)
**Gate:** full

**Commit:** `feat(db): colunas de enriquecimento de CNPJ e Instagram`

---

### T3: `lib/prospecting/score.ts` — genérico por nicho

**What:** `scoreInitial`/`scoreFinal` passam a receber `weights: NicheWeights` em vez de usar constantes; `checkRequirements(place, requirements)` novo, separado do score.
**Where:** `lib/prospecting/score.ts`, `lib/prospecting/score.test.ts`, `lib/prospecting/check-requirements.test.ts`
**Depends on:** None
**Reuses:** Estrutura e casos de teste já existentes de `score.ts` (mesmos limites 69/70, 39/40, agora parametrizados)
**Requirement:** PROSPECT2-04, PROSPECT2-05

**Tools:** filesystem

**Done when:**

- [ ] `scoreInitial`/`scoreFinal` aceitam `weights` e o resultado muda com pesos diferentes pro mesmo input (teste comparando 2 conjuntos de pesos)
- [ ] `checkRequirements` cobre: dentro da faixa, fora da faixa (min e max), `exigeCelular`/`exigeSite` faltando
- [ ] Rótulo (quente/oportunidade/baixa) continua correto nos mesmos limites de antes
- [ ] Gate: `pnpm exec vitest run lib/prospecting/score.test.ts lib/prospecting/check-requirements.test.ts`
- [ ] Test count: ≥14 (mantém os ≥10 anteriores + novos de `checkRequirements`)

**Tests:** unit
**Gate:** quick

**Commit:** `refactor(prospecting): score parametrizado por nicho`

---

### T4: `lib/prospecting/receita-client.ts`

**What:** Consulta CNPJ por nome de empresa; aceita só se o CEP bater com o endereço do Maps.
**Where:** `lib/prospecting/receita-client.ts`, `lib/prospecting/receita-client.test.ts`
**Depends on:** None
**Reuses:** Nenhum client existente (é novo); regra de validação por CEP replicada do kit
**Requirement:** habilita PROSPECT2-08

**Tools:** filesystem

**Done when:**

- [ ] CEP bate → devolve razão social, sócio-administrador, abertura, porte
- [ ] CEP não bate → devolve motivo, não aceita o CNPJ
- [ ] Erro de rede/timeout tratado sem exception não capturada
- [ ] Gate: `pnpm exec vitest run lib/prospecting/receita-client.test.ts` (fetch mockado)
- [ ] Test count: ≥6

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): client de consulta de CNPJ`

---

### T5: `lib/prospecting/apify-client.ts` — leitura de Instagram

**What:** Lê um perfil de Instagram via ator do Apify (seguidores, posts, dias sem postar, engajamento médio).
**Where:** `lib/prospecting/apify-client.ts`, `lib/prospecting/apify-client.test.ts`
**Depends on:** None
**Reuses:** Mesmo ator/API do kit
**Requirement:** habilita PROSPECT2-09

**Tools:** filesystem

**Done when:**

- [ ] Perfil válido devolve os 4 campos
- [ ] Token inválido (401) e crédito esgotado (402) tratados com mensagem específica, não exception genérica
- [ ] Gate: `pnpm exec vitest run lib/prospecting/apify-client.test.ts` (fetch mockado)
- [ ] Test count: ≥5

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): client de leitura de Instagram via Apify`

---

### T6: `lib/prospecting/pesquisa-client.ts` — busca no Google via Apify

**What:** Réplica de `lib/pesquisa.mjs` do kit — busca no Google (`apify~google-search-scraper`) pra achar o que faltou (Instagram, CNPJ), até 3 tentativas por termo, nunca inventa link.
**Where:** `lib/prospecting/pesquisa-client.ts`, `lib/prospecting/pesquisa-client.test.ts`
**Depends on:** None
**Reuses:** Mesmo ator do kit (`apify~google-search-scraper`), mesma lista `NAO_E_SITE` de domínios a ignorar
**Requirement:** habilita PROSPECT2-09 (Instagram) e a cascata de PROSPECT2-08 (CNPJ)

**Tools:** filesystem

**Done when:**

- [ ] Busca em lote (várias queries numa chamada só, mesmo formato do kit)
- [ ] 3 tentativas por termo, formatos diferentes; não achou na terceira → lista vazia, sem 4ª tentativa
- [ ] Resultado de domínio da lista `NAO_E_SITE` descartado
- [ ] Gate: `pnpm exec vitest run lib/prospecting/pesquisa-client.test.ts` (fetch mockado)
- [ ] Test count: ≥8

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): client de pesquisa no Google via Apify`

---

### T7: API de nichos — `POST`/`GET`/`PATCH /api/v1/prospecting/niches`

**What:** CRUD de nicho; Zod valida pesos somando 100; edição não recalcula buscas antigas (é UPDATE simples, sem trigger de recomputo).
**Where:** `app/api/v1/prospecting/niches/route.ts`, `app/api/v1/prospecting/niches/[id]/route.ts`, `lib/schemas/prospecting.ts`
**Depends on:** T1
**Reuses:** `ok()`/`fail()`, `requireRole('manager')`, `resolveActiveOrg()`, `audit()`
**Requirement:** PROSPECT2-02, PROSPECT2-14

**Tools:** filesystem

**Done when:**

- [ ] Criar nicho com pesos somando 100 → sucesso
- [ ] Criar/editar com pesos que não somam 100 → 400, `code='weights_not_100'`, mostra o total
- [ ] `GET` lista só nichos da organização ativa (RLS)
- [ ] `PATCH` edita um nicho existente; busca antiga associada não muda `score_initial`/`score_final` (teste explícito)
- [ ] `requireRole('manager')` bloqueia `agent`/`viewer`
- [ ] Gate: `pnpm exec vitest run` da rota/schema + `pnpm typecheck` limpo nesta superfície

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): CRUD de nichos`

---

### T8: `POST /api/v1/prospecting/searches` — alterado pra usar nicho

**What:** Zod troca `serviceType: z.literal(...)` por `nicheId: z.string().uuid()`; busca o nicho, usa `weights`/`requirements` no `score.ts` novo e no `checkRequirements`; emite `cnpj_requested` pra todo resultado; emite `instagram_requested` direto só pra quem não tem site (e `weights.instagram > 0`).
**Where:** `app/api/v1/prospecting/searches/route.ts`, `lib/schemas/prospecting.ts`
**Depends on:** T1, T3
**Reuses:** `places-client.ts`, `ok()`/`fail()`, `requireRole`, `resolveActiveOrg`, `audit()` (todos já existem, da feature anterior)
**Requirement:** PROSPECT2-03, PROSPECT2-04, PROSPECT2-06, PROSPECT2-07, PROSPECT2-09, PROSPECT2-10

**Tools:** filesystem

**Done when:**

- [ ] Busca sem `nicheId` → 400, `code='niche_required'`
- [ ] `nicheId` de outra organização → 404 (RLS)
- [ ] Score de cada resultado usa os pesos do nicho escolhido (teste com 2 nichos diferentes pro mesmo resultado)
- [ ] Resultado fora dos requisitos do nicho → `requisitos_ok=false` + `motivo_requisitos` preenchido
- [ ] `cnpj_requested` emitido pra 100% dos resultados
- [ ] `instagram_requested` emitido só pra resultados sem site, e só se `weights.instagram > 0`
- [ ] Gate: `pnpm exec vitest run` da rota + `pnpm typecheck` limpo

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): busca usa nicho configurável`

---

### T9: `prospecting-cnpj-worker` + handler

**What:** Consome `prospected_place.cnpj_requested`. Tenta `receita-client` pelo nome; se não achar/CEP não bater, cai pra `pesquisa-client` (nome + "CNPJ") e tenta de novo. Guard de idempotência por `cnpj_status` (claim otimista, mesmo padrão do `site-quality-worker`).
**Where:** `workers/prospecting-cnpj-worker.ts`, `workers/prospecting-cnpj-worker.handler.ts`, `tests/unit/prospecting-cnpj-worker.test.ts`
**Depends on:** T2, T4, T6, T16
**Reuses:** Estrutura exata de `prospecting-site-quality-worker.ts` (guard de claim otimista, formato de arquivo)
**Requirement:** PROSPECT2-08, PROSPECT2-11, PROSPECT2-12

**Tools:** filesystem

**Done when:**

- [ ] CNPJ achado direto pelo nome → grava e sai, sem pesquisa
- [ ] CNPJ não achado direto → cai pra pesquisa, valida CEP do candidato, grava se bater
- [ ] Nenhum candidato bate → `cnpj_status='done'`, `cnpj_data=null`, motivo salvo (não é `'failed'`)
- [ ] Erro de rede → `cnpj_status='failed'`, não derruba o worker
- [ ] Claim concorrente perdido → no-op, sem rodar a consulta duas vezes
- [ ] Gate: `pnpm exec vitest run tests/unit/prospecting-cnpj-worker.test.ts`
- [ ] Test count: ≥10

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): worker de enriquecimento de CNPJ`

---

### T10: `prospecting-instagram-worker` + handler

**What:** Consome `prospected_place.instagram_requested`. Link já veio do site (T11) → valida e lê direto. Sem link → `pesquisa-client` acha candidato, valida marca no @/nome/bio, lê. Recalcula `score_final` com o peso de Instagram do nicho. Mesmo guard de idempotência por `instagram_status`.
**Where:** `workers/prospecting-instagram-worker.ts`, `workers/prospecting-instagram-worker.handler.ts`, `tests/unit/prospecting-instagram-worker.test.ts`
**Depends on:** T2, T5, T6, T16
**Reuses:** Estrutura exata de `prospecting-site-quality-worker.ts`
**Requirement:** PROSPECT2-09, PROSPECT2-11, PROSPECT2-12

**Tools:** filesystem

**Done when:**

- [ ] Link vindo do site → lê direto, sem pesquisa
- [ ] Sem link → pesquisa, valida candidato, lê
- [ ] Candidato inválido (perfil genérico, sem marca) → descartado, `instagram_status='done'` com `instagram_data=null` + motivo
- [ ] `score_final` recalculado incorporando o peso de Instagram do nicho da busca
- [ ] Falha isolada por linha (mesmo padrão do site-quality)
- [ ] Gate: `pnpm exec vitest run tests/unit/prospecting-instagram-worker.test.ts`
- [ ] Test count: ≥10

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): worker de enriquecimento de Instagram`

---

### T11: `prospecting-site-quality-worker` — estendido

**What:** Ganha regex de link de Instagram no HTML (mesmo padrão do `mailto:` já existente). Ao terminar, emite `prospected_place.instagram_requested` sempre que `weights.instagram > 0` do nicho da busca (achou link ou não — quem decide o que fazer é o T10).
**Where:** `workers/prospecting-site-quality-worker.ts`, `workers/prospecting-site-quality-worker.test.ts` (casos novos)
**Depends on:** T1
**Reuses:** Worker já existente — extensão, não reescrita
**Requirement:** PROSPECT2-09, PROSPECT2-10

**Tools:** filesystem

**Done when:**

- [ ] HTML com link de Instagram → extraído e passado no evento
- [ ] HTML sem link → evento ainda emitido (sem link), se peso > 0
- [ ] `weights.instagram === 0` → evento **não** emitido
- [ ] Comportamento anterior (email, `site_analysis_status`, `score_final` do site) inalterado — testes existentes continuam passando
- [ ] Gate: `pnpm exec vitest run workers/prospecting-site-quality-worker.test.ts`

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): site-quality-worker extrai link de Instagram`

---

### T12: Invariantes de RLS — `prospecting_niches`

**What:** Prova comportamental (JWT simulado + contagem cross-org) de que um nicho de uma organização nunca vaza pra outra — mesmo formato do que já existe pras outras 2 tabelas.
**Where:** `tests/invariants/prospecting.test.ts` (estendido)
**Depends on:** T1, T7
**Reuses:** Mesmo harness e padrão de teste já usado pra `prospected_searches`/`prospected_places`
**Requirement:** validação cruzada de PROSPECT2-01 (sem ID de requirement próprio)

**Tools:** filesystem

**Done when:**

- [ ] Organização A não lê nichos da organização B (RLS)
- [ ] Organização A não escreve/edita nicho da organização B
- [ ] `tests/invariants/rls-completude-varredura.test.ts` para de listar `prospecting_niches` como "sem prova comportamental"
- [ ] Gate: `pnpm test:db`

**Tests:** integration (invariants harness)
**Gate:** full

**Commit:** `test(prospecting): invariantes de RLS para nichos`

---

### T13: UI `/app/prospeccao/nichos` — formulário guiado + lista

**What:** Lista de nichos da organização + `NicheWizard` (passo a passo, mesmas perguntas de `MEU-CLIENTE-IDEAL.md` do kit, valores padrão sugeridos, mostra o nicho resultante antes de salvar).
**Where:** `app/app/prospeccao/nichos/page.tsx`, `app/app/prospeccao/nichos/_components/NicheWizard.tsx`, `app/app/prospeccao/nichos/_components/NicheList.tsx`
**Depends on:** T7
**Reuses:** `requireAuth`/`resolveActiveOrg`/`requireRole` herdados de `app/app/layout.tsx`; `react-hook-form` + `@hookform/resolvers/zod` (já são dependências do projeto)
**Requirement:** PROSPECT2-13

**Tools:** filesystem

**Done when:**

- [ ] Criar nicho do zero só pelo wizard, sem tocar em JSON
- [ ] Pesos que não somam 100 bloqueiam o passo final, mostrando o total
- [ ] Editar nicho existente vem pré-preenchido, avisa que vale só pra buscas futuras
- [ ] `agent`/`viewer` não acessa a rota
- [ ] Gate: `pnpm lint` + `pnpm typecheck` nos arquivos novos

**Tests:** unit (smoke do wizard) — e2e completo fica em T17
**Gate:** quick

**Commit:** `feat(prospecting): tela de criação/edição de nicho`

---

### T14: UI busca — seletor de nicho + filtros novos

**What:** `ProspectingSearchForm` exige escolher um nicho (não mais serviço fixo); orienta a criar um primeiro nicho se não houver nenhum. `ProspectingResultsTable` ganha filtros de nicho, reprovado-nos-requisitos, e mantém os já existentes.
**Where:** `app/app/prospeccao/_components/ProspectingSearchForm.tsx`, `app/app/prospeccao/_components/ProspectingResultsTable.tsx`
**Depends on:** T8, T13
**Reuses:** Componentes e padrão de filtro já existentes na tabela
**Requirement:** PROSPECT2-06, PROSPECT2-17

**Tools:** filesystem

**Done when:**

- [ ] Sem nicho cadastrado → formulário orienta a criar um, busca fica desabilitada
- [ ] Com nicho(s) → seletor mostra todos da organização
- [ ] Filtro "reprovado nos requisitos" esconde por padrão (mesmo espírito do painel do kit), chip pra mostrar todos
- [ ] Gate: `pnpm lint` + `pnpm typecheck`

**Tests:** unit
**Gate:** quick

**Commit:** `feat(prospecting): seletor de nicho e filtros na busca`

---

### T15: UI ficha — `/app/prospeccao/[searchId]/[placeId]`

**What:** Tela nova, seis blocos coloridos (Google/Instagram/Site/Receita/Contato/Venda), estado vazio claro por bloco quando a etapa não rodou, reaproveitando `Card`/`Badge`/`STATUS_META`.
**Where:** `app/app/prospeccao/[searchId]/[placeId]/page.tsx`, `app/app/prospeccao/[searchId]/[placeId]/_components/PlaceFicha.tsx`
**Depends on:** T9, T10, T11, T14
**Reuses:** `STATUS_META` estendido, componentes já usados em `ProspectingResultsTable.tsx`; link de saída a partir da tabela (T14)
**Requirement:** PROSPECT2-15, PROSPECT2-16

**Tools:** filesystem

**Done when:**

- [ ] Os 6 blocos aparecem, cada um com cor própria
- [ ] Bloco de etapa não rodada mostra "ainda não consultado", nunca erro
- [ ] Bloco de etapa que rodou e não achou nada (ex.: CNPJ) mostra "não encontrado" + motivo, distinto de "não consultado"
- [ ] Realtime atualiza a ficha sem reload quando um enriquecimento termina
- [ ] Gate: `pnpm lint` + `pnpm typecheck`

**Tests:** unit (smoke dos 6 blocos, incluindo estado vazio) — e2e completo fica em T17
**Gate:** quick

**Commit:** `feat(prospecting): ficha por empresa com 6 blocos`

---

### T16: `APIFY_TOKEN` provisionado

**What:** Variável de ambiente nova no worker (dev e produção) — hoje só existe no `.env.local` do kit solto.
**Where:** `.env.example` (linha nova, documentada), ambiente do worker em produção (fora do código desta feature)
**Depends on:** None
**Reuses:** Mesmo padrão de outras chaves server-only já documentadas em `.env.example`
**Requirement:** Pré-requisito de infraestrutura para PROSPECT2-08/09 (não tem ID de spec próprio)

**Tools:** filesystem, infra (fora do repo)

**Done when:**

- [ ] `.env.example` documenta `APIFY_TOKEN` com o link de onde tirar (console.apify.com/settings/integrations)
- [ ] Variável presente no ambiente de dev local e no ambiente do worker em produção
- [ ] Gate: smoke manual — `apify-client`/`pesquisa-client` fazem uma chamada real de teste e recebem 200

**Tests:** manual
**Gate:** full

**Commit:** `docs(env): documenta APIFY_TOKEN`

---

### T17: E2E completo

**What:** Jornada completa — criar nicho pelo wizard → rodar busca → ver resultados com score do nicho → abrir ficha de um resultado → ver os 6 blocos (incluindo um vazio corretamente) → editar o nicho e confirmar que a busca antiga não mudou.
**Where:** `tests/e2e/prospeccao.spec.ts` (estendido)
**Depends on:** T14, T15, T12
**Reuses:** Estrutura e seeds já existentes do E2E da feature anterior; Places/Apify/Receita continuam mockados (mesma ressalva já documentada: não é teste de integração real com as APIs externas)
**Requirement:** validação cruzada de todos os PROSPECT2-*

**Tools:** filesystem, Playwright

**Done when:**

- [ ] Jornada completa passa de ponta a ponta, sem intervenção manual
- [ ] Caso de "nicho reprova requisito" aparece corretamente escondido por padrão e visível com o chip
- [ ] Edição de nicho não muda score de busca antiga (asserção explícita no teste)
- [ ] Gate: `pnpm test:e2e -- prospeccao.spec.ts`

**Tests:** e2e
**Gate:** full

**Commit:** `test(prospecting): e2e de nichos e enriquecimento`

---

## Parallel Execution Map

```
Phase 1: T1 [P], T3 [P], T4 [P], T5 [P], T6 [P], T16 [P] — nenhuma depende de outra
Phase 2: T2 após T1; T7 após T1 — T2 e T7 são [P] entre si (arquivos diferentes)
Phase 3: T8 após T1+T3; T9 após T2+T4+T6+T16; T10 após T2+T5+T6+T16; T11 após T1
         T8, T9, T10, T11 são [P] entre si (arquivos diferentes) — cuidado: T9/T10/T11 tocam o mesmo
         diretório `workers/`, mas arquivos distintos, sem conflito real
Phase 4: T12 após T1+T7; T13 após T7; T14 após T8+T13
         T12 e T13 são [P] entre si; T14 espera os dois anteriores da sua cadeia (T8 já pronto da Fase 3)
Phase 5: T15 após T9+T10+T11+T14 — não é [P], depende de tudo que enriquece dado
Phase 6: T17 após T14+T15+T12 — fechamento, não é [P]
```

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 migration nichos | 3 arquivos, 1 conceito | ⚠️ cohesivo (doutrina de baseline) |
| T2 migration enriquecimento | 3 arquivos, 1 conceito | ⚠️ cohesivo |
| T3 score | 2 módulos + testes | ⚠️ cohesivo (score + checkRequirements, mesmo arquivo de origem) |
| T4 receita-client | 1 módulo + teste | ✅ |
| T5 apify-client | 1 módulo + teste | ✅ |
| T6 pesquisa-client | 1 módulo + teste | ✅ |
| T7 API de nichos | 3 arquivos, 1 conceito | ⚠️ cohesivo |
| T8 rota de busca | rota + schema | ⚠️ cohesivo |
| T9 worker CNPJ | par lógica+handler+teste (padrão fixo) | ✅ |
| T10 worker Instagram | par lógica+handler+teste (padrão fixo) | ✅ |
| T11 site-quality estendido | 1 arquivo + teste | ✅ |
| T12 invariantes | 1 arquivo teste | ✅ |
| T13 UI nichos | pasta, 1 conceito | ⚠️ pasta |
| T14 UI busca | 2 componentes, 1 conceito | ⚠️ cohesivo |
| T15 UI ficha | pasta, 1 conceito | ⚠️ pasta |
| T16 infra | 1 variável de ambiente | ✅ |
| T17 e2e | 1 spec | ✅ |

T1/T2/T3/T7/T8/T13/T14/T15 são 2–3 arquivos do mesmo conceito — mesmo padrão aceito na feature de referência (`prospeccao-google-maps`).

---

## Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram | Status |
| --- | --- | --- | --- |
| T1 | None | Phase 1 | ✅ |
| T2 | T1 | Phase 2 | ✅ |
| T3 | None | Phase 1 | ✅ |
| T4 | None | Phase 1 | ✅ |
| T5 | None | Phase 1 | ✅ |
| T6 | None | Phase 1 | ✅ |
| T7 | T1 | Phase 2 | ✅ |
| T8 | T1, T3 | Phase 3 | ✅ |
| T9 | T2, T4, T6, T16 | Phase 3 | ✅ |
| T10 | T2, T5, T6, T16 | Phase 3 | ✅ |
| T11 | T1 | Phase 3 | ✅ |
| T12 | T1, T7 | Phase 4 | ✅ |
| T13 | T7 | Phase 4 | ✅ |
| T14 | T8, T13 | Phase 4 | ✅ |
| T15 | T9, T10, T11, T14 | Phase 5 | ✅ |
| T16 | None | Phase 1 | ✅ |
| T17 | T14, T15, T12 | Phase 6 | ✅ |

Todos batem — diagrama derivado direto da coluna "Depends on".

---

## Test Co-location Validation

| Task | Layer | Matrix | Task Tests | Status |
| --- | --- | --- | --- | --- |
| T1 | db/schema | integration | integration | ✅ |
| T2 | db/schema | integration | integration | ✅ |
| T3 | lib | unit | unit | ✅ |
| T4 | lib | unit | unit | ✅ |
| T5 | lib | unit | unit | ✅ |
| T6 | lib | unit | unit | ✅ |
| T7 | API | unit | unit | ✅ |
| T8 | API | unit | unit | ✅ |
| T9 | worker | unit | unit | ✅ |
| T10 | worker | unit | unit | ✅ |
| T11 | worker | unit | unit | ✅ |
| T12 | db | integration | integration | ✅ |
| T13 | UI | unit/typecheck | unit | ✅ |
| T14 | UI | unit/typecheck | unit | ✅ |
| T15 | UI | unit/typecheck | unit | ✅ |
| T16 | infra | manual | manual | ✅ (sem matrix automatizada — infra) |
| T17 | UI journey | e2e | e2e | ✅ |

---

## Requirement mapping

| ID | Tasks |
| --- | --- |
| PROSPECT2-01 | T1, T12 |
| PROSPECT2-02 | T7 |
| PROSPECT2-03 | T8 |
| PROSPECT2-04 | T3, T8 |
| PROSPECT2-05 | T3, T8 |
| PROSPECT2-06 | T8, T14 |
| PROSPECT2-07 | T8 |
| PROSPECT2-08 | T4, T6, T9 |
| PROSPECT2-09 | T5, T6, T8, T10, T11 |
| PROSPECT2-10 | T8, T11 |
| PROSPECT2-11 | T9, T10 |
| PROSPECT2-12 | T9, T10 |
| PROSPECT2-13 | T13 |
| PROSPECT2-14 | T7 |
| PROSPECT2-15 | T15 |
| PROSPECT2-16 | T15 |
| PROSPECT2-17 | T14 |
