"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { Warning } from "@/lib/ui/icons";
import { prospectingNicheCreateSchema, type ProspectingNicheCreateInput } from "@/lib/schemas/prospecting";
import type { NicheDTO } from "@/app/api/v1/prospecting/niches/route";

/**
 * Pesos sugeridos — mesmo `PESOS_PADRAO` do `prospeccao-kit-aluno`
 * (`lib/score.mjs`), validado por semanas de uso real antes desta feature
 * (design.md, "Tech Decisions"). Soma 100.
 */
const PESOS_SUGERIDOS: ProspectingNicheCreateInput["weights"] = {
  site: 25,
  instagram: 15,
  email: 15,
  telefone: 10,
  whatsapp: 10,
  reputacao: 10,
  cnpj: 5,
  linkedin: 5,
  endereco: 5,
};

/** Rótulo de cada peso, na mesma ordem/nomenclatura do kit (`docs/a-regua-do-score.md`). */
const CAMPOS_DE_PESO: Array<{ key: keyof ProspectingNicheCreateInput["weights"]; label: string }> = [
  { key: "site", label: "Site no ar" },
  { key: "instagram", label: "Instagram" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "E-mail" },
  { key: "telefone", label: "Telefone" },
  { key: "reputacao", label: "Reputação no Google" },
  { key: "cnpj", label: "CNPJ" },
  { key: "endereco", label: "Endereço" },
  { key: "linkedin", label: "LinkedIn" },
];

/**
 * Schema do FORMULÁRIO — mais permissivo que `prospectingNicheCreateSchema`
 * de propósito: os campos de peso/avaliação chegam do `<input type=number>`
 * como string vazia enquanto o operador ainda não digitou nada, e
 * `z.coerce.number()` trataria `""` como `0` silenciosamente (peso "vazio"
 * viraria peso zero, escondendo que o campo nunca foi preenchido). Aqui cada
 * campo numérico aceita `string`, e a CONVERSÃO pra number (com o "vazio =
 * 0" que faz sentido pra peso) acontece só no `onSubmit`, onde já dá pra
 * mostrar msg de validação específica antes de mandar pro schema do servidor.
 */
const wizardFormSchema = z.object({
  name: z.string().min(1, "Dê um nome pro nicho."),
  serviceType: z.string().min(1, "Diga o que você vende."),
  searchTermsText: z.string().min(1, "Pelo menos um termo de busca."),
  avaliacoesMin: z.string(),
  avaliacoesMax: z.string(),
  exigeCelular: z.boolean(),
  exigeSite: z.boolean(),
  weights: z.object({
    site: z.string(),
    instagram: z.string(),
    whatsapp: z.string(),
    email: z.string(),
    telefone: z.string(),
    reputacao: z.string(),
    cnpj: z.string(),
    endereco: z.string(),
    linkedin: z.string(),
  }),
});
type WizardFormValues = z.infer<typeof wizardFormSchema>;

function nicheToFormValues(niche: NicheDTO | null): WizardFormValues {
  const weights = (niche?.weights as ProspectingNicheCreateInput["weights"] | undefined) ?? PESOS_SUGERIDOS;
  const requirements = (niche?.requirements as ProspectingNicheCreateInput["requirements"] | undefined) ?? {};
  return {
    name: niche?.name ?? "",
    serviceType: niche?.serviceType ?? "",
    searchTermsText: (niche?.searchTerms ?? []).join("\n"),
    avaliacoesMin: requirements.avaliacoesMin != null ? String(requirements.avaliacoesMin) : "",
    avaliacoesMax: requirements.avaliacoesMax != null ? String(requirements.avaliacoesMax) : "",
    exigeCelular: requirements.exigeCelular ?? false,
    exigeSite: requirements.exigeSite ?? false,
    weights: {
      site: String(weights.site),
      instagram: String(weights.instagram),
      whatsapp: String(weights.whatsapp),
      email: String(weights.email),
      telefone: String(weights.telefone),
      reputacao: String(weights.reputacao),
      cnpj: String(weights.cnpj),
      endereco: String(weights.endereco),
      linkedin: String(weights.linkedin),
    },
  };
}

/** `""` -> 0 (peso/limite não preenchido conta como "não pesa"/"sem piso"); resto vira Number. */
function numOrZero(v: string): number {
  const n = Number(v.trim());
  return v.trim() === "" || Number.isNaN(n) ? 0 : n;
}

