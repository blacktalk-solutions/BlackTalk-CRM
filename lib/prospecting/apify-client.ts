/**
 * Client de leitura de perfil de Instagram via Apify — T5
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Port de `prospeccao-kit-aluno/lib/instagram.mjs` (`consultarPerfis`,
 * `resumirPerfil`, `usuarioDoLink`) — mesmo ator (`apify~instagram-profile-scraper`),
 * mesma doutrina de "regra, não IA" (`docs/por-que-regex-e-nao-ia.md` do kit):
 * os números vêm direto do Apify, sem inferência.
 *
 * Server-only por construção — mesma nota de `places-client.ts`: lê
 * `APIFY_TOKEN` de `lib/env.ts`, nunca deveria ser importado por um Client
 * Component.
 *
 * Desvio do kit: `consultarPerfis` de lá aceita um LOTE de usernames (uma
 * chamada só, mais barato). Aqui `readInstagramProfile` é por perfil — T10
 * (worker) processa um resultado por vez (mesmo padrão de
 * `prospecting-site-quality-worker.ts`, uma linha por vez com falha
 * isolada); lotear é uma otimização de custo que pode entrar depois sem
 * mudar esta assinatura pública.
 */

import { env } from "@/lib/env";

const ATOR = "apify~instagram-profile-scraper";
const DIA_MS = 86_400_000;

/**
 * "https://www.instagram.com/clinica.ospe/?hl=pt" → "clinica.ospe". Link de
 * post/reel/explorar não é perfil — devolve `null`. Mesma lista do kit.
 */
export function usuarioDoLink(link: string | null | undefined): string | null {
  const m = String(link ?? "").match(/instagram\.com\/([A-Za-z0-9_.]{2,30})/i);
  if (!m) return null;
  const u = (m[1] ?? "").toLowerCase();
  const NAO_E_PERFIL = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct"]);
  return NAO_E_PERFIL.has(u) ? null : u;
}

/** Item cru do dataset do Apify — só os campos que `resumirPerfil` lê. */
interface RawApifyPost {
  timestamp?: string;
  likesCount?: number;
  commentsCount?: number;
  type?: string;
  caption?: string;
}

interface RawApifyProfile {
  error?: unknown;
  username?: string;
  fullName?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  verified?: boolean;
  isBusinessAccount?: boolean;
  businessCategoryName?: string;
  biography?: string;
  externalUrl?: string;
  latestPosts?: RawApifyPost[];
}

/** Perfil de Instagram normalizado — os 4 campos do `design.md` mais o resto que o kit já calculava. */
export interface InstagramProfile {
  usuario: string;
  nome: string | null;
  seguidores: number;
  seguindo: number | null;
  posts: number | null;
  verificado: boolean;
  comercial: boolean;
  categoria: string | null;
  bio: string | null;
  linkBio: string | null;
  ultimoPost: string | null;
  diasSemPostar: number | null;
  posts30Dias: number;
  mediaCurtidas: number | null;
  mediaComentarios: number | null;
  /** Percentual (ex.: `3.2` = 3,2%) — `(mediaCurtidas + mediaComentarios) / seguidores * 100`. `null` sem base pra calcular. */
  engajamentoMedio: number | null;
}

/** Quando a leitura não é possível — nunca lança, sempre uma destas duas formas. */
export interface InstagramProfileError {
  erro: string;
}

// Corta por caractere, não por unidade de código: slice no meio de um emoji
// deixa meio par (surrogate solto) e o Postgres recusa o jsonb inteiro —
// mesmo achado do kit (18/set/2026, "invalid input syntax for type json").
const SURROGATE_SOLTO = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\x00/g;
function cortar(t: string | null | undefined, n: number): string {
  return Array.from(String(t ?? "").replace(SURROGATE_SOLTO, "")).slice(0, n).join("");
}

