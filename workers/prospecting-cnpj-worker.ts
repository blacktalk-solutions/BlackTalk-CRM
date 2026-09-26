/**
 * Consome `prospected_place.cnpj_requested` (T9,
 * `.specs/features/prospeccao-nichos-e-enriquecimento/`): acha o CNPJ de um
 * `prospected_places` e grava razão social, sócio-administrador, abertura e
 * porte quando aceito.
 *
 * Estrutura EXATA de `workers/prospecting-site-quality-worker.ts` (T9
 * "Reuses"): mesmo guard de idempotência por claim otimista
 * (`cnpj_status` como coluna de estado), mesmo padrão de try/catch que nunca
 * deixa uma exceção escapar sem gravar `'failed'`, mesmo motivo pra devolver
 * `status: "ok"` mesmo depois de gravar `'failed'` (evitar retry automático
 * do drain batendo num CNPJ que não existe repetidamente — reprocessamento
 * intencional fica pra quando esta feature ganhar uma ação manual, como o
 * "tentar de novo" que T11 já tem pra site).
 *
 * ─── Cascata: SÓ pesquisa (desvio consciente de design.md, registrado em T4)
 *
 * `design.md`/`tasks.md` descreviam duas etapas: "tenta `receita-client` pelo
 * NOME direto; se não achar, cai pra `pesquisa-client`". Isso pressupunha uma
 * API de Receita que busca por nome de empresa — NENHUMA das duas usadas
 * (BrasilAPI, cnpj.ws) faz isso; as duas só consultam por NÚMERO de CNPJ já
 * conhecido (achado confirmado em T4, `lib/prospecting/receita-client.ts`,
 * documentado no topo daquele arquivo). Por isso este worker tem UMA etapa
 * só: pesquisa no Google por candidatos (regex nos resultados, mesmo padrão
 * do `acharCnpj` do `prospeccao-kit-aluno`), testa cada candidato contra a
 * Receita validando CEP. "Achado na 1ª tentativa, sem precisar da 2ª/3ª" é o
 * equivalente mais próximo de "achado direto, sem pesquisa extra" que esta
 * arquitetura permite.
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { cnpjValido, lookupCnpj, type CnpjData } from "@/lib/prospecting/receita-client";
import { pesquisarGoogle } from "@/lib/prospecting/pesquisa-client";
import { createAdminClient } from "@/lib/supabase/admin";

export const PROSPECTING_CNPJ_CONSUMER_KEY = "prospecting_cnpj_v1";

/** Teto de tentativas de pesquisa por lugar — mesmo valor do kit (`TENTATIVAS`). */
const TENTATIVAS_CNPJ = 3;
/** Candidatos testados contra a Receita por tentativa — mesmo teto do kit (`acharCnpj`, `.slice(0, 4)`). */
const CANDIDATOS_POR_TENTATIVA = 4;

/** Número de CNPJ em qualquer formatação (com ou sem pontuação) num texto livre. */
const CNPJ_NO_TEXTO_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;

const normalizarTermo = (q: string): string => q.replace(/\s+/g, " ").trim();

/** As 3 buscas de CNPJ de um lugar, na ordem — mesmos 3 formatos do kit (`tentativasCnpj`). */
function tentativasCnpj(name: string, address: string | null): string[] {
  const cidade = address ?? "";
  return [`CNPJ ${name} ${cidade}`, `CNPJ ${name} ${cidade} Receita Federal`, `${name} ${address ?? cidade}`]
    .map(normalizarTermo)
    .slice(0, TENTATIVAS_CNPJ);
}

interface ResultadoBusca {
  dados: CnpjData | null;
  /** Só pra log/observabilidade — não há coluna própria pra isto (ver header do arquivo). */
  motivo: string;
}

/**
 * Pesquisa candidatos (regex nos resultados) e testa cada um contra a
 * Receita, validando CEP. Só passa pra próxima tentativa se NENHUM candidato
 * desta bateu — parar na primeira busca que trazia qualquer número deixava
 * candidatos de empresas homônimas sem chance (achado do kit, 18/set/2026,
 * replicado aqui de propósito).
 */