function buildPayload(values: WizardFormValues): ProspectingNicheCreateInput {
  return {
    name: values.name.trim(),
    serviceType: values.serviceType.trim(),
    searchTerms: values.searchTermsText
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
    requirements: {
      ...(values.avaliacoesMin.trim() !== "" ? { avaliacoesMin: numOrZero(values.avaliacoesMin) } : {}),
      ...(values.avaliacoesMax.trim() !== "" ? { avaliacoesMax: numOrZero(values.avaliacoesMax) } : {}),
      exigeCelular: values.exigeCelular,
      exigeSite: values.exigeSite,
    },
    weights: {
      site: numOrZero(values.weights.site),
      instagram: numOrZero(values.weights.instagram),
      whatsapp: numOrZero(values.weights.whatsapp),
      email: numOrZero(values.weights.email),
      telefone: numOrZero(values.weights.telefone),
      reputacao: numOrZero(values.weights.reputacao),
      cnpj: numOrZero(values.weights.cnpj),
      endereco: numOrZero(values.weights.endereco),
      linkedin: numOrZero(values.weights.linkedin),
    },
  };
}

const PASSOS = ["negocio", "tamanho", "pesos", "revisao"] as const;
type Passo = (typeof PASSOS)[number];

interface Props {
  /** `null` = criação; presente = edição (pré-preenchido). */
  niche: NicheDTO | null;
  apifyTokenConfigured: boolean;
  onSaved: (niche: NicheDTO) => void;
  onCancel: () => void;
}

/**
 * Formulário guiado de nicho — T13
 * (`.specs/features/prospeccao-nichos-e-enriquecimento/`). Passo a passo,
 * mesmas perguntas de `MEU-CLIENTE-IDEAL.md` do `prospeccao-kit-aluno`
 * (reduzidas ao que este schema de fato guarda — nada de `aderencia`, fora de
 * escopo desta feature), valores padrão sugeridos, mostra o nicho resultante
 * (passo "Revisão") antes de salvar.
 */
