"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { PencilSimple } from "@/lib/ui/icons";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";

interface Props {
  niches: NicheDTO[];
  onEdit: (niche: NicheDTO) => void;
}

/**
 * Lista de nichos da organização — T13
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`). Sem "apagar" de
 * propósito (design.md, "Tech Decisions": nicho não tem exclusão nesta v1,
 * só criar/editar — apagar fica pra quando houver necessidade real, e um
 * nicho com buscas vinculadas nem poderia por causa da FK sem cascade de
 * `prospected_searches.niche_id`).
 */
export function NicheList({ niches, onEdit }: Props) {
  const t = useT();

  if (niches.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-1 p-10 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("Nenhum nicho cadastrado ainda.")}</p>
        <p>{t("Crie o primeiro nicho para poder buscar na Prospecção.")}</p>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="niche-list">
      {niches.map((niche) => {
        const weights = niche.weights as Record<string, number>;
        return (
          <li key={niche.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{niche.name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {niche.searchTerms.slice(0, 3).map((termo) => (
                    <Badge key={termo} variant="neutral">
                      {termo}
                    </Badge>
                  ))}
                  {niche.searchTerms.length > 3 ? (
                    <Badge variant="neutral">+{niche.searchTerms.length - 3}</Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {t("site")} {weights.site ?? 0} · {t("instagram")} {weights.instagram ?? 0} · {t("whatsapp")}{" "}
                  {weights.whatsapp ?? 0}
                </span>
                <Button variant="ghost" size="sm" onClick={() => onEdit(niche)} className="gap-1">
                  <PencilSimple size={14} aria-hidden />
                  {t("Editar")}
                </Button>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
