# Prospecção via Google Maps

**Slug:** `prospeccao-google-maps`
**Status:** Draft (aguardando aprovação)
**Data:** 2026-09-16
**Base escrita (CONFIRMADO):** `CLAUDE.md` (doutrina DIRC, multi-tenant, Definition of Done), `docs/specs/17-spec-conversa-vira-lead.md` + `lib/leads/nascimento-do-lead.ts` (padrão de promoção determinística pro funil), `docs/specs/07-spec-events-workers.md` (contrato `event_log` + workers), `lib/leads/score-formula.ts` (precedente de "score é fórmula, não IA"), `lib/automation/actions/send-whatsapp.ts` (doutrina anti-banimento/consentimento do envio programático), [Google Places API — Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search) (teto de 60 resultados por busca, 20 por página)

---

## Problem Statement

A Black Talk Digital hoje não tem nenhuma forma de gerar leads novos — só reage a indicações da rede pessoal do Thiago. O BlackTalk-CRM sabe lidar muito bem com contato que já existe (conversa, kanban, automação), mas não tem nenhuma tela para *encontrar* negócios que ainda não são contato nenhum. Uma ferramenta de terceiro (NexarHunter) mostrou o formato que resolve isso: buscar por tipo de negócio + localidade no Google Maps, pontuar cada resultado por propensão a fechar (sem site = alvo prioritário para "Venda de site"), e agir (WhatsApp, análise mais funda do site).

Esta feature é a primeira peça do "agente Scraper" descrito no plano estratégico maior da Black Talk (CLAUDE.md pessoal do Thiago), construída **dentro** do CRM em vez de como ferramenta solta, para nascer já conectada ao funil real (`contacts`/`crm_leads`) em vez de virar um segundo sistema de dados desconectado.

## Goals

- [ ] Operador busca até 60 empresas por tipo de negócio + localidade + tipo de serviço (só "Venda de site" na v1), usando a Google Places API oficial, com resultados paginados de 15 em 15 na UI.
- [ ] Cada resultado recebe um score inicial assim que a busca volta (baseado em presença de site + rating + avaliações) e, se tiver site, o score é **atualizado automaticamente** depois que uma análise de qualidade do site termina em segundo plano — sem travar a tela.
- [ ] Quando a análise do site encontra um e-mail de contato na página, ele aparece numa coluna própria (só existe essa fonte de e-mail; a Places API não fornece e-mail).
- [ ] Busca e resultados ficam persistidos (histórico reaberto depois), isolados por `organization_id`/RLS.
- [ ] Operador consegue abrir WhatsApp manualmente (link `wa.me`) para qualquer resultado, sem depender da doutrina de disparo automatizado (que exige consentimento que um prospect frio não tem).
- [ ] Operador consegue "promover" um resultado para o funil real do CRM (`contacts` + `crm_leads`), reaproveitando o padrão já existente de `nascimento-do-lead.ts`; a partir daí, a linha da tabela mostra uma nota com link direto pro card do lead no CRM (não fica só um selo genérico).

## Out of Scope

| Feature | Reason |
| --- | --- |
| Disparo automatizado de WhatsApp em massa | Doutrina de anti-banimento/consentimento (`send-whatsapp.ts`) foi desenhada para contato que já opt-in algo; prospect frio do Maps não tem consentimento registrado. Fica para uma feature de Outreach separada, com decisão de produto própria. |
| Buscar além de 60 resultados para os mesmos termos | Teto rígido da Google Places API (60 por busca, confirmado). Ir além exige refinar a busca (ex.: por bairro) e rodar uma busca nova — não é "carregar mais página", é outra busca. |
| Ação de contato por e-mail (enviar e-mail pela ferramenta) | E-mail nesta v1 é só informativo (exibição); disparo por e-mail é feature à parte se validado depois. |
| Outros tipos de serviço além de "Venda de site" (ex: Agente de Atendimento, Mini-CRM) | v1 valida o caso de uso mais simples primeiro; o campo existe na UI mas com um valor só. |
| RBAC fino / múltiplos operadores concorrentes | v1 assume uso do Thiago sozinho; a busca custa dinheiro de API, mas não há hoje mais de um usuário ativo na organização para gerenciar quota entre eles. |
| Enriquecimento além de Places API + análise de site (ex: Instagram, dados de Receita Federal) | Fora do escopo desta feature. |
| Produto SaaS multi-cliente / white-label | Aspiração futura (mencionada como referência `smartcrmia.com`), não desta feature — o design não deve fechar a porta para isso, mas também não deve construir para isso agora (YAGNI). |

