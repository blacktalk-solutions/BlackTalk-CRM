# Prospecção — Nichos configuráveis e enriquecimento (Instagram + CNPJ)

**Slug:** `prospeccao-nichos-e-enriquecimento`
**Status:** Draft (aguardando aprovação)
**Data:** 2026-09-22
**Base escrita (CONFIRMADO):** `CLAUDE.md` (doutrina DIRC, multi-tenant, Definition of Done), `.specs/features/prospeccao-google-maps/spec.md` + `design.md` (feature original — esta é a continuação dela), `lib/prospecting/score.ts` (fórmula hardcoded a generalizar), `lib/schemas/prospecting.ts` (`serviceType` travado em literal `"venda_de_site"`), `supabase/migrations/20260916120000_0234_prospeccao_google_maps.sql` (schema real de `prospected_searches`/`prospected_places`), `app/app/prospeccao/_components/ProspectingResultsTable.tsx` (padrão de UI atual: `@/components/ui/{badge,card,table}`, `STATUS_META`, Realtime já ligado), `docs/specs/07-spec-events-workers.md` (contrato `event_log` + workers), `workers/prospecting-site-quality-worker.ts` (precedente do padrão de worker a replicar) — todos no repo `btcrm-prospeccao`. Do lado de fora: `prospeccao-kit-aluno` (`github.com/plasdigital/prospeccao-kit-aluno`, testado nesta conversa) — `MEU-CLIENTE-IDEAL.md` (questionário que gera o critério por nicho), `nichos/*.json` (formato do critério configurável), `docs/o-painel.md` (padrão de UI: lista + ficha por empresa com 6 blocos coloridos por assunto).

---

## Problem Statement

A feature `prospeccao-google-maps` (v1, construída em 18/09/2026) provou o conceito: buscar no Google Maps, pontuar, promover pro funil. Mas ela deixou de propósito fora de escopo exatamente o que decide se um lead é bom pra Black Talk: o score é uma fórmula fixa (`score.ts`), o tipo de serviço está travado em `"venda_de_site"`, e não há Instagram nem CNPJ — só Google Places + visita ao site.

Uma comparação lado a lado com o `prospeccao-kit-aluno` (ferramenta solta, testada nesta conversa) mostrou que ele resolve exatamente essa lacuna — critério configurável por nicho (JSON de pesos/requisitos), enriquecimento de Instagram e CNPJ/sócio — mas é uma ilha sem nenhuma infraestrutura de produto (sem multi-tenant, sem auth, sem testes, sem promoção pro funil). A decisão tomada nesta conversa foi: não adotar o kit como ferramenta separada — portar o que ele tem de melhor **para dentro** do módulo `prospecting` do CRM, que já tem a parte cara de se refazer (RLS, auth, testes, integração com o funil e WhatsApp).

Esta feature é essa portabilidade: nichos configuráveis por organização (substituindo o `service_type` fixo), enriquecimento automático de Instagram e CNPJ (workers novos, mesmo padrão do `site-quality-worker`), e uma UI própria pra criar nicho e ver o resultado — inspirada na disposição de informação do painel do kit, construída com os componentes que o CRM já usa.

## Goals

- [ ] Uma organização cadastra um ou mais **nichos de prospecção** (nome, tipo de serviço livre, termos de busca, requisitos de tamanho, pesos por sinal), cada um isolado por `organization_id`/RLS — mesmo espírito de `nichos/*.json` do kit, agora multi-tenant.
- [ ] Toda busca exige escolher um nicho; o score (inicial e final) usa os pesos e requisitos **daquele nicho**, via uma função genérica que substitui as constantes hardcoded de `score.ts` — os mesmos limites de rótulo (quente/oportunidade/baixa) continuam existindo, só que parametrizados.
- [ ] Resultado que não atende aos requisitos do nicho (fora da faixa de avaliações, sem celular se exigido) é marcado como **reprovado nos requisitos**, separado de "nota baixa" — mesma distinção que o kit já faz.
- [ ] Cada resultado promissor ganha, automaticamente e em segundo plano (sem travar a tela), CNPJ + sócio-administrador (Receita Federal, validado por CEP) e dados de Instagram (seguidores, posts, dias sem postar, engajamento) — dois workers novos, mesmo padrão assíncrono (`event_log` + cron) do `site-quality-worker` já existente.
- [ ] Operador cria/edita um nicho por um **formulário guiado**, não escrevendo JSON nem precisando de uma IA numa conversa — as mesmas perguntas de `MEU-CLIENTE-IDEAL.md` do kit, viram passos de um wizard.
- [ ] Cada resultado tem uma **ficha própria** (`/app/prospeccao/[searchId]/[placeId]`), com um bloco por assunto (Google, Instagram, Site, Receita, Contato, Venda/nota), cada um com cor própria e estado vazio claro quando a etapa ainda não rodou — mesma disposição de informação do painel do kit (`docs/o-painel.md`), construída com `Card`/`Badge`/`STATUS_META` que o CRM já usa, não um design system novo.