function media(posts: RawApifyPost[], campo: "likesCount" | "commentsCount"): number | null {
  // curtida escondida pelo dono vem como -1 do Apify: fora da média.
  const v = posts.map((p) => p[campo]).filter((n): n is number => typeof n === "number" && n >= 0);
  return v.length ? Math.round(v.reduce((s, n) => s + n, 0) / v.length) : null;
}

/** O perfil cru vira o que a prospecção usa. `null` se o perfil não existe ou é privado. */
function resumirPerfil(p: RawApifyProfile, agora: number): InstagramProfile | null {
  if (!p || p.error || p.followersCount == null) return null;

  const posts = (p.latestPosts ?? [])
    .filter((x): x is RawApifyPost & { timestamp: string } => Boolean(x.timestamp))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const ultimo = posts[0]?.timestamp ?? null;
  const mediaCurtidas = media(posts, "likesCount");
  const mediaComentarios = media(posts, "commentsCount");
  const seguidores = p.followersCount;

  let engajamentoMedio: number | null = null;
  if (mediaCurtidas != null && seguidores > 0) {
    const pct = ((mediaCurtidas + (mediaComentarios ?? 0)) / seguidores) * 100;
    engajamentoMedio = Math.round(pct * 10) / 10;
  }

  return {
    usuario: p.username ?? "",
    nome: cortar(p.fullName, 200) || null,
    seguidores,
    seguindo: p.followsCount ?? null,
    posts: p.postsCount ?? null,
    verificado: Boolean(p.verified),
    comercial: Boolean(p.isBusinessAccount),
    categoria: p.businessCategoryName || null,
    bio: cortar(p.biography, 500) || null,
    linkBio: p.externalUrl || null,
    ultimoPost: ultimo,
    diasSemPostar: ultimo ? Math.floor((agora - Date.parse(ultimo)) / DIA_MS) : null,
    posts30Dias: posts.filter((x) => agora - Date.parse(x.timestamp) <= 30 * DIA_MS).length,
    mediaCurtidas,
    mediaComentarios,
    engajamentoMedio,
  };
}

/** Dependências injetáveis — produção usa `fetch`/`Date.now()` reais; testes injetam mocks. */
export interface ApifyClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Lê um perfil de Instagram via Apify. Nunca lança — token ausente, 401
 * (token inválido), 402 (crédito esgotado), qualquer outro erro HTTP, falha
 * de rede, ou perfil inexistente/privado viram `{ erro }` com mensagem
 * específica (nunca uma exception genérica pra quem chama).
 *
 * @param username Handle sem `@` (ex.: `"clinica.ospe"`).
 */
export async function readInstagramProfile(
  username: string,
  deps: ApifyClientDeps = {},
): Promise<InstagramProfile | InstagramProfileError> {
  const token = env.APIFY_TOKEN;
  if (!token) {
    return { erro: "APIFY_TOKEN não configurado — enriquecimento de Instagram desativado." };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.apify.com/v2/acts/${ATOR}/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [username] }),
      },
    );
  } catch (transportError) {
    const detalhe = transportError instanceof Error ? transportError.message : String(transportError);
    return { erro: `Falha de transporte ao consultar o Apify: ${detalhe}` };
  }

  if (!response.ok) {
    if (response.status === 401) {
      return { erro: "APIFY_TOKEN inválido (401). Gere um novo em console.apify.com/settings/integrations." };
    }
    if (response.status === 402) {
      return { erro: "Crédito do Apify esgotado (402). O plano gratuito renova todo mês." };
    }
    const corpo = (await response.text().catch(() => "")).slice(0, 200);
    return { erro: `Apify respondeu ${response.status}: ${corpo}` };
  }

  const itens = ((await response.json().catch(() => [])) ?? []) as RawApifyProfile[];
  const primeiro = itens[0];
  const perfil = primeiro ? resumirPerfil(primeiro, now()) : null;

  if (!perfil) {
    return { erro: `Perfil "${username}" não encontrado ou privado.` };
  }

  return perfil;
}
