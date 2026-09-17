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

export const prospectingSearchSchema = z.object({
  businessType: z.string().min(1, "businessType é obrigatório"),
  location: z.string().min(1, "location é obrigatório"),
  serviceType: z.literal("venda_de_site"),
});
export type ProspectingSearchInput = z.infer<typeof prospectingSearchSchema>;