## Out of Scope

| Feature | Reason |
| --- | --- |
| RBAC fino / múltiplos operadores concorrentes | Mesma razão do spec original — as organizações ativas hoje continuam de uso individual; gerenciar quota entre operadores é feature própria, quando houver mais de um usuário ativo de verdade. |
| Produto SaaS multi-cliente / onboarding self-service pra outras agências | Aspiração futura confirmada na conversa com o Thiago. Esta feature não fecha essa porta (nicho já nasce por `organization_id`), mas não constrói onboarding de cliente externo, billing ou white-label agora (YAGNI). |
| LinkedIn, TikTok, Facebook como fonte de enriquecimento | O próprio kit trata isso como extra ("peça ao agente", não vem pronto). Fica pra quando um nicho real precisar. |
| Anúncio ativo na Biblioteca de Anúncios da Meta | Camada extra separada no kit (comando `anuncios`), fora do fluxo principal de busca. Fica pra depois, como no kit. |
| Disparo de mensagem a partir da ficha ou da lista | Continua manual via `wa.me` — mesma doutrina anti-banimento/consentimento do spec original. Nenhuma tela nova aqui gera envio automático. |
| Recalcular score de buscas antigas quando o nicho é editado | Snapshot doctrine: uma busca já feita mantém o score de quando rodou (mesmo princípio de `status_label` "armazenado, não calculado a cada leitura" já documentado na migration 0234). Editar o nicho vale só pra buscas futuras. |

---

## User Stories

### P1: Nichos configuráveis por organização (Fundação) ⭐ MVP

**User Story:** As an operador, I want cadastrar um nicho com meus próprios termos de busca, requisitos de tamanho e pesos por sinal, e escolher qual nicho usar numa busca, so that o score reflita o que é um bom lead **pra mim**, não uma fórmula fixa que serve só pra "venda de site" genérica.

**Why P1:** É a fundação de que P2 (enriquecimento) e P3 (UI) dependem — sem um lugar pra guardar critério configurável, não há onde os pesos de Instagram/CNPJ morarem, nem o que um formulário editaria.

**Acceptance Criteria:**

1. WHEN uma organização cria um nicho THEN o sistema SHALL persistir nome, tipo de serviço (texto livre — substitui o literal fixo `"venda_de_site"`), termos de busca, requisitos (faixa de avaliações mín/máx, exige celular, exige site) e pesos por sinal (site, Instagram, WhatsApp, e-mail, telefone, reputação, CNPJ, endereço, LinkedIn) numa tabela nova `prospecting_niches`, isolada por `organization_id`/RLS, no mesmo padrão de `fn_user_org_ids()` já usado em `prospected_searches`.
2. WHEN os pesos de um nicho não somam 100 THEN o sistema SHALL recusar salvar e informar o total atual.
3. WHEN o operador inicia uma busca THEN a tela SHALL exigir escolher um nicho já cadastrado (não mais um campo `service_type` de valor único), e `prospected_searches` SHALL gravar `niche_id`.
4. WHEN o score inicial ou final é calculado THEN o sistema SHALL usar os pesos e requisitos do nicho da busca, via uma função genérica que substitui as constantes hardcoded de `score.ts` — os mesmos três rótulos (quente ≥70 / oportunidade 40-69 / baixa <40) continuam existindo, agora parametrizados pelo nicho.
5. WHEN um resultado não atende a um requisito do nicho (fora da faixa de avaliações, sem celular quando exigido) THEN o sistema SHALL marcar a linha como **reprovada nos requisitos**, rótulo distinto de "baixa pontuação" (mesma distinção que `listar --oportunidade` faz no kit).
6. WHEN a organização ainda não tem nenhum nicho cadastrado THEN a tela de busca SHALL orientar a criar um primeiro, SHALL impedir buscar sem nicho escolhido.

