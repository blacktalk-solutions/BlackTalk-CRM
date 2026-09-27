"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

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
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import type { ProspectedPlaceDTO } from "@/app/api/v1/prospecting/searches/route";
import type { StatusLabel } from "@/lib/prospecting/score";
import { paginateResults, totalResultPages } from "@/lib/prospecting/pagination";
import { ArrowSquareOut, Warning, ArrowRight } from "@/lib/ui/icons";
import { buildWhatsAppLink, buildCsvContent } from "@/lib/prospecting/contact-utils";

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

/**
 * Aplica um update de linha chegado do Realtime ao estado local da tabela.
 *
 * Função pura: recebe o estado atual, o update do servidor (com os campos que
 * mudaram), e devolve o novo estado. Substitui só a linha certa por `id`,
 * preserva ordem e demais linhas, e ignora silenciosamente updates de linhas
 * que não estão mais na lista (pode acontecer se o usuário mudou de página ou
 * se a linha foi deletada enquanto a atualização estava em voo).
 */
export function applyPlaceUpdate(
  currentPlaces: ProspectedPlaceDTO[],
  updatedData: Record<string, unknown>,
): ProspectedPlaceDTO[] {
  const placeId = updatedData.id as string | undefined;
  if (!placeId) return currentPlaces;

  const index = currentPlaces.findIndex((p) => p.id === placeId);
  if (index === -1) return currentPlaces; // linha não está na lista, ignora

  // Mapeia os campos snake_case do banco para camelCase do DTO
  const fieldMap: Record<string, keyof ProspectedPlaceDTO> = {
    score_final: "scoreFinal",
    status_label: "statusLabel",
    site_analysis_status: "siteAnalysisStatus",
    site_analysis_result: "siteAnalysisResult",
    email: "email",
    promoted_lead_id: "promotedLeadId",
  };

  const newPlaces = [...currentPlaces];
  const updated: Partial<ProspectedPlaceDTO> = {};

  for (const [dbKey, dtoKey] of Object.entries(fieldMap)) {
    if (dbKey in updatedData) {
      updated[dtoKey] = updatedData[dbKey] as never;
    }
  }

  // Cria uma cópia mesclada da linha (preserve existing fields)
  // A spread preserva os campos não atualizados, então o resultado é sempre um DTO válido
  newPlaces[index] = { ...currentPlaces[index], ...updated } as ProspectedPlaceDTO;
  return newPlaces;
}

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
 * Realtime (T9): assina `prospected_places` filtrado por `search_id` e
 * atualiza cada linha localmente quando o worker de análise de site termina,
 * sem reload. Indicador "Analisando..." mostra para linhas em estado
 * pending/processing.
 */
