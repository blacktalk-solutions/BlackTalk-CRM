import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * T10 — prova comportamental de isolamento RLS para as duas tabelas novas da
 * prospecção via Google Maps (migration 0234,
 * `supabase/migrations/20260916120000_0234_prospeccao_google_maps.sql`):
 * `prospected_searches` e `prospected_places`.
 *
 * A migration 0234 (T1) já criou o schema, ligou `row level security` e criou
 * as policies `tenant_isolation_<tabela>_all` — mas deixou, de propósito, a
 * prova de COMPORTAMENTO (JWT simulado + contagem cross-org contra Postgres
 * real) para esta task. Ver o comentário no topo daquela migration e o
 * cabeçalho de `rls-completude-varredura.test.ts`: até este arquivo nascer, a
 * varredura lista as duas tabelas como "tenant-aware nova sem prova
 * comportamental nenhuma".
 *
 * ─── Padrão seguido (pesquisa obrigatória do brief)
 *
 * Modelado em `tests/invariants/meta-templates-rls.test.ts`: fixture própria
 * (2 orgs + 1 membro cada, namespace pelo número da migration), helpers
 * `countAs`/`writeCountAs`/`sql` de `./gov-helpers` (mesmo `set role
 * authenticated` + `set_config('request.jwt.claims', ...)` que
 * `fn_user_org_ids()` usa em produção). Arquivo PRÓPRIO em vez de entrar na
 * lista `TABLES` de `rls-isolation.test.ts` porque aquele arquivo está
 * congelado (README.md desta pasta: "Invariantes existentes são congelados:
 * adicione, não edite/delete") — exatamente o mesmo motivo que já levou
 * `meta_templates`/`webhook_sources`/`automation_rules` etc. para arquivos
 * próprios, citados em `PROVA_PROPRIA` de `rls-completude-varredura.test.ts`
 * em vez de entrar em `TABLES`.
 *
 * ─── O que está sob prova
 *
 *  1. Isolamento de LEITURA nas duas tabelas: membro da org B lê 0 linhas da
 *     org A, tanto pela linha semeada quanto por `organization_id` inteiro.
 *  2. O lado `with check`: membro da org B NÃO escreve uma linha com
 *     `organization_id` da org A em nenhuma das duas tabelas — o lado que uma
 *     policy só com `using` (sem `with check`) deixaria passar, e que nenhuma
 *     tela exercitaria sozinha. A migration 0234 já usa `for all ... using
 *     (...) with check (...)`; esta é a prova de que o `with check` está
 *     realmente ativo, não só escrito.
 *  3. Controle positivo: a própria org lê e escreve normalmente — sem isto,
 *     "0 rows cross-tenant" podia estar medindo uma tabela inacessível a
 *     qualquer um (ex.: RLS ligada sem NENHUMA policy), não isolamento por
 *     tenant.
 *
 * ─── Idempotência (bônus opcional do brief — NÃO é o requisito principal)
 *
 * A Task 8 já cobre a idempotência a nível de APLICAÇÃO em teste unitário com
 * mock (`tests/unit/prospecting-site-quality-worker.test.ts`, casos 5/6/8) —
 * não é repetida aqui. O que o describe de baixo acrescenta, contra Postgres
 * de verdade, é o CLAIM OTIMISTA em si: o exato filtro de 3 colunas que
 * `analyzeProspectSiteQuality` usa no UPDATE
 * (`workers/prospecting-site-quality-worker.ts`, ~linha 212-218:
 * `.eq("id", ...).eq("organization_id", ...).eq("site_analysis_status",
 * place.site_analysis_status)`) é, de fato, uma corrida ganha por só um dos
 * dois lados quando repetido contra a mesma linha. Isto NÃO chama o worker
 * TypeScript real (o harness desta pasta fala com o banco via `docker exec
 * psql`, não via client Supabase — não há como instanciar
 * `createAdminClient()` aqui) — é a mesma limitação que already existe para
 * qualquer teste de invariantes deste repo. O que prova é o mecanismo SQL de
 * que a idempotência de aplicação depende, não o handler inteiro.
 */

// Namespace pela MIGRATION (0234), mesma convenção de
// meta-templates-rls.test.ts (0088aaaa/0088bbbb): cada arquivo de invariante
// roda num banco PRÓPRIO (vitest.db.config.ts, "Banco NOVO por arquivo" —
// setupFiles: tests/db/banco-limpo-por-arquivo.ts), então colisão de UUID
// entre arquivos não é risco real aqui; o namespace só evita colisão manual
// se alguém copiar este bloco para outro arquivo.
const PROSPECT_ORG_A = "02340000-0000-4000-8000-000000000001";
const PROSPECT_ORG_B = "02340000-0000-4000-8000-000000000002";
const PROSPECT_MEMBER_A = "02341111-0000-4000-8000-000000000001";
const PROSPECT_MEMBER_B = "02341111-0000-4000-8000-000000000002";
const PROSPECT_SEARCH_A = "02342222-0000-4000-8000-000000000001";
const PROSPECT_SEARCH_A_INVADIDA = "02342222-0000-4000-8000-000000000002";
const PROSPECT_PLACE_A = "02343333-0000-4000-8000-000000000001";
const PROSPECT_PLACE_A_INVADIDA = "02343333-0000-4000-8000-000000000002";
const PROSPECT_PLACE_CAS = "02343333-0000-4000-8000-000000000003";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${PROSPECT_MEMBER_A}', 'prospect-member-a@invariant.test'),
      ('${PROSPECT_MEMBER_B}', 'prospect-member-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${PROSPECT_ORG_A}', 'prospect-inv-a', 'Prospecting Invariant A', 'Prospect Inv A'),
      ('${PROSPECT_ORG_B}', 'prospect-inv-b', 'Prospecting Invariant B', 'Prospect Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${PROSPECT_MEMBER_A}', '${PROSPECT_ORG_A}', 'manager', now()),
      ('${PROSPECT_MEMBER_B}', '${PROSPECT_ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
}

// Colunas mínimas NOT NULL sem default (migration 0234): organization_id,
// business_type, location, requested_by.
const SEARCH_COLS = "(id, organization_id, business_type, location, requested_by)";
function searchValues(id: string, org: string, requestedBy: string): string {
  return `('${id}', '${org}', 'restaurante', 'São Paulo, SP', '${requestedBy}')`;
}

// Colunas mínimas NOT NULL sem default: search_id, organization_id, place_id,
// name, score_initial, status_label (CHECK 'quente'|'oportunidade'|'baixa').
const PLACE_COLS = "(id, search_id, organization_id, place_id, name, score_initial, status_label)";
function placeValues(id: string, searchId: string, org: string, placeId: string): string {
  return `('${id}', '${searchId}', '${org}', '${placeId}', 'Restaurante Invariante', 70, 'oportunidade')`;
}

describe("0234 · prospecção via Google Maps — RLS de prospected_searches/prospected_places", () => {
  it("as duas tabelas nascem com RLS ligada e a policy de tenant", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'prospected_searches'`)).toBe("t");
    expect(sql(`select relrowsecurity from pg_class where relname = 'prospected_places'`)).toBe("t");
    expect(
      sql(`select policyname from pg_policies
            where schemaname = 'public' and tablename = 'prospected_searches' and permissive = 'PERMISSIVE' order by 1`),
    ).toBe("tenant_isolation_prospected_searches_all");
    expect(
      sql(`select policyname from pg_policies
            where schemaname = 'public' and tablename = 'prospected_places' and permissive = 'PERMISSIVE' order by 1`),
    ).toBe("tenant_isolation_prospected_places_all");
  });

  it("membro da org A cria uma busca e um resultado, e lê os dois de volta (controle positivo)", () => {
    expect(
      writeCountAs(
        PROSPECT_MEMBER_A,
        `insert into public.prospected_searches ${SEARCH_COLS} values ${searchValues(PROSPECT_SEARCH_A, PROSPECT_ORG_A, PROSPECT_MEMBER_A)}`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        PROSPECT_MEMBER_A,
        `insert into public.prospected_places ${PLACE_COLS} values ${placeValues(PROSPECT_PLACE_A, PROSPECT_SEARCH_A, PROSPECT_ORG_A, "places-inv-a-1")}`,
      ),
    ).toBe(1);

    expect(
      countAs(PROSPECT_MEMBER_A, `select count(*) from public.prospected_searches where id = '${PROSPECT_SEARCH_A}';`),
    ).toBe(1);
    expect(
      countAs(PROSPECT_MEMBER_A, `select count(*) from public.prospected_places where id = '${PROSPECT_PLACE_A}';`),
    ).toBe(1);
  });

  it("membro da org B NÃO lê a busca nem o resultado da org A", () => {
    expect(
      countAs(PROSPECT_MEMBER_B, `select count(*) from public.prospected_searches where id = '${PROSPECT_SEARCH_A}';`),
    ).toBe(0);
    expect(
      countAs(PROSPECT_MEMBER_B, `select count(*) from public.prospected_places where id = '${PROSPECT_PLACE_A}';`),
    ).toBe(0);
    // Mesma prova por organization_id inteiro, não só pela linha semeada —
    // fecha o caso de alguém "adivinhar" um id e ainda assim não ler nada.
    expect(
      countAs(
        PROSPECT_MEMBER_B,
        `select count(*) from public.prospected_searches where organization_id = '${PROSPECT_ORG_A}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        PROSPECT_MEMBER_B,
        `select count(*) from public.prospected_places where organization_id = '${PROSPECT_ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("membro da org B NÃO escreve busca COM o organization_id da org A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        PROSPECT_MEMBER_B,
        `insert into public.prospected_searches ${SEARCH_COLS} values ${searchValues(PROSPECT_SEARCH_A_INVADIDA, PROSPECT_ORG_A, PROSPECT_MEMBER_B)}`,
      ),
    ).toBe(0);
    // E a linha não existe nem para quem bypassa RLS — 0 aqui separa "foi
    // barrado" de "foi gravado e o SELECT authenticated é que não enxerga".
    expect(sql(`select count(*) from public.prospected_searches where id = '${PROSPECT_SEARCH_A_INVADIDA}'`)).toBe("0");
  });

  it("membro da org B NÃO escreve resultado COM o organization_id da org A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        PROSPECT_MEMBER_B,
        `insert into public.prospected_places ${PLACE_COLS} values ${placeValues(PROSPECT_PLACE_A_INVADIDA, PROSPECT_SEARCH_A, PROSPECT_ORG_A, "places-inv-a-invadido")}`,
      ),
    ).toBe(0);
    expect(sql(`select count(*) from public.prospected_places where id = '${PROSPECT_PLACE_A_INVADIDA}'`)).toBe("0");
  });
});

/**
 * Bônus (ver cabeçalho do arquivo): prova o CLAIM OTIMISTA em si — o mesmo
 * filtro de 3 colunas (`id` + `organization_id` + `site_analysis_status`
 * atual) que `analyzeProspectSiteQuality` usa antes de abrir o Playwright —
 * contra Postgres real, não mock. Roda como superuser (`sql()`, não
 * `countAs`/`writeCountAs`) de propósito: o worker usa `createAdminClient()`
 * (service_role, que bypassa RLS), não o client `authenticated` do usuário —
 * o mesmo comentário já existe em `webhooks-rls.test.ts` para o seed de
 * `automation_rule_runs`.
 */
describe("0234 · claim otimista de prospected_places.site_analysis_status (bônus)", () => {
  function claimPending(placeId: string, org: string): number {
    return Number(
      sql(`
        with c as (
          update public.prospected_places
             set site_analysis_status = 'processing'
           where id = '${placeId}' and organization_id = '${org}' and site_analysis_status = 'pending'
          returning id
        )
        select count(*) from c;
      `),
    );
  }

  it("duas 'análises pedidas' seguidas pra mesma linha: só a primeira reivindica — a segunda é no-op", () => {
    sql(`
      insert into public.prospected_places
        (id, search_id, organization_id, place_id, name, score_initial, status_label, site_analysis_status, website_url)
      values
        ('${PROSPECT_PLACE_CAS}', '${PROSPECT_SEARCH_A}', '${PROSPECT_ORG_A}', 'places-inv-a-cas',
         'Restaurante Invariante CAS', 60, 'baixa', 'pending', 'https://exemplo-invariante-cas.test')
      on conflict do nothing;
    `);

    // 1ª "requisição de análise": reivindica a linha (pending → processing).
    expect(claimPending(PROSPECT_PLACE_CAS, PROSPECT_ORG_A)).toBe(1);
    // 2ª requisição pra MESMA linha, mesmo estado que ela leria antes de
    // tentar o claim ('pending' — o que a 1ª também leu): não casa mais
    // nenhuma linha, porque a 1ª já moveu o status para 'processing'. É
    // exatamente o "concurrent claim lost" do worker — sem erro visível,
    // apenas 0 linhas afetadas.
    expect(claimPending(PROSPECT_PLACE_CAS, PROSPECT_ORG_A)).toBe(0);
    expect(
      sql(`select site_analysis_status from public.prospected_places where id = '${PROSPECT_PLACE_CAS}'`),
    ).toBe("processing");
  });
});