**Independent Test:** Criar dois nichos com pesos diferentes (ex.: um que valoriza site, outro que valoriza Instagram); rodar a mesma busca (mesmo tipo de negócio + praça) em cada um; confirmar que o mesmo resultado físico recebe nota diferente em cada nicho, condizente com os pesos.

---

### P2: Enriquecimento automático — Instagram e CNPJ

**User Story:** As an operador, I want que todo resultado promissor ganhe automaticamente CNPJ, sócio-administrador e dados de Instagram, so that eu saiba quem decide e o quão ativa a empresa está nas redes antes de ligar, sem precisar consultar nada na mão.

**Why P2:** Depende de P1 (o nicho decide o peso desses sinais na nota); roda em paralelo ao P2 original (qualidade do site), como mais dois workers no mesmo padrão.

**Acceptance Criteria:**

1. WHEN a busca (P1 desta feature) termina e um resultado tem nome + cidade suficientes pra identificar a empresa THEN o sistema SHALL gravar um evento `prospected_place.cnpj_requested` em `event_log`, sem bloquear a resposta da busca.
2. WHEN um worker consome esse evento THEN o sistema SHALL consultar a Receita Federal pelo nome da empresa, SHALL aceitar o CNPJ encontrado só se o CEP retornado bater com o endereço do Google Maps (mesma regra de validação cruzada do kit), e SHALL gravar razão social, sócio-administrador, data de abertura e porte quando aceito, ou o motivo quando descartado.
3. WHEN um resultado tem Instagram (achado no site, ou por busca no Google quando o site não linkar) THEN o sistema SHALL gravar um evento `prospected_place.instagram_requested`, um worker SHALL consultar via Apify e gravar seguidores, número de posts, dias desde o último post e engajamento médio (curtidas/comentários).
4. WHEN o nicho da busca tem peso 0 num sinal pago (Instagram) THEN o sistema SHALL pular essa consulta pra aquele resultado — não gasta crédito de API por um dado que não entra na nota de ninguém.
5. WHEN uma consulta falha (timeout, não encontrado, CEP não bate) THEN o sistema SHALL marcar como "não encontrado"/"não consultado" com o motivo, SHALL não afetar as demais linhas nem travar o worker — mesmo padrão de isolamento de falha do `site-quality-worker`.
6. WHEN CNPJ e/ou Instagram ficam prontos THEN o sistema SHALL recalcular o score final da linha considerando os pesos desses sinais no nicho, e a UI SHALL refletir sem recarregar a página (mesmo mecanismo Realtime já usado pro score de qualidade do site).

**Independent Test:** Rodar uma busca com um nicho que dá peso a Instagram e CNPJ; ver as linhas com indicador "consultando..." e, depois, CNPJ/sócio e dados de Instagram preenchidos sozinhos; conferir que uma empresa sem Instagram detectável fica com o campo "não encontrado" em vez de travar a linha.

---

### P3: UI — criar nicho num formulário guiado e ver a ficha por empresa

**User Story:** As an operador, I want criar e editar um nicho respondendo um formulário passo a passo, e abrir cada resultado numa ficha com um bloco colorido por assunto, so that eu decida sozinho o critério de prospecção e entenda o porquê de cada nota, sem escrever JSON nem depender de uma IA numa conversa toda vez que eu quiser buscar outro tipo de cliente.

**Why P3:** Depende de P1 (o nicho existe pra editar) e ganha muito mais valor depois de P2 (mais dado pra mostrar na ficha). É o que fecha o problema original que motivou esta feature.

