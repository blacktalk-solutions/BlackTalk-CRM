"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const MAX_SUGESTOES = 8;

/**
 * Formulário de busca de `/app/prospeccao` (T6; seletor de nicho trocando o
 * antigo campo fixo em T14; nicho virando OPCIONAL com autocomplete em 0239;
 * cadastro de nicho REMOVIDO — casamento por nome do que se digita, sem
 * tela própria — na sessão seguinte, achado validando em produção).
 *
 * "Tipo de negócio" é o próprio campo de nicho: `nichoCasado` é DERIVADO do
 * texto digitado (casamento exato, sem acento/maiúscula) contra os nichos já
 * salvos — funciona tanto escolhendo uma sugestão do autocomplete quanto só
 * digitando o nome igual, sem tocar no dropdown (achado pedido: "mesmo assim
 * o usuário não clicar no autocomplete e já existir, o sistema avisa"). Não
 * há mais tela de cadastro: um nicho só nasce pelo botão "Salvar como nicho"
 * na tela de resultados (`ProspectingResultsHeader`), com pesos padrão fixos
 * — nada aqui pergunta peso/requisito, e não vai perguntar: a Fase 2 (PRD do
 * diagnóstico completo) deve substituir esse sistema de pesos por algo que
 * avalia todo sinal pra qualquer resultado, então não vale investir em mais
 * UI de configuração numa peça com prazo de validade.
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
  const [sugestoesAbertas, setSugestoesAbertas] = useState(false);
  // Some quando o texto muda de novo — reescrever quebra o casamento
  // automático de propósito, então "ignorar" não precisa sobreviver a isso.
  const [nichoIgnorado, setNichoIgnorado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setNichoIgnorado(false);
  }, [businessType]);

  const normalizado = (s: string) => s.trim().toLowerCase();

  const nichoCasado = useMemo(() => {
    const alvo = normalizado(businessType);
    if (!alvo) return null;
    return niches.find((n) => normalizado(n.name) === alvo) ?? null;
  }, [businessType, niches]);

  const nichoAplicado = nichoIgnorado ? null : nichoCasado;

  const sugestoes = useMemo(() => {
    const termo = normalizado(businessType);
    if (!termo) return [];
    return niches.filter((n) => normalizado(n.name).includes(termo)).slice(0, MAX_SUGESTOES);
  }, [businessType, niches]);

  function escolherNicho(niche: NicheDTO) {
    setBusinessType(niche.name);
    setNichoIgnorado(false);
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
          ...(nichoAplicado ? { nicheId: nichoAplicado.id } : {}),
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
                onChange={(e) => setBusinessType(e.target.value)}
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
              {nichoCasado ? (
                <p className="text-xs text-muted-foreground" data-testid="prospeccao-nicho-casado">
                  {nichoAplicado ? (
                    <>
                      {t("Usando critérios de")} <strong>{nichoCasado.name}</strong>.{" "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => setNichoIgnorado(true)}
                      >
                        {t("Buscar sem eles")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setNichoIgnorado(false)}
                    >
                      {t("Usar critérios de")} {nichoCasado.name}
                    </button>
                  )}
                </p>
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