---

## User Stories

### P1: Busca no Google Maps com score inicial ⭐ MVP

**User Story:** As an operador (Thiago), I want to buscar empresas por tipo de negócio + localidade e ver uma tabela pontuada, paginada de 15 em 15 até 60 resultados, so that eu ache alvos de venda sem sair do CRM e sem esperar a análise de site pra ver alguma coisa na tela.

**Why P1:** É o valor central da feature e volta rápido (só a chamada à Places API) — a análise de site (P2) roda depois, em cima desse resultado já visível.

**Acceptance Criteria:**

1. WHEN o operador acessa a tela de prospecção e preenche tipo de negócio, localidade e tipo de serviço (fixo "Venda de site" na v1) e confirma a busca THEN o sistema SHALL chamar a Google Places API (Text Search) paginando até o teto de 60 resultados (3 páginas de 20, respeitando o intervalo exigido pelo `next_page_token`) e SHALL retornar nome, endereço, telefone, presença de site (URL ou ausente), rating e número de avaliações de cada um.
2. WHEN os resultados chegam THEN o sistema SHALL calcular um score inicial 0-100 por fórmula determinística (sem site = base alta; site presente = base intermediária, sujeita a atualização pelo P2; ajuste por rating e volume de avaliações) e SHALL atribuir rótulo Quente (≥70) / Oportunidade (40-69) / Baixa (<40).
3. WHEN a busca é concluída THEN o sistema SHALL persistir a busca e cada resultado em tabela(s) próprias (nome exato a definir no design), com `organization_id` e RLS de isolamento por tenant.
4. WHEN a UI exibe os resultados THEN o sistema SHALL paginar de 15 em 15 (4 páginas para os 60 possíveis), sem nova chamada à Places API entre páginas (dado já veio todo na busca inicial).
5. WHEN a Google Places API retorna erro (quota excedida, key inválida/sem billing, zero resultados) THEN o sistema SHALL exibir mensagem clara e acionável, SHALL não quebrar a tela.
6. WHEN o operador reabre o histórico de uma busca anterior THEN o sistema SHALL mostrar os mesmos resultados persistidos, sem nova chamada à Places API.
7. WHEN uma busca já atingiu os 60 resultados possíveis para aquele termo THEN a UI SHALL deixar claro que o teto foi atingido e SHALL orientar o operador a refinar a busca (ex.: bairro específico) em vez de oferecer "carregar mais" — não existe mais o que carregar pela API.

**Independent Test:** Buscar "clínica" + "São Paulo, SP" + "Venda de site"; ver até 60 resultados persistidos, navegáveis em páginas de 15, com score inicial coerente; fechar e reabrir o histórico e ver os mesmos resultados sem nova chamada de API.

---

### P2: Análise automática de qualidade do site (atualiza score) e extração de e-mail

**User Story:** As an operador, I want que todo resultado com site seja analisado automaticamente em segundo plano e o score/e-mail se atualizem sozinhos, so that eu não precise clicar em nada pra saber se aquele site é realmente ruim, e já veja e-mail de contato quando existir.