**Acceptance Criteria:**

1. WHEN o operador acessa "Meus nichos" THEN o sistema SHALL mostrar um formulário guiado, um passo por vez (as mesmas perguntas de `MEU-CLIENTE-IDEAL.md`: o que vende, quem compra, tamanho certo, o que pesa no marketing), com valores padrão sugeridos, e SHALL mostrar o nicho resultante (termos, requisitos, pesos) antes de salvar.
2. WHEN o operador edita um nicho existente THEN o formulário SHALL vir pré-preenchido com os valores atuais, SHALL avisar que a mudança vale só pra buscas futuras (não recalcula histórico).
3. WHEN o operador abre um resultado na tabela de prospecção THEN o sistema SHALL navegar pra uma tela de ficha própria (`/app/prospeccao/[searchId]/[placeId]`), com um bloco por assunto — Google (nota, avaliações, mapa), Instagram (seguidores, posts, dias sem postar), Site (no ar ou não, indicadores de qualidade), Receita (razão social, sócio, porte), Contato (WhatsApp, telefones, e-mail) e Venda (nota final e por quê) — cada bloco com cor própria, reaproveitando `Card`/`Badge`/o padrão `STATUS_META` já usados em `ProspectingResultsTable.tsx`, não um design system novo.
4. WHEN um bloco da ficha ainda não tem dado (etapa não rodou ou não encontrou nada) THEN o sistema SHALL mostrar um estado vazio claro ("ainda não consultado" / "não encontrado"), nunca um erro.
5. WHEN o operador está na tabela de resultados THEN os filtros SHALL incluir nicho, classe (quente/oportunidade/baixa), reprovado nos requisitos, e presença de site — mesmo espírito dos filtros da lista do painel do kit.

**Independent Test:** Criar um nicho do zero só respondendo o formulário (sem tocar em JSON); rodar uma busca com ele; abrir a ficha de um resultado e conferir os 6 blocos, incluindo ao menos um vazio (etapa que ainda não terminou) mostrando estado vazio em vez de erro.

---

## Edge Cases

- WHEN duas organizações têm nichos com o mesmo nome THEN cada nicho SHALL ficar isolado por `organization_id` (RLS) — nomes podem se repetir entre organizações sem conflito.
- WHEN a busca de CNPJ encontra mais de uma empresa com nome parecido THEN o sistema SHALL descartar todas se nenhum CEP bater com o do Maps, SHALL não adivinhar a mais provável.
- WHEN um nicho é apagado mas já tem buscas antigas vinculadas THEN o sistema SHALL impedir o apagamento (ou manter a busca antiga com uma referência "nicho removido") — decisão exata de `on delete` fica pro `design.md`.
- WHEN o operador tenta rodar uma busca e a organização não tem crédito/token de Apify configurado THEN o sistema SHALL avisar antes de tentar (mesmo espírito do erro de Places API sem billing do spec original).
- WHEN dois resultados da mesma busca têm o mesmo Instagram (perfil genérico de franquia, por exemplo) THEN o sistema SHALL gravar os dados igual pros dois, SHALL não deduplicar — cada linha é uma empresa do Maps, mesmo que aponte pro mesmo perfil.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| PROSPECT2-01 | P1: tabela `prospecting_niches` com RLS | Design | Pending |
| PROSPECT2-02 | P1: pesos devem somar 100 | Design | Pending |
| PROSPECT2-03 | P1: busca exige nicho escolhido | Design | Pending |
| PROSPECT2-04 | P1: score genérico parametrizado por nicho | Design | Pending |
| PROSPECT2-05 | P1: reprovado nos requisitos, rótulo distinto | Design | Pending |
| PROSPECT2-06 | P1: sem nicho cadastrado bloqueia busca | Design | Pending |
| PROSPECT2-07 | P2: evento de CNPJ automático | Design | Pending |
| PROSPECT2-08 | P2: worker de CNPJ valida por CEP | Design | Pending |
| PROSPECT2-09 | P2: evento + worker de Instagram | Design | Pending |
| PROSPECT2-10 | P2: pula consulta paga com peso 0 | Design | Pending |
| PROSPECT2-11 | P2: falha isolada por linha | Design | Pending |
| PROSPECT2-12 | P2: score final recalculado, UI sem refresh | Design | Pending |
| PROSPECT2-13 | P3: formulário guiado de nicho | Design | Pending |
| PROSPECT2-14 | P3: edição de nicho não recalcula histórico | Design | Pending |
| PROSPECT2-15 | P3: ficha por empresa, 6 blocos coloridos | Design | Pending |
| PROSPECT2-16 | P3: estado vazio claro por bloco | Design | Pending |
| PROSPECT2-17 | P3: filtros de nicho/classe/requisitos/site | Design | Pending |

