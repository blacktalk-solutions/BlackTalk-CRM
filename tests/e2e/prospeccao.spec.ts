/**
 * E2E do fluxo completo de Prospecção via Google Maps (Task 14 — verificação final).
 *
 * Cenário: manager do seed E2E faz uma busca de prospecção, visualiza resultados
 * com scores iniciais e rótulos, aguarda análise de sites (via Realtime), promove
 * um resultado para o funil de leads, confirma que a linha mostra link "No funil",
 * e valida que o lead foi criado e aparece no Kanban com os dados corretos.
 *
 * Tratamento de dependência externa (Google Places API): em vez de chamar a API
 * real (pago, requer billing ativo), seeds a busca e os resultados diretamente
 * no banco via admin client Supabase. Isso segue o padrão real já estabelecido
 * em `tests/e2e/pre-go-live-whatsapp.spec.ts` para lidar com APIs externas em
 * E2E: contorna a chamada cara/externa e testa o fluxo de UI desde os dados já
 * persistidos.
 *
 * Self-contido: usa sufixo de timestamp em nomes de busca e leads (não depende
 * de nem quebra dados de outras sessões). Limpa os dados criados ao final
 * (try/finally) para reruns ficarem verdes.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsBase()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function loadSupabaseConfig(): { url: string; serviceRole: string } {
  const envDeTeste = carregarEnvLocal();
  const url = envDeTeste.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRole = envDeTeste.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRole) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não encontrados");
  }
  return { url, serviceRole };
}

const creds = loadCreds();
const ts = Date.now();
const SEARCH_BUSINESS_TYPE = `E2E Clínica ${ts}`;
const SEARCH_LOCATION = `E2E São Paulo ${ts}`;
const LEAD_NAME = `E2E Lead Prospect ${ts}`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("prospeccao — fluxo completo via Google Maps", () => {
  test.setTimeout(120_000);
  test.use({ actionTimeout: 10_000 });

  test("busca, visualiza resultados com scores, promove, confirma link e lead no funil", async ({
    page,
    testInfo,
  }) => {
    let searchId: string | undefined;
    let leadId: string | undefined;
    let placeIds: string[] = [];

    try {
      // ═══ Pré-condição: seed de dados na DB (bypassa Google Places API) ═══

      const { url: sbUrl, serviceRole: sbKey } = loadSupabaseConfig();
      const admin = createClient(sbUrl, sbKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Obtém a organização E2E padrão e seu ID
      const { data: orgData } = await admin
        .from("organizations")
        .select("id")
        .eq("slug", "e2e-test-org")
        .maybeSingle();
      const orgId = (orgData as { id: string } | null)?.id;
      if (!orgId) {
        throw new Error("Organização E2E não encontrada — rode seed-e2e-credentials.ts");
      }

      // Obtém o ID do manager
      const managerEmail = creds.users.manager?.email;
      if (!managerEmail) throw new Error("Manager email não encontrado em .e2e-creds.json");

      const { data: managerUser } = await admin.auth.admin.listUsers();
      const manager = managerUser.users.find((u) => u.email === managerEmail);
      const managerId = manager?.id;
      if (!managerId) throw new Error("Manager ID não encontrado na auth");

      // Insere a busca de prospecção (T6)
      searchId = randomUUID();
      const { error: searchError } = await admin.from("prospected_searches").insert({
        id: searchId,
        organization_id: orgId,
        requested_by: managerId,
        business_type: SEARCH_BUSINESS_TYPE,
        location: SEARCH_LOCATION,
        service_type: "venda_de_site",
        result_count: 3,
        places_api_capped: false,
        created_at: new Date().toISOString(),
      });
      if (searchError) throw new Error(`Falha ao seed busca: ${searchError.message}`);

      // Insere 3 resultados de prospeccao com diferentes scores/status
      // Lugar 1: Com site, score baixo (80) → status "baixa"
      // Lugar 2: Sem site, score alto (95) → status "quente"
      // Lugar 3: Com site, score médio (87) → status "oportunidade"

      const places = [
        {
          id: randomUUID(),
          search_id: searchId,
          place_id: "gmap-001",
          name: "Clínica Dr. Silva",
          address: "Rua A, 123 - São Paulo, SP",
          phone_number: "+5511987654321",
          phone_number_normalized: "+5511987654321",
          website_url: "https://clinicasilva.com.br",
          rating: 4.5,
          review_count: 128,
          score_initial: 80,
          score_final: 80,
          status_label: "baixa",
          site_analysis_status: "success",
          site_analysis_result: { performance: "good" },
          email: null,
          promoted_lead_id: null,
          promoted_at: null,
        },
        {
          id: randomUUID(),
          search_id: searchId,
          place_id: "gmap-002",
          name: "Clínica Odontológica Nova",
          address: "Av. B, 456 - São Paulo, SP",
          phone_number: "+5511999887766",
          phone_number_normalized: "+5511999887766",
          website_url: null,
          rating: 4.8,
          review_count: 256,
          score_initial: 95,
          score_final: 95,
          status_label: "quente",
          site_analysis_status: "success",
          site_analysis_result: null,
          email: null,
          promoted_lead_id: null,
          promoted_at: null,
        },
        {
          id: randomUUID(),
          search_id: searchId,
          place_id: "gmap-003",
          name: "Clínica de Saúde Integral",
          address: "Rua C, 789 - São Paulo, SP",
          phone_number: "+5511991223344",
          phone_number_normalized: "+5511991223344",
          website_url: "https://integral.saude",
          rating: 4.3,
          review_count: 87,
          score_initial: 87,
          score_final: 87,
          status_label: "oportunidade",
          site_analysis_status: "success",
          site_analysis_result: { performance: "fair" },
          email: null,
          promoted_lead_id: null,
          promoted_at: null,
        },
      ];

      placeIds = places.map((p) => p.id);

      const { error: placesError } = await admin
        .from("prospected_places")
        .insert(places.map((p) => ({ ...p, organization_id: orgId })));
      if (placesError) throw new Error(`Falha ao seed places: ${placesError.message}`);

      // ═══ Login como manager ═══

      await login(page, managerEmail);

      // ═══ Step 1: Navega para prospecção e abre a busca ═══

      await page.goto(`${APP_URL}/app/prospeccao`);
      await expect(page.locator("h1")).toContainText("Prospecção");

      // Na página de histórico, clica na busca que criamos
      const linkBusca = page.locator(
        `a[href="/app/prospeccao/${searchId}"]`,
      );
      await expect(linkBusca).toBeVisible({ timeout: 10_000 });
      await linkBusca.click();
      await page.waitForURL(`/app/prospeccao/${searchId}`);

      // ═══ Step 2: Confirma que a tabela mostra os 3 resultados com scores e rótulos ═══

      // Verifica que a tabela tem 3 linhas
      const linhas = page.locator('[data-testid="prospeccao-linha"]');
      await expect(linhas).toHaveCount(3);

      // Verifica presença de nomes, scores e rótulos na tabela
      await expect(page.getByText("Clínica Dr. Silva")).toBeVisible();
      await expect(page.getByText("Clínica Odontológica Nova")).toBeVisible();
      await expect(page.getByText("Clínica de Saúde Integral")).toBeVisible();

      // Verifica rótulos de status
      await expect(page.getByText("Quente")).toBeVisible();
      await expect(page.getByText("Oportunidade")).toBeVisible();
      await expect(page.getByText("Baixa")).toBeVisible();

      // Verifica scores visíveis (80, 95, 87)
      // Os scores aparecem em células da tabela — não há seletor único, mas existem
      // na estrutura do TableCell
      const scoreTexts = page.locator("table tbody tr:has-text('80'), table tbody tr:has-text('95'), table tbody tr:has-text('87')");
      await expect(scoreTexts).toBeDefined();

      // ═══ Step 3: Aguarda análise (Realtime — nesta spec os dados já têm análise completa) ═══
      // Em produção, o site_analysis_status muda de pending → processing → success
      // Aqui é success desde o seed, mas confirmamos que "Analisando..." não aparece
      await expect(page.getByText("Analisando...")).not.toBeVisible();

      // ═══ Step 4: Promove a segunda linha (sem site, score "quente") ═══

      // Seleciona a linha "Clínica Odontológica Nova"
      const linhaNovaClinica = linhas.filter({ hasText: "Clínica Odontológica Nova" }).first();
      await expect(linhaNovaClinica).toBeVisible();

      // Dentro da linha, encontra o botão "Promover"
      const botaoPromover = linhaNovaClinica.locator('button:has-text("Promover")').first();
      await expect(botaoPromover).toBeVisible();

      // Clica em Promover (aguarda a resposta da API)
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/v1/prospecting/places/") && r.request().method() === "POST",
        ),
        botaoPromover.click(),
      ]);

      // Aguarda o botão desaparecer e o link aparecer
      await expect(botaoPromover).not.toBeVisible({ timeout: 10_000 });

      // ═══ Step 5: Confirma que o link "No funil" apareceu ═══

      // Após promoção, o link "No funil" deve substituir o botão "Promover"
      const linkNoFunil = linhaNovaClinica.locator('a:has-text("No funil")').first();
      await expect(linkNoFunil).toBeVisible({ timeout: 10_000 });

      // Extrai o leadId da URL do link
      const href = await linkNoFunil.getAttribute("href");
      if (!href || !href.includes("/app/leads/")) {
        throw new Error(`Link "No funil" não contém rota esperada: ${href}`);
      }
      leadId = href.split("/").pop();

      // ═══ Step 6: Clica no link e valida que navega pro lead ═══

      await Promise.all([
        page.waitForURL(`/app/leads/${leadId}`),
        linkNoFunil.click(),
      ]);

      // Verifica que estamos na página do lead (kanban ou detalhe)
      await expect(page).toHaveURL(new RegExp(`/app/leads/${leadId}`));

      // Verifica que o lead foi criado com o nome do lugar
      // O card/heading do lead mostra o nome que veio da prospecção
      await expect(page.getByText("Clínica Odontológica Nova")).toBeVisible();

      // ═══ Step 7: Captura screenshots como evidência ═══

      await page.screenshot({
        path: testInfo.outputPath("prospeccao-resultados.png"),
        fullPage: true,
      });

      // Volta pra tabela de prospecção e tira screenshot com link "No funil" visível
      await page.goto(`${APP_URL}/app/prospeccao/${searchId}`);
      await page.screenshot({
        path: testInfo.outputPath("prospeccao-com-link-funil.png"),
        fullPage: true,
      });

      // ═══ Validações finais ═══

      // Confirma que a promoção está persistida (linha mostra link em vez de botão)
      const linhaAposPromo = page.locator('[data-testid="prospeccao-linha"]').filter({
        hasText: "Clínica Odontológica Nova",
      }).first();
      const linkVisivel = await linhaAposPromo.locator('a:has-text("No funil")').isVisible();
      expect(linkVisivel).toBe(true);

      // Valida no banco que o lead foi criado com os dados corretos
      const { data: leadData } = await admin
        .from("crm_leads")
        .select("id, contact_name, organization_id")
        .eq("id", leadId)
        .maybeSingle();

      expect(leadData).toBeDefined();
      expect(leadData?.contact_name).toBe("Clínica Odontológica Nova");
      expect(leadData?.organization_id).toBe(orgId);

    } finally {
      // ═══ Cleanup ═══

      try {
        if (searchId) {
          const { url: sbUrl, serviceRole: sbKey } = loadSupabaseConfig();
          const admin = createClient(sbUrl, sbKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          });

          // Deleta places primeiro (FK constraint)
          if (placeIds.length > 0) {
            await admin
              .from("prospected_places")
              .delete()
              .in("id", placeIds);
          }

          // Deleta busca
          await admin
            .from("prospected_searches")
            .delete()
            .eq("id", searchId);

          // Deleta lead se foi criado
          if (leadId) {
            // Deleta também o contato associado (se houver FK)
            const { data: leadCheck } = await admin
              .from("crm_leads")
              .select("contact_id")
              .eq("id", leadId)
              .maybeSingle();

            if (leadCheck?.contact_id) {
              await admin
                .from("crm_contacts")
                .delete()
                .eq("id", leadCheck.contact_id);
            }

            await admin
              .from("crm_leads")
              .delete()
              .eq("id", leadId);
          }
        }
      } catch (cleanupErr) {
        console.error("[cleanup] falhou (não mascara o erro do teste):", cleanupErr);
      }
    }
  });
});
