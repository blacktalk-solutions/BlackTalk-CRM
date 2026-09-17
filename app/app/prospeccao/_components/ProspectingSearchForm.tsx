"use client";

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

interface SearchApiSuccess {
  data: { searchId: string; places: unknown[] };
}
interface SearchApiError {
  error: { code: string; message: string };
}

/**
 * Formulário de busca de `/app/prospeccao` (T6).
 *
 * Três campos: tipo de negócio e localidade (texto livre), tipo de serviço
 * (select com um único valor decorativo — v1 só prospecta para "venda de
 * site", `prospectingSearchSchema` em `lib/schemas/prospecting.ts` fecha o
 * vocabulário no servidor). Ao submeter, chama
 * `POST /api/v1/prospecting/searches` e navega pro detalhe da busca —
 * `app/app/prospeccao/[searchId]/page.tsx` é quem renderiza os resultados,
 * então este componente não guarda a lista em estado nenhum.
 *
 * Erro de API não trava a tela: fica visível e o formulário continua
 * preenchido, pronto pra tentar de novo (padrão de erro inline de
 * `app/app/kanban/_components/ImportarLeads.tsx`).
 */
export function ProspectingSearchForm() {
  const t = useT();
  const router = useRouter();
  const [businessType, setBusinessType] = useState("");
  const [location, setLocation] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    if (!businessType.trim() || !location.trim() || enviando) return;

    setEnviando(true);
    setErro(null);
    try {
      const res = await fetch("/api/v1/prospecting/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessType: businessType.trim(),
          location: location.trim(),
          serviceType: "venda_de_site",
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
                disabled={enviando}
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
                disabled={enviando}
                data-testid="prospeccao-localidade"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospeccao-tipo-servico">{t("Tipo de serviço")}</Label>
              {/* Único valor disponível em v1 — decorativo, sempre
                  "venda_de_site" (mesmo valor que o schema do servidor
                  aceita). Desabilitado de propósito: não é escolha real
                  ainda, é onde a escolha vai morar quando houver mais de um
                  serviço prospectável. */}
              <Select value="venda_de_site" disabled>
                <SelectTrigger id="prospeccao-tipo-servico">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="venda_de_site">{t("Venda de site")}</SelectItem>
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
              disabled={enviando || !businessType.trim() || !location.trim()}
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
