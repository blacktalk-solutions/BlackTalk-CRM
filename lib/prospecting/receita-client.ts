/**
 * Client de consulta de CNPJ na Receita Federal — T4
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Port de `prospeccao-kit-aluno/lib/cnpj.mjs` (`consultarCnpj`,
 * `mesmoEndereco`, `decisor`, `cnpjValido`) — duas APIs públicas, sem chave:
 * BrasilAPI primeiro (sem limite rígido, exige `User-Agent`), cnpj.ws como
 * reserva (3 consultas/min).
 *
 * Desvio do `design.md` (registrado aqui, mesma doutrina de "Notas CONFIRMED
 * vs INFERRED" do spec): a interface documentada era
 * `lookupCnpj(nomeEmpresa, cepEsperado)`, mas nenhuma das duas APIs busca por
 * NOME — as duas só consultam por NÚMERO de CNPJ já conhecido. O kit contorna
 * isso achando candidatos por regex nos resultados de uma pesquisa no Google
 * (`lib/pesquisa.mjs`, `acharCnpj`) e testando cada um contra a Receita
 * (`confere`). Esta função recebe o CNPJ CANDIDATO (não o nome) e o CEP
 * esperado — a orquestração "achar candidatos pelo nome via
 * `pesquisa-client.ts` (T6) e testar um por um" fica pro worker (T9), mesma
 * divisão de responsabilidade do kit (`pesquisa.mjs` acha, `cnpj.mjs`
 * confere).
 *
 * Segundo desvio: o kit espera 61s (`espera(61_000)`) quando o cnpj.ws
 * devolve 429 (estourou os 3/min) e tenta de novo — aceitável num script
 * interativo (`prospectar.mjs`), não num worker de fila que drena `event_log`
 * em lote (bloquear um consumer por 61s trava a fila inteira atrás dele).
 * Aqui, 429 é tratado como falha temporária (`{ motivo }`), sem retry
 * bloqueante — T9 decide se tenta de novo num próximo ciclo do cron.
 */

const USER_AGENT = "btcrm-prospeccao/1.0";
const REQUEST_HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };

const soDigitos = (v: string | null | undefined): string => String(v ?? "").replace(/\D/g, "");

/** 8599604 -> "8599-6/04": o CNAE como a Receita escreve. */
function formatarCnae(c: string | number | null | undefined): string {
  return soDigitos(String(c ?? "")).padStart(7, "0").replace(/^(\d{4})(\d)(\d{2})$/, "$1-$2/$3");
}