**Coverage:** 17 total, 0 mapped to tasks (spec em draft — `design.md` vem depois).

---

## Success Criteria

- [ ] Demo P1: criar dois nichos com pesos diferentes; rodar a mesma busca em cada um; ver notas diferentes pro mesmo resultado, condizentes com os pesos.
- [ ] Demo P2: resultado ganha CNPJ+sócio e dados de Instagram sozinho, com indicador "consultando..." e atualização sem refresh — mesmo padrão do site-quality-worker já em produção.
- [ ] Demo P3: criar um nicho do zero só pelo formulário, sem escrever JSON; abrir a ficha de um resultado e ver os 6 blocos coloridos, incluindo pelo menos um vazio mostrado corretamente.
- [ ] `pnpm typecheck` e `pnpm lint` limpos nos arquivos tocados.
- [ ] RLS testada (`pnpm test:db`) nas tabelas novas (`prospecting_niches` e as colunas novas de `prospected_places`) — isolamento cross-tenant confirmado.
- [ ] Audit log emitido nas mutações relevantes (criar/editar nicho, buscas disparadas), conforme Definition of Done do `CLAUDE.md`.

## Notas CONFIRMED vs INFERRED

- **CONFIRMADO (por código, via exploração do repo `btcrm-prospeccao`):** schema real de `prospected_searches`/`prospected_places` (migration 0234, colunas e constraints lidas integralmente); `score.ts` é fórmula pura com constantes hardcoded (`SCORE_BASE_SEM_SITE`, etc.), sem I/O; `serviceType` é `z.literal("venda_de_site")` em `lib/schemas/prospecting.ts`, coluna do banco propositalmente sem CHECK pra esse campo; `ProspectingResultsTable.tsx` usa `@/components/ui/{badge,card,table}`, o padrão `STATUS_META` (reaproveitado de outros módulos do CRM) e já tem Realtime ligado por linha; **não existe hoje** nenhuma página de detalhe por resultado — só a lista (`app/app/prospeccao/page.tsx` e `[searchId]/page.tsx`, sem rota de terceiro nível); `event_log` + worker cron-drenado é o único caminho doutrinário pra efeito colateral externo pesado, já usado pelo `prospecting-site-quality-worker.ts`.
- **CONFIRMADO (do outro repo, `prospeccao-kit-aluno`, testado nesta conversa):** formato de critério configurável por nicho (`nichos/*.json`: termos, requisitos, pesos somando 100); questionário de `MEU-CLIENTE-IDEAL.md` que gera esse JSON; validação de CNPJ por CEP batendo com o Maps; disposição de UI do painel (`docs/o-painel.md`) — lista com filtros + ficha por empresa com 6 blocos coloridos (Google/Instagram/Site/Receita/Contato/Venda), bloco vazio como estado normal, não erro.
- **INFERIDO (decisão tomada nesta conversa com o Thiago):** padronizar em Apify como único provedor pago (Maps + Instagram), não adicionar Google Places/Serper como segundo provedor; nichos são multi-nicho por organização desde o início (não um perfil único); a UI de nicho é formulário guiado, não editor de JSON cru; nome exato das colunas novas em `prospected_places` (dados de CNPJ/Instagram), nome exato dos eventos, comportamento de `on delete` de um nicho com buscas vinculadas, e a rota exata da ficha (`[searchId]/[placeId]` é proposta, a confirmar) ficam pro `design.md`.
