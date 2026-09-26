"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { Plus } from "@/lib/ui/icons";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";
import { NicheList } from "./NicheList";
import { NicheWizard } from "./NicheWizard";

interface Props {
  initialNiches: NicheDTO[];
  apifyTokenConfigured: boolean;
}

type Vista = { tipo: "lista" } | { tipo: "form"; niche: NicheDTO | null };

/**
 * Orquestra lista ↔ formulário guiado em `/app/prospeccao/nichos` (T13).
 * Uma página só, sem rota própria pro wizard — mesmo espírito de manter o
 * fluxo de criação/edição perto da lista (`app/admin/(protected)/tenants/new`
 * é o precedente de wizard com rota própria; aqui não há necessidade de link
 * direto pro wizard, então uma página é suficiente).
 */
export function NichosManager({ initialNiches, apifyTokenConfigured }: Props) {
  const t = useT();
  const [niches, setNiches] = useState<NicheDTO[]>(initialNiches);
  const [vista, setVista] = useState<Vista>({ tipo: "lista" });

  function onSaved(niche: NicheDTO) {
    setNiches((atual) => {
      const existe = atual.some((n) => n.id === niche.id);
      return existe ? atual.map((n) => (n.id === niche.id ? niche : n)) : [niche, ...atual];
    });
    setVista({ tipo: "lista" });
  }

  if (vista.tipo === "form") {
    return (
      <NicheWizard
        niche={vista.niche}
        apifyTokenConfigured={apifyTokenConfigured}
        onSaved={onSaved}
        onCancel={() => setVista({ tipo: "lista" })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setVista({ tipo: "form", niche: null })} className="gap-2" data-testid="niche-novo">
          <Plus size={16} aria-hidden />
          {t("Novo nicho")}
        </Button>
      </div>
      <NicheList niches={niches} onEdit={(niche) => setVista({ tipo: "form", niche })} />
    </div>
  );
}
