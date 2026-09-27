/**
 * Consome `prospected_place.instagram_requested` (T10,
 * `.specs/features/prospeccao-nichos-e-enriquecimento/`): confirma o perfil
 * de Instagram de um `prospected_places` e recalcula o score final somando o
 * peso de Instagram do nicho quando um perfil válido é encontrado.
 *
 * Estrutura EXATA de `workers/prospecting-site-quality-worker.ts`/
 * `prospecting-cnpj-worker.ts` (T10 "Reuses"): mesmo guard de idempotência
 * por claim otimista (`instagram_status`), mesmo padrão de try/catch que
 * nunca deixa uma exceção escapar sem gravar `'failed'`, mesmo `status: "ok"`
 * depois de gravar `'failed'` (sem retry automático do drain).
 *
 * ─── Dois caminhos pro @ (design.md, "Components")
 *
 * 1. O evento já traz `instagram_link` (achado pelo `site-quality-worker`,
 *    T11, no HTML do site) → extrai o usuário do link e lê DIRETO, sem
 *    pesquisar.
 * 2. Sem link (resultado sem site, ou o evento veio direto da busca, T8) →
 *    pesquisa no Google (`pesquisa-client`, T6) por candidatos, pontua cada
 *    um pela marca do nome batendo no @/bio/título (mesmo critério do
 *    `prospeccao-kit-aluno`, `lib/pesquisa.mjs`, `procurarInstagram`), lê o
 *    melhor candidato.
 *
 * Em QUALQUER caminho, o perfil lido só é aceito se a marca do nome bater no
 * @ ou no texto (nome/bio) — perfil genérico sem marca nenhuma é descartado
 * (mesmo critério do kit, `perfilBate`, aqui simplificado: sem comparar
 * domínio do site nem telefone, que este worker não tem à mão sem uma
 * consulta extra — suficiente pro "genérico é descartado" do "Done when").
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { readInstagramProfile, usuarioDoLink, type InstagramProfile } from "@/lib/prospecting/apify-client";
import { pesquisarGoogle, type SearchResultItem } from "@/lib/prospecting/pesquisa-client";
import { labelFromScore, recalculateWithInstagram, type NicheWeights } from "@/lib/prospecting/score";
import { createAdminClient } from "@/lib/supabase/admin";

export const PROSPECTING_INSTAGRAM_CONSUMER_KEY = "prospecting_instagram_v1";

const TENTATIVAS_INSTAGRAM = 3;
/** Pontuação mínima pra aceitar já na tentativa corrente, sem gastar a próxima (mesmo teto do kit). */
const PONTUACAO_ACEITA_CEDO = 4;
/** Pontuação mínima pra aceitar depois de esgotar todas as tentativas (mesmo teto do kit). */
const PONTUACAO_MINIMA = 2;

const normal = (s: string | null | undefined): string =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Palavras genéricas do ramo que não identificam a MARCA — mesma lista do kit (`lib/pesquisa.mjs`, `GENERICAS`). */
const GENERICAS = new Set([
  "clinica", "clinicas", "odontologia", "odontologica", "odonto", "consultorio", "dentista",
  "dr", "dra", "centro", "energia", "solar", "de", "da", "do", "das", "dos", "e", "em", "ltda", "me", "the",
]);

/** As palavras que identificam a marca: "Clínica OSPE" → ["ospe"]. Sem palavra própria, fica o nome inteiro. */
function marca(nome: string): string[] {
  const partes = normal(nome).split(" ").filter((p) => p.length > 2 && !GENERICAS.has(p));
  return partes.length ? partes : normal(nome).split(" ").filter((p) => p.length > 2);
}

const PERFIS_GENERICOS = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "popular"]);

/** "…(@clinbelo) · Belo Horizonte" ou instagram.com/clinbelo/ → "clinbelo". Mesma regra do kit. */
function usuariosDoResultado(item: SearchResultItem): string[] {
  const achados: string[] = [];
  const doLink = item.link.match(/instagram\.com\/([A-Za-z0-9_.]{2,30})\/?(?:$|\?)/i)?.[1];
  if (doLink && !PERFIS_GENERICOS.has(doLink.toLowerCase())) achados.push(doLink.toLowerCase());
  for (const m of `${item.titulo} ${item.trecho}`.matchAll(/\(@([A-Za-z0-9_.]{2,30})\)|@([A-Za-z0-9_.]{3,30})/g)) {
    const u = (m[1] ?? m[2] ?? "").replace(/\.$/, "").toLowerCase();
    if (u && !PERFIS_GENERICOS.has(u) && !achados.includes(u)) achados.push(u);
  }
  return achados;
}

const normalizarTermo = (q: string): string => q.replace(/\s+/g, " ").trim();

function tentativasInstagram(name: string, address: string | null): string[] {
  const cidade = address ?? "";
  return [`${name} ${cidade}`, `site:instagram.com ${name} ${cidade}`, `instagram ${name} ${cidade}`]
    .map(normalizarTermo)
    .slice(0, TENTATIVAS_INSTAGRAM);
}

