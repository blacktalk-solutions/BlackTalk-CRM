import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O SEAM HIGIENIZA — não basta a função saber.
 *
 * ═══ Por que este arquivo existe, separado do irmão ═════════════════════════
 *
 * `uuid-de-modelo-nao-vira-filtro.test.ts` prova uma propriedade de
 * `higienizarUuidsDeAterro`: dado o schema e o payload, ela apaga a chave certa.
 * Isso é verdade e é insuficiente — porque uma função correta que ninguém chama
 * não protege nada.
 *
 * Medido, não suposto: sabotei o ingresso (`lib/ai/runtime/tools.ts`, trocando
 * `higiene.limpos` de volta pelos args crus) e os SETE casos do arquivo irmão
 * ficaram verdes. É o modo de falha que o repo já catalogou — guarda que mede a
 * função e não o call site.
 *
 * Aqui a asserção é sobre a CADEIA INTEIRA: monta a ferramenta como o turno do
 * agente a monta (`pickToolsFromMcp`), executa com a sentinela que o modelo
 * mandou em produção, e lê o que chegou lá no fim — na resolução do acervo, que
 * é quem recebe o id. Se qualquer elo do caminho parar de higienizar, este caso
 * cai.
 *
 * ═══ Por que `crm_search_knowledge` / `assistente_id`, e não mais
 * `crm_find_free_slots` / `owner_user_id` ══════════════════════════════════
 *
 * Este arquivo media `owner_user_id` até a decisão (2026-09-13, ver o
 * cabeçalho de `lib/mcp/tools/agendamento.ts`) de tirar o campo da SUPERFÍCIE
 * da IA: um modelo mais barato repetia o uuid de aterro em loop mesmo depois
 * do descarte, e a correção foi não expor o campo, não higienizá-lo melhor.
 * `crm_find_free_slots` não aceita mais `owner_user_id` — o handler passa
 * `ownerUserId: null` incondicionalmente — então este arquivo não consegue
 * mais provar hygiene NENHUMA através dele: as duas entradas (aterro e uuid
 * legítimo) chegariam a `null` do mesmo jeito, e o caso de controle abaixo
 * (dono legítimo atravessa intacto) reprovaria sempre, não pela higiene comer
 * dado bom, mas pelo campo nem existir mais no schema.
 *
 * `crm_search_knowledge` ainda tem um campo assim — `assistente_id`, opcional,
 * usado só por quem chama a ferramenta sem SER o próprio agente (cliente MCP
 * externo). Continua valendo o mesmo risco que este arquivo prova: um modelo
 * pode mandar aterro nesse campo, e um id legítimo tem que atravessar intacto.
 *
 * ═══ O caso real que ele reproduz (histórico, na forma original) ═══════════
 *
 *     crm_find_free_slots { event_type_slug: "hof-e-botox",
 *                           owner_user_id: "00000000-0000-0000-0000-000000000000" }
 *
 * Com o zerado passando, `params.ownerUserId ?? tipo.default_owner_user_id`
 * escolhia o zerado, a jornada de um usuário que não existe voltava vazia, e o
 * agente concluía que a agenda não foi publicada. A paciente ficou sem
 * consulta. A correção de raiz (tirar o campo) fechou ESTE caso; a hygiene
 * genérica que este arquivo prova continua necessária para os outros ~27
 * campos de uuid opcional do catálogo (`lib/mcp/uuid-de-aterro.ts`).
 */

const NIL = "00000000-0000-0000-0000-000000000000";
const BOM = "fb8061a5-27c0-4b13-9728-833b8f06828a";
const ACTOR_ID = "ag-1";

// A resolução do acervo é o FIM da cadeia: é ela quem recebe o `assistente_id`
// e decide de onde vem o material. Espiá-la aqui é o que torna a asserção
// sobre o caminho, e não sobre a função de higiene.
vi.mock("@/lib/ai/knowledge/busca", async (original) => {
  const real = await original<typeof import("@/lib/ai/knowledge/busca")>();
  return { ...real, resolverAcervoDoAgente: vi.fn() };
});
// O audit escreve no Supabase e não é o objeto desta medição.
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { resolverAcervoDoAgente } = await import("@/lib/ai/knowledge/busca");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

function montarTurno() {
  return pickToolsFromMcp({
    toolIds: ["crm_search_knowledge"],
    auth: {
      organizationId: "org-1",
      role: "ai_operator",
      scopes: ["mcp:read", "mcp:write"],
      actor: { type: "ai_agent", id: ACTOR_ID, role: "ai_operator" },
      apiTokenId: "tok-1",
    },
    ctx: {
      organizationId: "org-1",
      role: "ai_operator",
      actor: { type: "ai_agent", id: ACTOR_ID, role: "ai_operator" },
      apiTokenId: "tok-1",
      requestId: "req-1",
    },
    supabase: {} as never,
    pipelineIds: null,
    handoffToolEnabled: false,
  } as never);
}

async function executarComAssistente(
  assistenteId: string,
): Promise<string | undefined> {
  vi.mocked(resolverAcervoDoAgente).mockResolvedValue([]);

  const tools = montarTurno();
  const alvo = tools["crm_search_knowledge"] as unknown as {
    execute: (a: unknown) => Promise<unknown>;
  };
  expect(alvo, "pickToolsFromMcp não montou crm_search_knowledge").toBeTruthy();

  await alvo.execute({ pergunta: "qual o horário de funcionamento?", assistente_id: assistenteId });

  // O 3º argumento da resolução é o id do assistente — é lá que ele chega.
  return vi.mocked(resolverAcervoDoAgente).mock.calls[0]?.[2];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o seam do agente higieniza o uuid inventado pelo modelo", () => {
  it("o uuid de aterro NÃO chega à resolução do acervo — o próprio agente volta a valer", async () => {
    const assistenteId = await executarComAssistente(NIL);

    // `undefined` é o que o handler passa quando a chave não veio, e é o que
    // faz `input.assistente_id ?? ctx.actor.id` escolher o próprio agente.
    expect(assistenteId).toBe(ACTOR_ID);
    expect(assistenteId).not.toBe(NIL);
  });

  it("um assistente LEGÍTIMO atravessa intacto — a higiene não come dado bom", async () => {
    // O controle. Sem ele, uma higiene que apagasse `assistente_id` sempre
    // satisfaria o caso acima e quebraria a chamada de um cliente MCP externo
    // que escolheu o assistente de propósito.
    const assistenteId = await executarComAssistente(BOM);

    expect(assistenteId).toBe(BOM);
  });
});
