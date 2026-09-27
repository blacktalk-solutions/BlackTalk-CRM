"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { PESOS_PADRAO } from "@/lib/prospecting/score";
import { CheckCircle } from "@/lib/ui/icons";

interface Props {
  businessType: string;
  /** `null` = busca ad-hoc (sem nicho vinculado). */
  nicheId: string | null;
  /** Nome do nicho vinculado — resolvido no servidor (page.tsx), só pra exibir. */
  nicheName: string | null;
}

/**
 * Aviso não-bloqueante na tela de resultados (não um popup ANTES de
 * buscar — a doutrina rejeitada em conversa: interromper toda busca nova
 * pra perguntar cansa rápido). Dois estados, mutuamente exclusivos:
 *
 *  - `nicheId` presente: só informa que a busca já usou os critérios de um
 *    nicho salvo (casamento por nome exato, `ProspectingSearchForm`).
 *  - `nicheId` ausente: oferece salvar o termo digitado como nicho novo,
 *    com pesos padrão fixos — sem miniformulário de peso/requisito
 *    (decisão da sessão: a Fase 2, diagnóstico completo, deve substituir
 *    esse sistema de pesos por algo que avalia todo sinal pra qualquer
 *    resultado, então não vale configurar mais nada numa peça com prazo
 *    de validade).
 */
export function SalvarComoNichoBanner({ businessType, nicheId, nicheName }: Props) {
  const t = useT();
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (nicheId) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="prospeccao-nicho-usado">
        {t("Usando critérios de")} <strong>{nicheName ?? businessType}</strong>.
      </p>
    );
  }

  if (salvo) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="prospeccao-nicho-salvo">
        <CheckCircle size={16} className="text-success-fg" aria-hidden />
        {t("Nicho salvo — próxima busca por")} "{businessType}" {t("já vai sugerir ele.")}
      </p>
    );
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const res = await fetch("/api/v1/prospecting/niches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: businessType,
          searchTerms: [businessType],
          weights: PESOS_PADRAO,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        setErro(json.error?.message ?? t("Não foi possível salvar o nicho."));
        return;
      }
      setSalvo(true);
    } catch {
      setErro(t("Não foi possível salvar o nicho."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm" data-testid="prospeccao-salvar-nicho">
      <Button variant="outline" size="sm" onClick={salvar} disabled={salvando}>
        {salvando ? t("Salvando…") : `${t("Salvar")} "${businessType}" ${t("como nicho")}`}
      </Button>
      {erro ? <span className="text-xs text-destructive">{erro}</span> : null}
    </div>
  );
}