/**
 * Pesquisa candidatos e pontua cada um pela marca do nome batendo no @, no
 * texto (título+trecho) ou na cidade. Para cedo (pontuação >= 4) quando a
 * marca bate no @ E no texto; senão, ao fim das tentativas, aceita o melhor
 * candidato com pontuação >= 2 — mesmos limites do kit (`procurarInstagram`).
 */
async function procurarInstagramPorPesquisa(name: string, address: string | null): Promise<string | null> {
  const tokens = marca(name);
  const cidade = normal(address);
  const pontos = new Map<string, number>();

  for (const termo of tentativasInstagram(name, address)) {
    // Sem try/catch aqui de propósito — mesma razão do prospecting-cnpj-worker:
    // falha de infraestrutura da pesquisa propaga pro try/catch do handler,
    // que grava 'failed' (distinto de "pesquisou e não achou marca nenhuma").
    const mapa = await pesquisarGoogle([termo]);
    const itens = mapa.get(termo) ?? [];

    for (const item of itens) {
      const ehInsta = /instagram\.com/i.test(item.link);
      for (const u of usuariosDoResultado(item)) {
        // @ solto num site qualquer (não Instagram) só conta se o próprio
        // título já citar esse @ explicitamente — mesma guarda do kit.
        if (!ehInsta && !item.titulo.includes(`@${u}`)) continue;
        const texto = normal(`${item.titulo} ${item.trecho}`);
        let p = 0;
        if (tokens.some((t) => u.replace(/[._]/g, "").includes(t))) p += 2;
        if (tokens.every((t) => texto.includes(t))) p += 2;
        if (cidade && texto.includes(cidade)) p += 1;
        pontos.set(u, Math.max(pontos.get(u) ?? 0, p));
      }
    }

    const melhorAgora = [...pontos].sort((a, b) => b[1] - a[1])[0];
    if (melhorAgora && melhorAgora[1] >= PONTUACAO_ACEITA_CEDO) return melhorAgora[0];
  }

  const melhor = [...pontos].sort((a, b) => b[1] - a[1])[0];
  return melhor && melhor[1] >= PONTUACAO_MINIMA ? melhor[0] : null;
}

/**
 * O perfil LIDO é mesmo da empresa? A marca do nome tem que bater no @ (sem
 * pontuação) ou no texto (nome + bio) inteiro — mesmo critério do kit
 * (`perfilBate`), sem comparar domínio do site nem telefone (este worker não
 * tem esses dois dados à mão sem uma consulta extra; suficiente pro "perfil
 * genérico é descartado" do "Done when" desta task).
 */
function perfilBate(perfil: InstagramProfile, name: string): boolean {
  const tokens = marca(name);
  const usuario = perfil.usuario.toLowerCase().replace(/[._]/g, "");
  const texto = normal(`${perfil.usuario} ${perfil.nome ?? ""} ${perfil.bio ?? ""}`);
  return tokens.some((t) => usuario.includes(t)) || tokens.every((t) => texto.includes(t));
}

interface ProspectedPlaceForInstagram {
  id: string;
  organization_id: string;
  search_id: string;
  name: string;
  address: string | null;
  score_initial: number;
  score_final: number | null;
  instagram_status: string;
}

/**
 * Handler principal — mesma assinatura `(row: EventRow) => Promise<HandlerResult>`
 * dos outros workers de prospecção.
 */
