/**
 * Zod schema para `/api/v1/prospecting/*` (T4 do plano
 * `.specs/features/prospeccao-google-maps/`).
 *
 *  - prospectingSearchSchema → POST /api/v1/prospecting/searches
 *
 * `serviceType` é LITERAL, não enum livre: v1 só sabe prospectar para o
 * serviço "venda de site" (design.md, Tech Decisions). A coluna
 * `prospected_searches.service_type` foi deixada SEM CHECK no banco de
 * propósito (migration 0234) — fechar o vocabulário aqui, na borda, é o
 * lugar certo; um CHECK a mais no banco seria fechar duas vezes o que só
 * precisa fechar uma.
 */
import { z } from "zod";

/**
 * T8 (`.specs/features/prospeccao-nichos-e-enriquecimento/`): `serviceType`
 * (literal fixo `"venda_de_site"`) vira `nicheId` — a busca não diz mais o
 * tipo de serviço direto, ela ESCOLHE um nicho já cadastrado (T7), que carrega
 * seu próprio `service_type` (texto livre).
 *
 * `nicheId` é OPCIONAL aqui de propósito: a ausência de nicho tem um código
 * de erro PRÓPRIO (`400 niche_required`, checado na rota) — diferente do
 * `422 validation_error` genérico que o caminho automático de erro Zod
 * devolveria se fosse obrigatório neste schema. Mesma razão de `weights` não
 * validar a soma 100 aqui (ver `nicheWeightsSchema` abaixo).
 */
export const prospectingSearchSchema = z.object({
  businessType: z.string().min(1, "businessType é obrigatório"),
  location: z.string().min(1, "location é obrigatório"),
  nicheId: z.string().optional(),
});
export type ProspectingSearchInput = z.infer<typeof prospectingSearchSchema>;

/**
 * Pesos por sinal de um nicho — T7 (`.specs/features/prospeccao-nichos-e-enriquecimento/`,
 * migration 0236). Cada peso é 0-100; a SOMA a 100 é checada na ROTA (não
 * aqui, via `.refine`), porque a recusa precisa de um `code` próprio
 * (`weights_not_100`) e mostrar o total — o caminho automático de
 * `validateRequest`/erro Zod devolve sempre `422 validation_error`, forma
 * genérica demais pro que o `design.md` pede aqui. Mesmos 9 campos de
 * `lib/prospecting/score.ts` (`NicheWeights`) — não redigite a lista lá.
 */
export const nicheWeightsSchema = z.object({
  site: z.number().min(0).max(100),
  instagram: z.number().min(0).max(100),
  whatsapp: z.number().min(0).max(100),
  email: z.number().min(0).max(100),
  telefone: z.number().min(0).max(100),
  reputacao: z.number().min(0).max(100),
  cnpj: z.number().min(0).max(100),
  endereco: z.number().min(0).max(100),
  linkedin: z.number().min(0).max(100),
});

/** O que ELIMINA um resultado do nicho — mesmos 4 campos de `NicheRequirements` em `score.ts`. */
export const nicheRequirementsSchema = z.object({
  avaliacoesMin: z.number().min(0).optional(),
  avaliacoesMax: z.number().min(0).optional(),
  exigeCelular: z.boolean().optional(),
  exigeSite: z.boolean().optional(),
});

/** `POST /api/v1/prospecting/niches` — todos os campos obrigatórios (criação). */
export const prospectingNicheCreateSchema = z.object({
  name: z.string().min(1, "name é obrigatório").max(120),
  serviceType: z.string().min(1, "serviceType é obrigatório").max(120),
  searchTerms: z.array(z.string().min(1)).min(1, "ao menos um termo de busca é obrigatório"),
  requirements: nicheRequirementsSchema.optional().default({}),
  weights: nicheWeightsSchema,
});
export type ProspectingNicheCreateInput = z.infer<typeof prospectingNicheCreateSchema>;

/**
 * `PATCH /api/v1/prospecting/niches/[id]` — todos os campos opcionais
 * (edição parcial). `.partial()` em vez de repetir os campos: repetir criaria
 * duas listas pra manter em sincronia, e a segunda envelhece calada (mesmo
 * padrão de `app/api/v1/agenda/tipos/route.ts`, `alterarSchema`).
 */
export const prospectingNicheUpdateSchema = prospectingNicheCreateSchema
  .omit({ requirements: true })
  .partial()
  .extend({ requirements: nicheRequirementsSchema.optional() });
export type ProspectingNicheUpdateInput = z.infer<typeof prospectingNicheUpdateSchema>;

/**
 * Soma dos 9 pesos, arredondada a 2 casas (evita falso-negativo por ponto
 * flutuante, ex.: `0.1 + 0.2 !== 0.3`). Fora do schema de propósito — ver a
 * nota em `nicheWeightsSchema`.
 */
export function sumNicheWeights(weights: z.infer<typeof nicheWeightsSchema>): number {
  const total =
    weights.site +
    weights.instagram +
    weights.whatsapp +
    weights.email +
    weights.telefone +
    weights.reputacao +
    weights.cnpj +
    weights.endereco +
    weights.linkedin;
  return Math.round(total * 100) / 100;
}