/** 11222333000181 -> "11.222.333/0001-81". */
function formatarCnpj(c: string): string {
  return soDigitos(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/**
 * Dígito verificador: descarta um CNPJ torto (formato inválido, ou os 14
 * dígitos todos iguais) antes de gastar uma consulta de rede.
 */
export function cnpjValido(v: string): boolean {
  const c = soDigitos(v);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base: string): number => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const resto = [...base].reduce((s, d, i) => s + Number(d) * (pesos[i] ?? 0), 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(c.slice(0, 12)) === Number(c[12]) && dv(c.slice(0, 13)) === Number(c[13]);
}

/** Um sócio, normalizado dos dois formatos de resposta (BrasilAPI/cnpj.ws). */
export interface CnpjSocio {
  nome: string | null;
  cargo: string | null;
  desde: string | null;
  faixaEtaria: string | null;
}

/** Dados normalizados da Receita — mesmos campos do kit, em camelCase. */
export interface CnpjData {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacao: string | null;
  abertura: string | null;
  capitalSocial: number | null;
  porte: string | null;
  atividade: string | null;
  cnae: string | null;
  naturezaJuridica: string | null;
  cep: string | null;
  municipio: string | null;
  uf: string | null;
  telefones: string[];
  email: string | null;
  socios: CnpjSocio[];
  /** O sócio-administrador; sem ele, o primeiro sócio da lista. Nunca é I/O — deriva de `socios`. */
  socioAdministrador: string | null;
}

/** Quando a consulta não é aceita — motivo em português, pronto pra `prospected_places.motivo_requisitos`-like uso. */
export interface CnpjLookupRejected {
  motivo: string;
}

function decisor(socios: CnpjSocio[]): string | null {
  return (socios.find((s) => /administrador/i.test(s.cargo ?? "")) ?? socios[0])?.nome ?? null;
}

const telefonesReceita = (...brutos: Array<string | null | undefined>): string[] => [
  ...new Set(
    brutos
      .map((b) => soDigitos(b))
      .filter((t) => t.length >= 10)
      .map((t) => `55${t}`),
  ),
];

const emailReceita = (e: string | null | undefined): string | null =>
  e && /@/.test(e) ? String(e).trim().toLowerCase() : null;

/** Forma (parcial, só o que lemos) da resposta da BrasilAPI. */
interface BrasilApiResponse {
  cnpj: string;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  descricao_situacao_cadastral?: string | null;
  data_inicio_atividade?: string | null;
  capital_social?: number | string | null;
  porte?: string | null;
  cnae_fiscal_descricao?: string | null;
  cnae_fiscal?: number | string | null;
  natureza_juridica?: string | null;
  cep?: string | null;
  municipio?: string | null;
  uf?: string | null;
  ddd_telefone_1?: string | null;
  ddd_telefone_2?: string | null;
  email?: string | null;
  qsa?: Array<{
    nome_socio?: string | null;
    qualificacao_socio?: string | null;
    data_entrada_sociedade?: string | null;
    faixa_etaria?: string | null;
  }>;
}

function fromBrasilApi(j: BrasilApiResponse): CnpjData {
  const socios: CnpjSocio[] = (j.qsa ?? []).map((s) => ({
    nome: s.nome_socio ?? null,
    cargo: s.qualificacao_socio ?? null,
    desde: s.data_entrada_sociedade ?? null,
    faixaEtaria: s.faixa_etaria || null,
  }));
  return {
    cnpj: formatarCnpj(j.cnpj),
    razaoSocial: j.razao_social ?? null,
    nomeFantasia: j.nome_fantasia || null,
    situacao: j.descricao_situacao_cadastral ?? null,
    abertura: j.data_inicio_atividade ?? null,
    capitalSocial: j.capital_social != null ? Number(j.capital_social) : null,
    porte: j.porte ?? null,
    atividade: j.cnae_fiscal_descricao ?? null,
    cnae: j.cnae_fiscal ? formatarCnae(j.cnae_fiscal) : null,
    naturezaJuridica: j.natureza_juridica ?? null,
    cep: soDigitos(j.cep) || null,
    municipio: j.municipio ?? null,
    uf: j.uf ?? null,
    telefones: telefonesReceita(j.ddd_telefone_1, j.ddd_telefone_2),
    email: emailReceita(j.email),
    socios,
    socioAdministrador: decisor(socios),
  };
}

/** Forma (parcial) da resposta do cnpj.ws. */
interface CnpjWsResponse {
  razao_social?: string | null;
  capital_social?: number | string | null;
  natureza_juridica?: { descricao?: string | null } | null;
  porte?: { descricao?: string | null } | null;
  estabelecimento?: {
    cnpj?: string;
    nome_fantasia?: string | null;
    situacao_cadastral?: string | null;
    data_inicio_atividade?: string | null;
    atividade_principal?: { id?: string | number; descricao?: string | null } | null;
    cep?: string | null;
    cidade?: { nome?: string | null } | null;
    estado?: { sigla?: string | null } | null;
    ddd1?: string | null;
    telefone1?: string | null;
    ddd2?: string | null;
    telefone2?: string | null;
    email?: string | null;
  } | null;
  socios?: Array<{
    nome?: string | null;
    qualificacao_socio?: { descricao?: string | null } | null;
    data_entrada?: string | null;
    faixa_etaria?: string | null;
  }>;
}

function fromCnpjWs(j: CnpjWsResponse): CnpjData {
  const e = j.estabelecimento ?? {};
  const socios: CnpjSocio[] = (j.socios ?? []).map((s) => ({
    nome: s.nome ?? null,
    cargo: s.qualificacao_socio?.descricao?.trim() ?? null,
    desde: s.data_entrada ?? null,
    faixaEtaria: s.faixa_etaria || null,
  }));
  return {
    cnpj: formatarCnpj(e.cnpj ?? ""),
    razaoSocial: j.razao_social ?? null,
    nomeFantasia: e.nome_fantasia || null,
    situacao: e.situacao_cadastral ?? null,
    abertura: e.data_inicio_atividade ?? null,
    capitalSocial: j.capital_social != null ? Number(j.capital_social) : null,
    porte: j.porte?.descricao ?? null,
    atividade: e.atividade_principal?.descricao ?? null,
    cnae: e.atividade_principal?.id ? formatarCnae(e.atividade_principal.id) : null,
    naturezaJuridica: j.natureza_juridica?.descricao ?? null,
    cep: soDigitos(e.cep) || null,
    municipio: e.cidade?.nome ?? null,
    uf: e.estado?.sigla ?? null,
    telefones: telefonesReceita(`${e.ddd1 ?? ""}${e.telefone1 ?? ""}`, `${e.ddd2 ?? ""}${e.telefone2 ?? ""}`),
    email: emailReceita(e.email),
    socios,
    socioAdministrador: decisor(socios),
  };
}

/** Dependências injetáveis — produção usa `fetch` real; testes injetam um mock. */
export interface ReceitaClientDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Consulta a Receita por um CNPJ já conhecido (BrasilAPI, com cnpj.ws como
 * reserva). `null` quando nenhuma das duas confirma o CNPJ (inexistente, ou
 * as duas fora do ar) — nunca lança.
 */
async function consultarCnpj(cnpj: string, fetchImpl: typeof fetch): Promise<CnpjData | null> {
  const c = soDigitos(cnpj);

  try {
    const r = await fetchImpl(`https://brasilapi.com.br/api/cnpj/v1/${c}`, { headers: REQUEST_HEADERS });
    if (r.ok) return fromBrasilApi((await r.json()) as BrasilApiResponse);
    if (r.status === 404) return null;
  } catch {
    // Falha de transporte na BrasilAPI: cai pra reserva, não propaga.
  }

  try {
    const r = await fetchImpl(`https://publica.cnpj.ws/cnpj/${c}`, { headers: REQUEST_HEADERS });
    if (r.ok) return fromCnpjWs((await r.json()) as CnpjWsResponse);
    // 404 (não existe), 429 (rate limit da reserva) ou qualquer outro erro:
    // nenhuma retry bloqueante aqui — ver nota no topo do arquivo sobre o
    // `espera(61_000)` do kit não caber num worker de fila.
    return null;
  } catch {
    return null;
  }
}

/**
 * O CNPJ achado (pela pesquisa no Google, T6, fora deste arquivo) é mesmo
 * desta empresa? O CEP do endereço do Maps manda (5 primeiros dígitos: o
 * sufixo varia entre prédio e rua). Sem CEP no endereço do Maps, vale o
 * município conter o texto do endereço.
 */
export function mesmoEndereco(enderecoMaps: string | null | undefined, dados: CnpjData): boolean {
  const cepMaps = soDigitos(String(enderecoMaps ?? "").match(/\d{5}-?\d{3}/)?.[0]);
  if (cepMaps && dados.cep) return cepMaps.slice(0, 5) === dados.cep.slice(0, 5);
  const semAcento = (s: string | null | undefined) =>
    String(s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  return Boolean(dados.municipio) && semAcento(enderecoMaps).includes(semAcento(dados.municipio));
}

/**
 * Consulta um CNPJ candidato e só aceita se o CEP bater com o endereço do
 * Google Maps — mesma regra de validação cruzada do kit (evita confundir
 * empresas de nome parecido, achado real do kit em 18/set/2026: a busca deu
 * o CNPJ de outra clínica quase homônima).
 *
 * @param cnpj CNPJ candidato (achado por regex numa pesquisa no Google, T6 —
 *   este client não busca por nome, ver nota no topo do arquivo).
 * @param enderecoMapsEsperado Endereço completo do resultado no Google Maps
 *   (`prospected_places.address`), de onde o CEP esperado é extraído.
 * @returns Dados da Receita quando aceito, ou `{ motivo }` quando descartado
 *   (CNPJ com dígito verificador inválido, não encontrado nas duas APIs, ou
 *   CEP não bate). Nunca lança — falha de rede vira `{ motivo }`.
 */
export async function lookupCnpj(
  cnpj: string,
  enderecoMapsEsperado: string | null | undefined,
  deps: ReceitaClientDeps = {},
): Promise<CnpjData | CnpjLookupRejected> {
  if (!cnpjValido(cnpj)) {
    return { motivo: `CNPJ com dígito verificador inválido: ${cnpj}` };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  let dados: CnpjData | null;
  try {
    dados = await consultarCnpj(cnpj, fetchImpl);
  } catch (erro) {
    // Rede/timeout: nunca propaga — vira motivo, mesma doutrina de
    // `places-client.ts` (nunca exception genérica pra quem chama).
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    return { motivo: `Falha ao consultar a Receita: ${detalhe}` };
  }

  if (!dados) {
    return { motivo: `CNPJ ${formatarCnpj(cnpj)} não encontrado na Receita` };
  }

  if (!mesmoEndereco(enderecoMapsEsperado, dados)) {
    return { motivo: `CEP da Receita (${dados.cep ?? "sem CEP"}) não bate com o endereço do Maps` };
  }

  return dados;
}