export function NicheWizard({ niche, apifyTokenConfigured, onSaved, onCancel }: Props) {
  const t = useT();
  const [passo, setPasso] = useState<Passo>("negocio");
  const [erroServidor, setErroServidor] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    trigger,
    formState: { errors },
  } = useForm<WizardFormValues>({
    resolver: zodResolver(wizardFormSchema),
    defaultValues: nicheToFormValues(niche),
  });

  // `watch()` (não `useWatch`): `useWatch` sem `name` devolve `DeepPartial`
  // (todo campo opcional), o que forçaria fallback em toda leitura abaixo só
  // pra satisfazer o tipo — sem ganho real, já que este formulário inteiro é
  // recalculado a cada tecla mesmo (soma dos pesos, preview da revisão). O
  // aviso do React Compiler ("Compilation Skipped") é informativo: `watch()`
  // não pode ser memoizado com segurança, mas nada aqui depende de memoização.
  const valores = watch();
  const somaPesos = CAMPOS_DE_PESO.reduce((s, { key }) => s + numOrZero(valores.weights[key]), 0);
  const somaFechada = Math.abs(somaPesos - 100) < 0.01;
  const avisaInstagramSemToken =
    !apifyTokenConfigured && numOrZero(valores.weights.instagram) > 0;

  const indicePasso = PASSOS.indexOf(passo);

  async function avancar() {
    const camposDoPasso: Record<Passo, (keyof WizardFormValues)[]> = {
      negocio: ["name", "serviceType", "searchTermsText"],
      tamanho: [],
      pesos: [],
      revisao: [],
    };
    const ok = await trigger(camposDoPasso[passo]);
    if (!ok) return;
    if (passo === "pesos" && !somaFechada) return; // bloqueia o passo final, mostrando o total (abaixo)
    const proximo = PASSOS[indicePasso + 1];
    if (proximo) setPasso(proximo);
  }

  function voltar() {
    const anterior = PASSOS[indicePasso - 1];
    if (anterior) setPasso(anterior);
  }

  const onSubmit = handleSubmit(async (values) => {
    if (!somaFechada) {
      setPasso("pesos");
      return;
    }
    setErroServidor(null);
    setEnviando(true);
    try {
      const payload = buildPayload(values);
      // Validação client-side espelhando o schema do servidor — mesma
      // doutrina de `NewTenantForm` (mantém o formulário em sincronia com a
      // borda real, que é a rota).
      const parsed = prospectingNicheCreateSchema.safeParse(payload);
      if (!parsed.success) {
        setErroServidor(parsed.error.issues[0]?.message ?? t("Corpo inválido."));
        return;
      }

      const url = niche ? `/api/v1/prospecting/niches/${niche.id}` : "/api/v1/prospecting/niches";
      const method = niche ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const json = (await res.json()) as
        | { data: NicheDTO }
        | { error: { code: string; message: string; details?: { total?: number } } };
      if (!res.ok || !("data" in json)) {
        const msg = "error" in json ? json.error.message : t("Não foi possível salvar o nicho.");
        setErroServidor(msg);
        if ("error" in json && json.error.code === "weights_not_100") setPasso("pesos");
        return;
      }
      onSaved(json.data);
    } catch {
      setErroServidor(t("Erro de conexão."));
    } finally {
      setEnviando(false);
    }
  });

  const payloadPreview = buildPayload(valores);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {niche ? t("Editar nicho") : t("Novo nicho de prospecção")}
        </CardTitle>
        {niche ? (
          <p className="text-xs text-muted-foreground">
            {t("A mudança vale só para buscas futuras — o histórico já rodado não é recalculado.")}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {/* Indicador de passo */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {PASSOS.map((p, i) => (
              <span key={p} className={i === indicePasso ? "font-semibold text-foreground" : undefined}>
                {i + 1}. {t({ negocio: "Negócio", tamanho: "Tamanho", pesos: "Pesos", revisao: "Revisão" }[p])}
                {i < PASSOS.length - 1 ? " → " : ""}
              </span>
            ))}
          </div>

          {passo === "negocio" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="niche-name">{t("Nome do nicho")}</Label>
                <Input
                  id="niche-name"
                  placeholder={t("Ex.: Clínicas odontológicas")}
                  {...register("name")}
                  aria-invalid={!!errors.name}
                />
                {errors.name ? <p className="text-xs text-destructive">{t(errors.name.message ?? "")}</p> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="niche-service-type">{t("O que você vende para esse nicho")}</Label>
                <Input
                  id="niche-service-type"
                  placeholder={t("Ex.: venda de site, tráfego pago, automação com IA…")}
                  {...register("serviceType")}
                  aria-invalid={!!errors.serviceType}
                />
                {errors.serviceType ? (
                  <p className="text-xs text-destructive">{t(errors.serviceType.message ?? "")}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="niche-search-terms">{t("Como esse cliente aparece no Google Maps (um termo por linha)")}</Label>
                <Textarea
                  id="niche-search-terms"
                  rows={4}
                  placeholder={t("clínica odontológica\nconsultório dentário")}
                  {...register("searchTermsText")}
                  aria-invalid={!!errors.searchTermsText}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Seja específico — \"clínica odontológica\", não \"saúde\". Cada termo traz até 60 empresas por busca.")}
                </p>
                {errors.searchTermsText ? (
                  <p className="text-xs text-destructive">{t(errors.searchTermsText.message ?? "")}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {passo === "tamanho" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t("O melhor lead costuma ser o do meio: já existe no digital, mas o marketing ainda não funciona.")}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="niche-aval-min">{t("Mínimo de avaliações no Google")}</Label>
                  <Input id="niche-aval-min" type="number" min={0} placeholder={t("Ex.: 16")} {...register("avaliacoesMin")} />
                  <p className="text-xs text-muted-foreground">{t("Abaixo disso a empresa é pequena demais para pagar por você. Deixe vazio para não exigir.")}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="niche-aval-max">{t("Máximo de avaliações no Google")}</Label>
                  <Input id="niche-aval-max" type="number" min={0} placeholder={t("Ex.: 350")} {...register("avaliacoesMax")} />
                  <p className="text-xs text-muted-foreground">{t("Acima disso ela já tem agência/marketing próprio. Deixe vazio para não exigir.")}</p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{t("Exige celular")}</p>
                  <p className="text-xs text-muted-foreground">{t("Você aborda por ligação ou WhatsApp? Sem celular no Maps nem no site, a linha é reprovada.")}</p>
                </div>
                <Switch checked={valores.exigeCelular} onCheckedChange={(v) => setValue("exigeCelular", v)} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{t("Exige site")}</p>
                  <p className="text-xs text-muted-foreground">{t("Marque só se você atende exclusivamente quem já tem site — deixe desligado se \"sem site\" é justamente a sua venda.")}</p>
                </div>
                <Switch checked={valores.exigeSite} onCheckedChange={(v) => setValue("exigeSite", v)} />
              </div>
            </div>
          ) : null}

          {passo === "pesos" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t("O quanto cada sinal pesa na nota final. Os nove pesos juntos têm que somar 100.")}
              </p>
              {avisaInstagramSemToken ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg/40 p-3 text-sm" data-testid="niche-instagram-sem-token">
                  <Warning size={16} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
                  <p>{t("Sem APIFY_TOKEN configurado no servidor, o peso de Instagram fica sem efeito até a chave ser configurada. Você ainda pode salvar o nicho normalmente.")}</p>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {CAMPOS_DE_PESO.map(({ key, label }) => (
                  <div key={key} className="flex flex-col gap-1.5">
                    <Label htmlFor={`niche-peso-${key}`}>{t(label)}</Label>
                    <Input
                      id={`niche-peso-${key}`}
                      type="number"
                      min={0}
                      max={100}
                      {...register(`weights.${key}` as const)}
                    />
                  </div>
                ))}
              </div>
              <div
                className={`rounded-lg border p-3 text-sm font-medium ${
                  somaFechada
                    ? "border-success-border bg-success-bg/30 text-success-fg"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                }`}
                data-testid="niche-soma-pesos"
              >
                {t("Soma atual")}: {somaPesos} / 100
                {!somaFechada ? ` — ${t("precisa somar exatamente 100 para salvar")}` : ""}
              </div>
            </div>
          ) : null}

          {passo === "revisao" ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium">{t("Confira antes de salvar")}:</p>
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                <dt className="text-muted-foreground">{t("Nome")}</dt>
                <dd>{payloadPreview.name || "—"}</dd>
                <dt className="text-muted-foreground">{t("Serviço")}</dt>
                <dd>{payloadPreview.serviceType || "—"}</dd>
                <dt className="text-muted-foreground">{t("Termos de busca")}</dt>
                <dd>{payloadPreview.searchTerms.join(", ") || "—"}</dd>
                <dt className="text-muted-foreground">{t("Faixa de avaliações")}</dt>
                <dd>
                  {payloadPreview.requirements.avaliacoesMin ?? "—"} {t("a")} {payloadPreview.requirements.avaliacoesMax ?? "—"}
                </dd>
                <dt className="text-muted-foreground">{t("Exige celular")}</dt>
                <dd>{payloadPreview.requirements.exigeCelular ? t("Sim") : t("Não")}</dd>
                <dt className="text-muted-foreground">{t("Exige site")}</dt>
                <dd>{payloadPreview.requirements.exigeSite ? t("Sim") : t("Não")}</dd>
              </dl>
              <div>
                <p className="mb-1 text-muted-foreground">{t("Pesos")} ({somaPesos}/100)</p>
                <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {CAMPOS_DE_PESO.map(({ key, label }) => (
                    <li key={key}>
                      {t(label)}: <span className="font-medium">{payloadPreview.weights[key]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {erroServidor ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive">
              {erroServidor}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-2">
            <Button type="button" variant="outline" onClick={indicePasso === 0 ? onCancel : voltar} disabled={enviando}>
              {indicePasso === 0 ? t("Cancelar") : t("Voltar")}
            </Button>
            {passo === "revisao" ? (
              // `key` distinto do botão "Próximo" abaixo: sem isso, o React reconcilia
              // os dois <Button> no mesmo nó do DOM (mesmo tipo de elemento, mesma
              // posição) e só troca o atributo `type` de "button" pra "submit" — só
              // que esse nó acabou de receber o clique que fez `avancar()` chegar
              // até aqui, e enquanto ainda está focado o Chrome trata a mudança de
              // tipo como ativação do botão, disparando o submit sozinho (sem
              // nenhum clique em "Salvar nicho"). Com `key` diferente, é outro nó
              // desde o início — nunca herda o foco/estado do clique anterior.
              <Button key="salvar" type="submit" disabled={enviando || !somaFechada}>
                {enviando ? t("Salvando…") : t("Salvar nicho")}
              </Button>
            ) : (
              <Button key="proximo" type="button" onClick={avancar}>
                {t("Próximo")}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