**Why P2:** Primeira vez que Playwright roda como parte do produto em produção (hoje só existe em teste/dev) — por isso é uma fase separada com sua própria fila assíncrona, mesmo rodando automaticamente (não é mais "sob demanda", mas continua fora da request síncrona de busca).

**Acceptance Criteria:**

1. WHEN a busca (P1) termina e um resultado tem site THEN o sistema SHALL gravar um evento em `event_log` (`event_type` no padrão `entidade.acao`, ex. `prospected_place.site_quality_requested`) automaticamente, sem clique do operador, e SHALL responder a busca imediatamente sem esperar essa análise (não SHALL rodar Playwright dentro da request HTTP).
2. WHEN um resultado não tem site THEN o sistema SHALL **não** gerar esse evento (não há o que analisar nem de onde extrair e-mail).
3. WHEN um worker consome o evento THEN o sistema SHALL abrir o site com Playwright (timeout de 15s), capturar indicadores (responde? tempo de resposta; viewport mobile presente?), procurar um e-mail de contato na página (`mailto:` ou padrão de texto), e SHALL recalcular o score final da linha considerando esses indicadores (site ruim/lento/não responsivo sobe o score de volta perto da faixa "sem site"; site bom mantém score baixo).
4. WHEN a análise falha (timeout, site fora do ar, erro de navegação) THEN o sistema SHALL marcar a linha como "não foi possível analisar" (mantendo o score inicial do P1), SHALL não afetar as demais linhas nem travar o worker.
5. WHEN o resultado (score final e/ou e-mail) fica pronto THEN a UI SHALL refletir isso na linha certa sem exigir recarregar a página inteira (mecanismo exato — Supabase Realtime vs. polling — é decisão de design).
6. WHEN a mesma linha já tem uma análise em andamento THEN o sistema SHALL evitar gerar um segundo job concorrente para ela (mecanismo exato é decisão de design).

**Independent Test:** Rodar uma busca com pelo menos 5 resultados com site; ver essas linhas com indicador "analisando..." logo após a busca; aguardar e ver score/e-mail (quando existir) atualizarem sozinhos, sem refresh manual da página.

---

### P3: Ações manuais — WhatsApp e exportação

**User Story:** As an operador, I want um botão por linha que abra o WhatsApp com uma mensagem pronta, e um botão de exportar CSV (incluindo e-mail quando houver), so that eu consiga abordar hoje mesmo sem esbarrar na doutrina de disparo automatizado.

**Why P3:** Depende só de P1 (dados já existem); e-mail no CSV também aparece se P2 já tiver rodado.

**Acceptance Criteria:**

1. WHEN o operador clica no botão de WhatsApp de uma linha com telefone válido THEN o sistema SHALL abrir `https://wa.me/<telefone normalizado>?text=<mensagem sugerida>` em nova aba, SHALL **não** usar `ensureConversation`/`sendMessageHandler` (esse caminho carrega doutrina de consentimento que não se aplica aqui).
2. WHEN o telefone do resultado está ausente ou em formato inválido THEN o botão de WhatsApp SHALL aparecer desabilitado, SHALL não gerar link quebrado.
3. WHEN o operador clica "Exportar CSV" THEN o sistema SHALL gerar um CSV com as colunas visíveis da busca atual (nome, endereço, telefone, e-mail, site, rating, score, status).

**Independent Test:** Clicar WhatsApp num resultado com telefone válido e confirmar que abre com número e mensagem corretos; clicar num resultado sem telefone e confirmar botão desabilitado; exportar CSV (com e-mail preenchido em pelo menos uma linha já analisada) e abrir num editor de planilha.

---

### P4: Promover lead para o funil do CRM, com nota e link de volta

**User Story:** As an operador, I want promover um resultado prospectado para o funil real do CRM e, a partir daí, ver na própria tabela de prospecção uma nota com link direto pro card daquele lead, so that eu saiba de cara com quem já interagi e chegue lá num clique, sem procurar no Kanban.

