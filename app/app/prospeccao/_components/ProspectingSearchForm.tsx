"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { CircleNotch, MagnifyingGlass } from "@/lib/ui/icons";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";

interface SearchApiSuccess {
  data: { searchId: string; places: unknown[] };
}
interface SearchApiError {
  error: { code: string; message: string };
}

interface Props {
  /** Da organização ativa, vindo do Server Component pai (`page.tsx`). */
  niches: NicheDTO[];
}

/**
 * Formulário de busca de `/app/prospeccao` (T6, `.specs/features/prospeccao-google-maps/`;
 * seletor de nicho trocando o antigo campo fixo em T14,
 * `.specs/features/prospeccao-nichos-e-enriquecimento/`).
 *
 * Três campos: tipo de negócio e localidade (texto livre), e o NICHO — que
 * substitui o antigo select decorativo de "tipo de serviço" (sempre
 * `venda_de_site`, T6). Sem nenhum nicho cadastrado na organização, o
 * formulário orienta a criar um em `/app/prospeccao/nichos` e desabilita a
 * busca inteira — spec.md, P1, critério 6 ("a tela de busca SHALL orientar a
 * criar um primeiro, SHALL impedir buscar sem nicho escolhido").
 *
 * Ao submeter, chama `POST /api/v1/prospecting/searches` e navega pro
 * detalhe da busca — `app/app/prospeccao/[searchId]/page.tsx` é quem
 * renderiza os resultados, então este componente não guarda a lista em
 * estado nenhum.
 *
 * Erro de API não trava a tela: fica visível e o formulário continua
 * preenchido, pronto pra tentar de novo (padrão de erro inline de
 * `app/app/kanban/_components/ImportarLeads.tsx`).
 */
export function ProspectingSearchForm({ niches }: Props) {
  const t = useT();
  const router = useRouter();
  const [businessType, setBusinessType] = useState("");
  const [location, setLocation] = useState("");
  const [nicheId, setNicheId] = useState<string>(niches[0]?.id ?? "");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const semNicho = niches.length === 0;

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    if (!businessType.trim() || !location.trim() || !nicheId || enviando) return;

    setEnviando(true);
    setErro(null);
    try {
      const res = await fetch("/api/v1/prospecting/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessType: businessType.trim(),
          location: location.trim(),
          nicheId,
        }),
      });
      const json = (await res.json()) as SearchApiSuccess | SearchApiError;
      if (!res.ok || !("data" in json)) {
        setErro(
          ("error" in json ? json.error?.message : undefined) ??
            t("Não foi possível concluir a busca."),
        );
        return;
      }
      router.push(`/app/prospeccao/${json.data.searchId}`);
    } catch {
      setErro(t("Não foi possível concluir a busca."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        {semNicho ? (
          <div
            className="mb-4 flex flex-col items-start gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm"
            data-testid="prospeccao-sem-nicho"
          >
            <p className="font-medium">{t("Você ainda não tem nenhum nicho de prospecção cadastrado.")}</p>
            <p className="text-muted-foreground">
              {t("Um nicho define os termos de busca, os requisitos e os pesos que decidem se um resultado é um bom lead. Crie o primeiro para poder buscar.")}
            </p>
            <Button asChild size="sm">
              <Link href="/app/prospeccao/nichos">{t("Criar meu primeiro nicho")}</Link>
            </Button>
          </div>
        ) : null}

        <form onSubmit={buscar} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospeccao-tipo-negocio">{t("Tipo de negócio")}</Label>
              <Input
                id="prospeccao-tipo-negocio"
                value={businessType}
                onChange={(e) => setBusinessType(e.target.value)}
                placeholder={t("Ex.: clínica odontológica, pizzaria, barbearia…")}
                required
                disabled={enviando || semNicho}
                data-testid="prospeccao-tipo-negocio"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospeccao-localidade">{t("Localidade")}</Label>
              <Input
                id="prospeccao-localidade"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t("Ex.: Curitiba, PR")}
                required
                disabled={enviando || semNicho}
                data-testid="prospeccao-localidade"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospeccao-nicho">{t("Nicho")}</Label>
              <Select value={nicheId} onValueChange={setNicheId} disabled={enviando || semNicho}>
                <SelectTrigger id="prospeccao-nicho" data-testid="prospeccao-nicho">
                  <SelectValue placeholder={t("Escolha um nicho")} />
                </SelectTrigger>
                <SelectContent>
                  {niches.map((niche) => (
                    <SelectItem key={niche.id} value={niche.id}>
                      {niche.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {erro ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive"
              data-testid="prospeccao-erro"
            >
              {erro}
            </p>
          ) : null}

          <div>
            <Button
              type="submit"
              disabled={enviando || semNicho || !businessType.trim() || !location.trim() || !nicheId}
              className="gap-2"
              data-testid="prospeccao-buscar"
            >
              {enviando ? (
                <CircleNotch size={16} className="animate-spin" aria-hidden />
              ) : (
                <MagnifyingGlass size={16} aria-hidden />
              )}
              {enviando ? t("Buscando…") : t("Buscar")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
