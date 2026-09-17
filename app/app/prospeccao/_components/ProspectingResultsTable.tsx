"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import type { ProspectedPlaceDTO } from "@/app/api/v1/prospecting/searches/route";
import type { StatusLabel } from "@/lib/prospecting/score";
import { paginateResults, totalResultPages } from "@/lib/prospecting/pagination";
import { ArrowSquareOut, Warning } from "@/lib/ui/icons";

/**
 * Rótulo + variante de badge por faixa de score (`StatusLabel` de
 * `lib/prospecting/score.ts`: "quente" | "oportunidade" | "baixa").
 *
 * Mesmo padrão de `Record<Status, {label, variant}>` + `<Badge
 * variant={variant}>` já usado em `components/ai/SourceStatusBadge.tsx` e em
 * `app/app/radar/_components/RiskRadarList.tsx` (RISK_META) — não inventa
 * cor nova. "quente" = melhor prospect (mais provável de converter) → verde;
 * "baixa" = prioridade baixa → neutro, o mesmo par usado pra "arquivado"/"não
 * preparado" em SourceStatusBadge.
 */
const STATUS_META: Record<StatusLabel, { label: string; variant: "success" | "warning" | "neutral" }> = {
  quente: { label: "Quente", variant: "success" },
  oportunidade: { label: "Oportunidade", variant: "warning" },
  baixa: { label: "Baixa", variant: "neutral" },
};

interface Props {
  /**
   * Não lido AINDA nesta task — faz parte do contrato porque T9 (Realtime,
   * filtro por `search_id`) e as ações de T7/T8 (promover, WhatsApp) vão
   * precisar dele no mesmo componente. Aceitar agora evita replumbar a
   * cadeia de props quando essas tasks chegarem.
   */
  searchId: string;
  initialPlaces: ProspectedPlaceDTO[];
  placesApiCapped: boolean;
}

/**
 * Tabela de resultados de `/app/prospeccao/[searchId]` (T6).
 *
 * Os dados JÁ vieram todos do Server Component pai (`initialPlaces`, até 60
 * linhas — PROSPECT-01) — este componente só pagina em memória (15/15,
 * PROSPECT-04) e nunca refaz requisição entre páginas. A lógica de paginação
 * mora em `lib/prospecting/pagination.ts`, pura e testada isolada.
 *
 * Realtime (assinatura em `prospected_places` pra refletir o score final
 * assim que o worker de análise de site termina) é T9, task futura que
 * ESTENDE este componente — fora de escopo aqui (ver design.md, "T9: Realtime
 * na tabela de resultados"). Ações de WhatsApp/exportar/promover/analisar
 * site também são tasks futuras — a coluna "Ações" é só um placeholder.
 */
export function ProspectingResultsTable({ initialPlaces, placesApiCapped }: Props) {
  const t = useT();
  const [page, setPage] = useState(1);

  const total = totalResultPages(initialPlaces.length);
  const linhasDaPagina = paginateResults(initialPlaces, page);

  return (
    <div className="flex flex-col gap-4">
      {placesApiCapped ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg/40 p-3 text-sm"
          data-testid="prospeccao-teto-atingido"
        >
          <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <p>
            {t(
              "Esta busca já traz o máximo de 60 resultados que a Google Places API permite por consulta. Para encontrar mais negócios, refine a busca — por bairro ou por um tipo mais específico de negócio — e busque de novo.",
            )}
          </p>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Empresa")}</TableHead>
              <TableHead>{t("Endereço")}</TableHead>
              <TableHead>{t("Telefone")}</TableHead>
              <TableHead>{t("Site")}</TableHead>
              <TableHead>{t("Rating")}</TableHead>
              <TableHead>{t("Score")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead className="w-[80px]">{t("Ações")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialPlaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="flex flex-col items-center gap-1 py-10 text-sm text-muted-foreground">
                    <p className="font-medium">{t("Nenhum resultado para esta busca.")}</p>
                    <p className="text-xs">
                      {t("Tente um tipo de negócio ou uma localidade diferente.")}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              linhasDaPagina.map((place) => {
                const meta = STATUS_META[place.statusLabel as StatusLabel] ?? STATUS_META.baixa;
                const score = place.scoreFinal ?? place.scoreInitial;
                return (
                  <TableRow key={place.id} data-testid="prospeccao-linha">
                    <TableCell className="max-w-[220px] truncate font-medium">
                      {place.name}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-muted-foreground">
                      {place.address ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {place.phoneNumber ?? "—"}
                    </TableCell>
                    <TableCell>
                      {place.websiteUrl ? (
                        <a
                          href={place.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
                        >
                          <ArrowSquareOut size={13} aria-hidden />
                          {t("Site")}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{t("Sem site")}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {place.rating != null ? place.rating.toFixed(1) : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums font-medium">{score}</TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{t(meta.label)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">—</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {total > 1 ? (
        <div className="flex items-center justify-between text-sm" data-testid="prospeccao-paginacao">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("Anterior")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Página")} {page}/{total}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= total}
            onClick={() => setPage((p) => Math.min(total, p + 1))}
          >
            {t("Próxima")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