export function ProspectingResultsTable({ searchId, initialPlaces, placesApiCapped }: Props) {
  const t = useT();
  const [page, setPage] = useState(1);
  const [places, setPlaces] = useState<ProspectedPlaceDTO[]>(initialPlaces);
  // T14 (`.specs/features/prospeccao-nichos-e-enriquecimento/`): esconde por
  // padrão quem reprovou nos requisitos do nicho — mesmo espírito do painel
  // do `prospeccao-kit-aluno` (`listar --oportunidade` só mostra quem passou).
  // "Reprovado nos requisitos" é DISTINTO de "nota baixa" (`requisitosOk`
  // separado de `statusLabel`) — por isso é um filtro à parte, não um valor
  // a mais de status.
  const [mostrarReprovados, setMostrarReprovados] = useState(false);
  const [reanalyzeLoadingIds, setReanalyzeLoadingIds] = useState<Set<string>>(new Set());
  const [reanalyzeErrorMap, setReanalyzeErrorMap] = useState<Map<string, string>>(new Map());
  const [promoteLoadingIds, setPromoteLoadingIds] = useState<Set<string>>(new Set());
  const [promoteErrorMap, setPromoteErrorMap] = useState<Map<string, string>>(new Map());

  // Realtime: escuta updates na tabela prospected_places
  const handleRealtimeChange = useCallback(
    (payload: unknown) => {
      // O Realtime entrega um objeto com `new` (valores atualizados)
      const data = (payload as Record<string, unknown> | undefined)?.new;
      if (data && typeof data === "object") {
        setPlaces((current) => applyPlaceUpdate(current, data as Record<string, unknown>));
      }
    },
    [],
  );

  const handleExportCsv = useCallback(() => {
    const csvContent = buildCsvContent(places);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `prospeccao-${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [places]);

  const handleReanalyze = useCallback(
    async (placeId: string) => {
      setReanalyzeLoadingIds((prev) => new Set(prev).add(placeId));
      setReanalyzeErrorMap((prev) => {
        const next = new Map(prev);
        next.delete(placeId);
        return next;
      });

      try {
        const response = await fetch(`/api/v1/prospecting/places/${placeId}/reanalyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errorData = (await response.json()) as { error?: { message?: string } };
          const errorMessage = errorData.error?.message || t("Erro ao tentar novamente.");
          setReanalyzeErrorMap((prev) => new Map(prev).set(placeId, errorMessage));
          console.error(`Reanalyze failed for ${placeId}:`, errorMessage);
        }
        // On success, the Realtime subscription will update the place automatically
      } catch (err) {
        setReanalyzeErrorMap((prev) => new Map(prev).set(placeId, t("Erro de conexão")));
        console.error(`Reanalyze error for ${placeId}:`, err);
      } finally {
        setReanalyzeLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(placeId);
          return next;
        });
      }
    },
    [t],
  );

  const handlePromote = useCallback(
    async (placeId: string) => {
      setPromoteLoadingIds((prev) => new Set(prev).add(placeId));
      setPromoteErrorMap((prev) => {
        const next = new Map(prev);
        next.delete(placeId);
        return next;
      });

      try {
        const response = await fetch(`/api/v1/prospecting/places/${placeId}/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errorData = (await response.json()) as { error?: { message?: string } };
          const errorMessage = errorData.error?.message || t("Erro ao promover resultado.");
          setPromoteErrorMap((prev) => new Map(prev).set(placeId, errorMessage));
          console.error(`Promote failed for ${placeId}:`, errorMessage);
          return;
        }

        // On success, update local state with the leadId
        const successData = (await response.json()) as { data?: { leadId?: string } };
        const leadId = successData.data?.leadId;
        if (leadId) {
          setPlaces((current) =>
            current.map((place) =>
              place.id === placeId ? { ...place, promotedLeadId: leadId } : place,
            ),
          );
        }
      } catch (err) {
        setPromoteErrorMap((prev) => new Map(prev).set(placeId, t("Erro de conexão")));
        console.error(`Promote error for ${placeId}:`, err);
      } finally {
        setPromoteLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(placeId);
          return next;
        });
      }
    },
    [t],
  );

  useRealtimeChannel({
    name: `prospecting-results-${searchId}`,
    postgresChanges: {
      event: "UPDATE",
      schema: "public",
      table: "prospected_places",
      filter: `search_id=eq.${searchId}`,
    },
    onChange: handleRealtimeChange,
    enabled: !!searchId,
  });

  const reprovadosCount = places.filter((p) => !p.requisitosOk).length;
  const placesFiltrados = mostrarReprovados ? places : places.filter((p) => p.requisitosOk);
  const total = totalResultPages(placesFiltrados.length);
  const linhasDaPagina = paginateResults(placesFiltrados, page);

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

      {places.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCsv}>
            {t("Exportar CSV")}
          </Button>
          {reprovadosCount > 0 ? (
            <Button
              variant={mostrarReprovados ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setMostrarReprovados((v) => !v);
                setPage(1);
              }}
              data-testid="prospeccao-toggle-reprovados"
            >
              {mostrarReprovados
                ? t("Ocultar reprovados nos requisitos")
                : `${t("Mostrar reprovados nos requisitos")} (${reprovadosCount})`}
            </Button>
          ) : null}
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
            {places.length === 0 ? (
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
            ) : placesFiltrados.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <div className="flex flex-col items-center gap-1 py-10 text-sm text-muted-foreground">
                    <p className="font-medium">
                      {t("Todos os resultados desta busca reprovaram nos requisitos do nicho.")}
                    </p>
                    <Button variant="link" size="sm" onClick={() => setMostrarReprovados(true)}>
                      {t("Mostrar mesmo assim")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              linhasDaPagina.map((place) => {
                const meta = STATUS_META[place.statusLabel as StatusLabel] ?? STATUS_META.baixa;
                const score = place.scoreFinal ?? place.scoreInitial;
                const whatsappLink = buildWhatsAppLink(place.phoneNumber, place.name);
                const errorMessage = reanalyzeErrorMap.get(place.id);
                return (
                  <TableRow key={place.id} data-testid="prospeccao-linha">
                    <TableCell className="max-w-[220px] font-medium">
                      <div className="flex items-center gap-1.5">
                        {/* T15: porta de saída pra ficha por empresa — URL própria, compartilhável. */}
                        <Link
                          href={`/app/prospeccao/${searchId}/${place.id}`}
                          className="truncate underline-offset-2 hover:underline"
                          data-testid="prospeccao-link-ficha"
                        >
                          {place.name}
                        </Link>
                        {!place.requisitosOk ? (
                          <Badge
                            variant="neutral"
                            title={place.motivoRequisitos ?? undefined}
                            data-testid="prospeccao-fora-do-perfil"
                          >
                            {t("Fora do perfil")}
                          </Badge>
                        ) : null}
                      </div>
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
                    <TableCell className="tabular-nums font-medium">
                      {place.siteAnalysisStatus === "pending" ||
                      place.siteAnalysisStatus === "processing" ? (
                        <span className="text-text-muted text-sm">{t("Analisando...")}</span>
                      ) : (
                        score
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{t(meta.label)}</Badge>
                    </TableCell>
                    <TableCell className="flex flex-col gap-1">
                      <div className="flex gap-2">
                        {/* WhatsApp button */}
                        {whatsappLink ? (
                          <a
                            href={whatsappLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent underline underline-offset-2 hover:bg-accent/10"
                            title={t("Enviar mensagem no WhatsApp")}
                          >
                            {t("WhatsApp")}
                          </a>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground opacity-50"
                            title={t("Telefone não disponível")}
                          >
                            {t("WhatsApp")}
                          </span>
                        )}

                        {/* Promote button or link to lead */}
                        {place.promotedLeadId ? (
                          <a
                            href={`/app/leads/${place.promotedLeadId}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-success-fg bg-success-bg/30 hover:bg-success-bg/50 transition-colors"
                            title={t("Ver lead no funil")}
                          >
                            {t("No funil")}
                            <ArrowRight size={12} aria-hidden />
                          </a>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePromote(place.id)}
                            disabled={promoteLoadingIds.has(place.id)}
                            title={t("Promover para o funil")}
                            className="text-xs"
                          >
                            {promoteLoadingIds.has(place.id) ? (
                              <>
                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                {t("Promovendo...")}
                              </>
                            ) : (
                              t("Promover")
                            )}
                          </Button>
                        )}

                        {/* Reanalyze button */}
                        {place.siteAnalysisStatus === "failed" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleReanalyze(place.id)}
                            disabled={reanalyzeLoadingIds.has(place.id)}
                            title={t("Tentar analisar novamente")}
                            className="text-xs"
                          >
                            {reanalyzeLoadingIds.has(place.id) ? (
                              <>
                                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                {t("Tentando...")}
                              </>
                            ) : (
                              t("Tentar de novo")
                            )}
                          </Button>
                        ) : null}
                      </div>

                      {/* Error messages */}
                      {errorMessage ? (
                        <span className="text-xs text-warning-fg">{errorMessage}</span>
                      ) : null}
                      {promoteErrorMap.get(place.id) ? (
                        <span className="text-xs text-warning-fg">{promoteErrorMap.get(place.id)}</span>
                      ) : null}
                    </TableCell>
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