export async function enrichProspectInstagram(row: EventRow): Promise<HandlerResult> {
  const consumer_key = PROSPECTING_INSTAGRAM_CONSUMER_KEY;

  const prospectedPlaceId =
    (row.payload.prospected_place_id as string | undefined) ?? row.entity_id ?? undefined;
  if (!prospectedPlaceId) {
    return { consumer_key, status: "skipped", detail: "no prospected_place_id" };
  }

  const admin = createAdminClient();

  try {
    const { data, error } = await admin
      .from("prospected_places")
      .select("id, organization_id, search_id, name, address, score_initial, score_final, instagram_status")
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (error) return { consumer_key, status: "error", detail: error.message };

    const place = data as ProspectedPlaceForInstagram | null;
    if (!place) return { consumer_key, status: "skipped", detail: "prospected_place not found" };

    // ─── GUARD DE IDEMPOTÊNCIA (mesmo padrão dos outros dois workers) ──────
    if (place.instagram_status === "done" || place.instagram_status === "processing") {
      return { consumer_key, status: "skipped", detail: `already ${place.instagram_status}` };
    }

    // T16: sem APIFY_TOKEN, o peso de Instagram fica inerte — nem tenta.
    // Direto pra `not_applicable`, sem passar por `processing`/claim: não há
    // trabalho assíncrono nenhum disputando esta linha neste caminho.
    if (!env.APIFY_TOKEN) {
      const { error: naErr } = await admin
        .from("prospected_places")
        .update({ instagram_status: "not_applicable" })
        .eq("id", place.id)
        .eq("organization_id", place.organization_id);
      if (naErr) return { consumer_key, status: "error", detail: naErr.message };
      return { consumer_key, status: "ok" };
    }

    // Claim otimista — CAS por `instagram_status`.
    const { data: claimed, error: claimErr } = await admin
      .from("prospected_places")
      .update({ instagram_status: "processing" })
      .eq("id", place.id)
      .eq("organization_id", place.organization_id)
      .eq("instagram_status", place.instagram_status)
      .select("id");
    if (claimErr) return { consumer_key, status: "error", detail: claimErr.message };
    if (!claimed?.length) {
      return { consumer_key, status: "skipped", detail: "concurrent claim lost" };
    }

    // Pesos do nicho da busca — 2 consultas sequenciais (place.search_id →
    // niche_id → weights), mesmo espírito simples de sequenciar leituras já
    // usado nos outros workers desta feature (sem join aninhado).
    const { data: searchRow, error: searchErr } = await admin
      .from("prospected_searches")
      .select("niche_id")
      .eq("id", place.search_id)
      .maybeSingle();
    if (searchErr) throw new Error(`load search failed: ${searchErr.message}`);

    let weights: NicheWeights | null = null;
    if (searchRow?.niche_id) {
      const { data: nicheRow, error: nicheErr } = await admin
        .from("prospecting_niches")
        .select("weights")
        .eq("id", searchRow.niche_id as string)
        .maybeSingle();
      if (nicheErr) throw new Error(`load niche failed: ${nicheErr.message}`);
      weights = (nicheRow?.weights as NicheWeights | undefined) ?? null;
    }

    const linkDoEvento = (row.payload.instagram_link as string | null | undefined) ?? null;
    let usuario = linkDoEvento ? usuarioDoLink(linkDoEvento) : null;
    if (!usuario) {
      usuario = await procurarInstagramPorPesquisa(place.name, place.address);
    }

    let perfilAceito: InstagramProfile | null = null;
    let motivoNaoAceito: string | null = null;
    if (!usuario) {
      motivoNaoAceito = "nenhum perfil de Instagram encontrado na pesquisa";
    } else {
      const resultado = await readInstagramProfile(usuario);
      if ("erro" in resultado) {
        motivoNaoAceito = resultado.erro;
        logger.info("[prospecting-instagram] leitura sem sucesso", {
          prospected_place_id: place.id,
          motivo: resultado.erro,
        });
      } else if (perfilBate(resultado, place.name)) {
        perfilAceito = resultado;
      } else {
        motivoNaoAceito = `perfil @${resultado.usuario} encontrado, mas sem a marca do nome (provável perfil genérico)`;
        logger.info("[prospecting-instagram] perfil descartado (sem marca)", {
          prospected_place_id: place.id,
          usuario: resultado.usuario,
        });
      }
    }

    // T15 precisa mostrar "não encontrado" + motivo na ficha — mesma solução
    // de `prospecting-cnpj-worker.ts` (`{ motivo }` em vez de `null` puro; a
    // UI distingue "não consultado" de "consultado, sem achado" pelo STATUS,
    // não pelo valor ser `null`).
    const patch: Record<string, unknown> = {
      instagram_status: "done",
      instagram_data: perfilAceito ?? (motivoNaoAceito ? { motivo: motivoNaoAceito } : null),
      instagram_consultado_em: new Date().toISOString(),
    };

    if (perfilAceito && weights) {
      const scoreAtual = place.score_final ?? place.score_initial;
      const recalculado = recalculateWithInstagram({ score: scoreAtual, label: labelFromScore(scoreAtual) }, true, weights);
      patch.score_final = recalculado.score;
      patch.status_label = recalculado.label;
    }

    const { error: updErr } = await admin
      .from("prospected_places")
      .update(patch)
      .eq("id", place.id)
      .eq("organization_id", place.organization_id);
    if (updErr) throw new Error(`update (done) failed: ${updErr.message}`);

    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting-instagram] enriquecimento falhou", {
      prospected_place_id: prospectedPlaceId,
      detail,
    });

    const { error: failErr } = await admin
      .from("prospected_places")
      .update({ instagram_status: "failed" })
      .eq("id", prospectedPlaceId)
      .eq("organization_id", row.organization_id);

    if (failErr) {
      logger.error("[prospecting-instagram] gravação de 'failed' também falhou", {
        prospected_place_id: prospectedPlaceId,
        detail: failErr.message,
      });
      return { consumer_key, status: "error", detail: `${detail}; also failed to persist: ${failErr.message}` };
    }

    // Mesma razão dos outros workers: "ok" marca o evento como consumido,
    // sem retry automático do drain.
    return { consumer_key, status: "ok" };
  }
}