**Why P4:** Fecha o ciclo — sem isso, a prospecção fica isolada do resto do CRM. Depende de P1 (precisa de dados) mas não de P2/P3.

**Acceptance Criteria:**

1. WHEN o operador clica "Promover a lead" numa linha THEN o sistema SHALL criar (ou reaproveitar, se já existir por telefone na organização) um registro em `contacts`, e SHALL criar um `crm_leads` com `source='google_maps_prospecting'` e `source_metadata` guardando os dados brutos (`place_id`, endereço, rating), no pipeline padrão da organização (`crm_pipelines.is_default`), na etapa de menor `position` — mesmo padrão de `lib/leads/nascimento-do-lead.ts`.
2. WHEN a promoção ocorre THEN o sistema SHALL criar um `crm_lead_links` com `target_kind='external'` apontando de volta para a linha de prospecção original, SHALL não duplicar o dado bruto dentro de `crm_leads`.
3. WHEN uma linha já foi promovida THEN a tabela de prospecção SHALL mostrar, numa coluna de observação, um resumo do estado do lead (ex.: etapa atual do funil) com um link que leva direto para o card daquele lead na tela do CRM onde ele é exibido (rota exata a confirmar no design), SHALL impedir promoção duplicada da mesma linha.

**Independent Test:** Promover um resultado; conferir novo card no Kanban do pipeline padrão; voltar pra tela de prospecção e clicar no link da coluna de observação daquela linha, confirmando que abre direto no card do lead promovido.

---

## Edge Cases

- WHEN o telefone de um resultado já existe em `contacts` da mesma organização THEN a promoção (P4) SHALL reaproveitar o contato existente em vez de duplicar.
- WHEN a busca não retorna nenhum resultado para o termo/região THEN a UI SHALL mostrar um estado vazio claro (não um erro).
- WHEN a Google Places API está sem billing habilitado ou a key é inválida THEN o sistema SHALL mostrar mensagem acionável distinta de "erro genérico", já que é um pré-requisito de configuração do próprio operador.
- WHEN duas organizações diferentes (se um dia houver mais de um tenant usando esse módulo) buscam ao mesmo tempo THEN cada busca e seus resultados SHALL ficar isolados por `organization_id` (RLS), sem vazamento cross-tenant.
- WHEN o número de telefone retornado pelo Google Maps está em formato não-normalizável THEN o sistema SHALL tratar como telefone ausente (ver P3, critério 2), não tentar adivinhar.
- WHEN um resultado tem site mas a página não expõe e-mail nenhum THEN a coluna de e-mail SHALL ficar vazia, SHALL não ser tratado como falha de análise.
- WHEN o operador tenta "buscar mais" numa busca que já trouxe os 60 resultados possíveis THEN o sistema SHALL explicar o teto da API em vez de tentar (e falhar) uma quarta página.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| PROSPECT-01 | P1: busca Places API até 60, paginada | Design | Pending |
| PROSPECT-02 | P1: score inicial | Design | Pending |
| PROSPECT-03 | P1: persistência com RLS | Design | Pending |
| PROSPECT-04 | P1: paginação 15/15 sem nova chamada | Design | Pending |
| PROSPECT-05 | P1: erro de API tratado | Design | Pending |
| PROSPECT-06 | P1: histórico reaberto sem nova chamada | Design | Pending |
| PROSPECT-07 | P1: teto de 60 comunicado, sem falsa paginação | Design | Pending |
| PROSPECT-08 | P2: evento automático só quando há site | Design | Pending |
| PROSPECT-09 | P2: sem evento quando não há site | Design | Pending |
| PROSPECT-10 | P2: worker Playwright, score final + e-mail | Design | Pending |
| PROSPECT-11 | P2: falha isolada por linha | Design | Pending |
| PROSPECT-12 | P2: UI reflete sem refresh manual | Design | Pending |
| PROSPECT-13 | P2: sem job duplicado concorrente | Design | Pending |
| PROSPECT-14 | P3: link WhatsApp manual | Design | Pending |
| PROSPECT-15 | P3: telefone inválido desabilita botão | Design | Pending |
| PROSPECT-16 | P3: exportar CSV com e-mail | Design | Pending |
| PROSPECT-17 | P4: promoção contacts + crm_leads | Design | Pending |
| PROSPECT-18 | P4: crm_lead_links de volta | Design | Pending |
| PROSPECT-19 | P4: nota + link direto pro lead, sem duplicar promoção | Design | Pending |