async function acharCnpjPorPesquisa(name: string, address: string | null): Promise<ResultadoBusca> {
  const tentativas = tentativasCnpj(name, address);
  const vistos = new Set<string>();

  for (const termo of tentativas) {
    // Propositalmente SEM try/catch aqui: falha de infraestrutura da pesquisa
    // (`APIFY_TOKEN` ausente/inválido, crédito esgotado, timeout) não é "não
    // achou" — é o worker inteiro incapaz de operar. Deixa propagar pro
    // try/catch de `enrichProspectCnpj`, que grava `cnpj_status='failed'`
    // (distinto de `'done'` com `cnpj_data=null`, que significa "pesquisou
    // de verdade e não achou nada que bata").
    const mapa = await pesquisarGoogle([termo]);

    const itens = mapa.get(termo) ?? [];
    const candidatosNovos: string[] = [];
    for (const item of itens) {
      const texto = `${item.titulo} ${item.trecho} ${item.link}`;
      for (const m of texto.matchAll(CNPJ_NO_TEXTO_RE)) {
        const c = m[0].replace(/\D/g, "");
        if (cnpjValido(c) && !vistos.has(c)) {
          vistos.add(c);
          candidatosNovos.push(c);
        }
      }
    }

    for (const candidato of candidatosNovos.slice(0, CANDIDATOS_POR_TENTATIVA)) {
      const resultado = await lookupCnpj(candidato, address);
      if (!("motivo" in resultado)) {
        return { dados: resultado, motivo: "" };
      }
    }
  }

  return {
    dados: null,
    motivo: vistos.size
      ? `${vistos.size} CNPJ(s) candidato(s) testado(s), nenhum bateu com o endereço`
      : "nenhum CNPJ encontrado na pesquisa",
  };
}

interface ProspectedPlaceForCnpj {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  cnpj_status: string;
}

/**
 * Handler principal — mesma assinatura `(row: EventRow) => Promise<HandlerResult>`
 * de `analyzeProspectSiteQuality`.
 */
export async function enrichProspectCnpj(row: EventRow): Promise<HandlerResult> {
  const consumer_key = PROSPECTING_CNPJ_CONSUMER_KEY;

  const prospectedPlaceId =
    (row.payload.prospected_place_id as string | undefined) ?? row.entity_id ?? undefined;
  if (!prospectedPlaceId) {
    return { consumer_key, status: "skipped", detail: "no prospected_place_id" };
  }

  const admin = createAdminClient();

  try {
    const { data, error } = await admin
      .from("prospected_places")
      .select("id, organization_id, name, address, cnpj_status")
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (error) return { consumer_key, status: "error", detail: error.message };

    const place = data as ProspectedPlaceForCnpj | null;
    if (!place) return { consumer_key, status: "skipped", detail: "prospected_place not found" };

    // ─── GUARD DE IDEMPOTÊNCIA (mesmo padrão do site-quality-worker) ───────
    if (place.cnpj_status === "done" || place.cnpj_status === "processing") {
      return { consumer_key, status: "skipped", detail: `already ${place.cnpj_status}` };
    }

    // Claim otimista — CAS por `cnpj_status`.
    const { data: claimed, error: claimErr } = await admin
      .from("prospected_places")
      .update({ cnpj_status: "processing" })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id)
      .eq("cnpj_status", place.cnpj_status)
      .select("id");
    if (claimErr) return { consumer_key, status: "error", detail: claimErr.message };
    if (!claimed?.length) {
      return { consumer_key, status: "skipped", detail: "concurrent claim lost" };
    }

    const { dados, motivo } = await acharCnpjPorPesquisa(place.name, place.address);
    if (motivo) {
      logger.info("[prospecting-cnpj] não encontrado", { prospected_place_id: place.id, motivo });
    }

    // T15 (`.specs/features/prospeccao-nichos-e-enriquecimento/`) precisa
    // mostrar "não encontrado" + O MOTIVO na ficha — e não existe coluna
    // própria pra isso (só `cnpj_data` jsonb). `{ motivo }` em vez de `null`
    // puro é o que torna esse motivo visível pra UI sem inventar coluna nova;
    // a UI distingue "não consultado" (status) de "consultado, sem achado"
    // (status='done' + cnpj_data sem `cnpj` dentro) pelo STATUS, não pelo
    // valor ser ou não `null` — ver `PlaceFicha.tsx`.
    const cnpjData = dados ?? (motivo ? { motivo } : null);

    const { error: updErr } = await admin
      .from("prospected_places")
      .update({
        cnpj_status: "done",
        cnpj_data: cnpjData,
        cnpj_consultado_em: new Date().toISOString(),
      })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id);
    if (updErr) throw new Error(`update (done) failed: ${updErr.message}`);

    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting-cnpj] enriquecimento falhou", {
      prospected_place_id: prospectedPlaceId,
      detail,
    });

    const { error: failErr } = await admin
      .from("prospected_places")
      .update({ cnpj_status: "failed" })
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id);

    if (failErr) {
      logger.error("[prospecting-cnpj] gravação de 'failed' também falhou", {
        prospected_place_id: prospectedPlaceId,
        detail: failErr.message,
      });
      return { consumer_key, status: "error", detail: `${detail}; also failed to persist: ${failErr.message}` };
    }

    // Mesma razão do site-quality-worker: "ok" marca o evento como
    // consumido, sem retry automático do drain sobre um CNPJ que falhou.
    return { consumer_key, status: "ok" };
  }
}
