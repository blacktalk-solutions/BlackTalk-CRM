"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { CircleNotch, MagnifyingGlass, X } from "@/lib/ui/icons";
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

const MAX_SUGESTOES = 8;

/**
 * Formulário de busca de `/app/prospeccao` (T6, `.specs/features/prospeccao-google-maps/`;
 * seletor de nicho trocando o antigo campo fixo em T14; nicho virando
 * OPCIONAL com autocomplete em 0239).
 *
 * Achado validando em produção: exigir escolher um nicho pré-cadastrado
 * travava a busca inteira sem nenhum criado ainda — um wizard de 4 passos
 * ANTES da primeira busca. `nicheId` é opcional desde a rota (0239): "Tipo
 * de negócio" é o próprio campo de autocomplete — digitar sugere nichos
 * salvos (por nome), escolher um vincula `nicheId` (pesos/requisitos daquele
 * nicho passam a valer); só digitar e buscar, sem escolher nada, funciona
 * igual — a busca usa `PESOS_PADRAO` e nenhum requisito elimina resultado.
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
  const [nicheId, setNicheId] = useState<string>("");
  const [sugestoesAbertas, setSugestoesAbertas] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const nichoSelecionado = niches.find((n) => n.id === nicheId) ?? null;

  const sugestoes = useMemo(() => {
    const termo = businessType.trim().toLowerCase();
    if (!termo) return [];
    return niches.filter((n) => n.name.toLowerCase().includes(termo)).slice(0, MAX_SUGESTOES);
  }, [businessType, niches]);

  function escolherNicho(niche: NicheDTO) {
    setBusinessType(niche.name);
    setNicheId(niche.id);
    setSugestoesAbertas(false);
  }

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
          ...(nicheId ? { nicheId } : {}),
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="relative flex flex-col gap-1.5">
              <Label htmlFor="prospeccao-tipo-negocio">{t("Tipo de negócio")}</Label>
              <Input
                id="prospeccao-tipo-negocio"
                value={businessType}
                onChange={(e) => {
                  setBusinessType(e.target.value);
                  // Editar o texto depois de escolher um nicho desvincula —
                  // o texto não bate mais com o nome salvo, então os
                  // pesos/requisitos daquele nicho não deveriam mais valer.
                  if (nicheId) setNicheId("");
                  setSugestoesAbertas(true);
                }}
                onFocus={() => setSugestoesAbertas(true)}
                onBlur={() => setSugestoesAbertas(false)}
                placeholder={t("Ex.: clínica odontológica, pizzaria, barbearia…")}
                required
                disabled={enviando}
                autoComplete="off"
                data-testid="prospeccao-tipo-negocio"
              />
              {sugestoesAbertas && sugestoes.length > 0 ? (
                <ul
                  className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md"
                  data-testid="prospeccao-nicho-sugestoes"
                >
                  {sugestoes.map((niche) => (
                    <li key={niche.id}>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        // onMouseDown (não onClick): dispara ANTES do onBlur
                        // do input, senão a lista fecha antes do clique registrar.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          escolherNicho(niche);
                        }}
                        data-testid={`prospeccao-nicho-sugestao-${niche.id}`}
                      >
                        {niche.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {nichoSelecionado ? (
                <Badge variant="secondary" className="w-fit gap-1">
                  {t("Usando nicho")}: {nichoSelecionado.name}
                  <button
                    type="button"
                    aria-label={t("Remover nicho")}
                    onClick={() => setNicheId("")}
                    className="ml-1"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </Badge>
              ) : null}
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