**Coverage:** 19 total, 0 mapped to tasks (spec em draft — tasks.md vem depois do design.md).

---

## Success Criteria

- [ ] Demo P1: busca real retorna até 60 resultados com score inicial coerente, paginados de 15 em 15, persistidos; reabrir o histórico mostra o mesmo resultado sem nova chamada de API.
- [ ] Demo P2: linhas com site mostram "analisando..." e depois atualizam score/e-mail sozinhas, sem refresh manual; falha de um site não afeta as demais linhas.
- [ ] Demo P3: WhatsApp abre com número e mensagem corretos; CSV exportado (com e-mail quando houver) abre corretamente numa planilha.
- [ ] Demo P4: lead promovido aparece no Kanban do pipeline padrão; tabela de prospecção mostra nota com link que leva direto pro card daquele lead.
- [ ] `pnpm typecheck` e `pnpm lint` limpos nos arquivos tocados.
- [ ] RLS testada (`pnpm test:db`) nas tabelas novas — isolamento cross-tenant confirmado.
- [ ] Audit log emitido nas mutações relevantes (busca disparada, promoção), conforme Definition of Done do `CLAUDE.md`.

## Notas CONFIRMED vs INFERRED

- **CONFIRMADO (por código, via exploração do repo):** Supabase sem ORM, `organization_id` + RLS em toda tabela tenant-aware; padrão de promoção determinística "conversa vira lead" existe e é o modelo a replicar (`lib/leads/nascimento-do-lead.ts`); `event_log` + workers cron-drenados é o único caminho doutrinário para efeito colateral externo pesado/assíncrono (`docs/specs/07-spec-events-workers.md`); Playwright hoje só roda em teste/dev (`@playwright/test` em devDependencies), nunca em produção; envio de WhatsApp programático existe (`sendMessageHandler`/`ensureConversation`) mas carrega doutrina de anti-banimento e checagem de consentimento que não cobre prospect frio; `crm_lead_links.target_kind` já tem o valor `'external'` disponível no CHECK constraint, pronto para reaproveitar sem alterar schema.
- **CONFIRMADO (via documentação pública da Google, verificado nesta sessão):** Google Places API Text Search retorna no máximo 20 resultados por página e um teto absoluto de 60 resultados por busca (3 páginas), independente de qual versão da API (legacy ou New) — não existe "página 4" para os mesmos termos.
- **INFERIDO (decisão de produto tomada nesta conversa com o Thiago):** usar a Google Places API oficial em vez de scraping direto (risco de bloqueio/ToS); construir dentro do CRM em vez de app separado, mesmo custando mais tempo que "pronto amanhã"; ação de WhatsApp fica manual (`wa.me`) na v1, deliberadamente **fora** do caminho de automação existente; análise de site passou de "sob demanda" para "automática" a pedido do Thiago, o que torna a fila assíncrona (`event_log`/worker) parte obrigatória do v1, não um extra; e-mail só existe quando extraído do site (Places API não fornece); nome exato das tabelas novas, RBAC de quem pode buscar/promover, mecanismo de UI para refletir resultado assíncrono (Realtime vs. polling), critério exato de "site ruim" que reajusta o score, e a rota/tela exata de destino do link da coluna de observação (P4) ainda **não** foram decididos — ficam para o `design.md`.
