"use client";

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { buildWhatsAppLink } from "@/lib/prospecting/contact-utils";
import { scoreBreakdown, type NicheWeights, type ScoreBreakdownItem, type StatusLabel } from "@/lib/prospecting/score";
import {
  ArrowRight,
  ArrowSquareOut,
  Buildings,
  Check,
  ChatCircle,
  CurrencyDollar,
  Envelope,
  Globe,
  InstagramLogo,
  Lightbulb,
  MapPin,
  Phone,
  Sparkle,
  Star,
  Users,
  Warning,
  X,
} from "@/lib/ui/icons";
import type { PlaceFichaDTO } from "../page";

/**
 * Mesmo `STATUS_META` de `ProspectingResultsTable.tsx` — não inventa cor nova
 * pro rótulo de score, só reaproveita.
 */
const STATUS_META: Record<StatusLabel, { label: string; variant: "success" | "warning" | "neutral" }> = {
  quente: { label: "Quente", variant: "success" },
  oportunidade: { label: "Oportunidade", variant: "warning" },
  baixa: { label: "Baixa", variant: "neutral" },
};

type CorDeBloco = "info" | "default" | "success" | "warning" | "neutral" | "error";

/**
 * Um token de cor (CSS var já existente em `app/globals.css`) por variante de
 * `Badge` — a MESMA paleta que a ficha antiga já usava por bloco
 * (info/default/success/warning/neutral/error), só que agora também usada
 * pra tingir fundo/borda dos cartões maiores (`Destaque`, `BlocoFicha`) via
 * `color-mix()`, em vez de hex cru. Nunca um hex novo fora do design system.
 */
const CORES: Record<CorDeBloco, string> = {
  info: "var(--color-info)",
  default: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  neutral: "var(--color-text-muted)",
  error: "var(--color-error)",
};

const VARIANT_POR_STATUS: Record<StatusLabel, CorDeBloco> = {
  quente: "success",
  oportunidade: "warning",
  baixa: "neutral",
};

function tint(cor: string, pct: number): string {
  return `color-mix(in srgb, ${cor} ${pct}%, transparent)`;
}

/**
 * Cartão tingido na cor do assunto, com barra colorida na esquerda — mesmo
 * `Card` do design system por baixo (`rounded-lg border bg-surface`), só com
 * `style` sobrepondo cor de fundo/borda via `color-mix()` sobre o token da
 * variante. Mantém os `data-testid` de sempre: os 6 blocos são o contrato
 * que `PlaceFicha.test.tsx` já verifica.
 */
function BlocoFicha({
  titulo,
  sub,
  icon: Icon,
  cor,
  children,
  testId,
}: {
  titulo: string;
  sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  cor: CorDeBloco;
  children: React.ReactNode;
  testId: string;
}) {
  const token = CORES[cor];
  return (
    <Card
      className="flex flex-col overflow-hidden border-l-[3px]"
      style={{ backgroundColor: tint(token, 5), borderColor: tint(token, 25), borderLeftColor: token }}
      data-testid={testId}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: tint(token, 18), color: token }}
          >
            <Icon size={15} aria-hidden />
          </span>
          <div>
            <p className="text-[13px] font-semibold tracking-wide" style={{ color: token }}>
              {titulo}
            </p>
            {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 text-sm">{children}</CardContent>
    </Card>
  );
}

/** O número grande do topo: Google/Instagram/Site/Empresa lado a lado. */
function Destaque({
  cor,
  icon: Icon,
  rotulo,
  valor,
  nota,
  children,
}: {
  cor: CorDeBloco;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  rotulo: string;
  valor: React.ReactNode;
  nota?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const token = CORES[cor];
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-4"
      style={{ backgroundColor: tint(token, 5), borderColor: tint(token, 30) }}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider" style={{ color: token }}>
        <Icon size={12} aria-hidden /> {rotulo}
      </p>
      <p className="mt-2 truncate text-2xl font-bold leading-none" style={{ color: token }}>
        {valor}
      </p>
      {children ? <div className="mt-1.5">{children}</div> : null}
      {nota ? <p className="mt-1.5 text-xs text-muted-foreground">{nota}</p> : null}
    </div>
  );
}

function Chip({ cor, children, href }: { cor: CorDeBloco; children: React.ReactNode; href?: string | null }) {
  const token = CORES[cor];
  const classe = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium";
  const style = { color: token, borderColor: tint(token, 40), backgroundColor: tint(token, 10) };
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${classe} hover:brightness-110`} style={style}>
      {children}
    </a>
  ) : (
    <span className={classe} style={style}>
      {children}
    </span>
  );
}

function BotaoAtalho({
  href,
  cor,
  cheio,
  children,
}: {
  href: string;
  cor: CorDeBloco;
  cheio?: boolean;
  children: React.ReactNode;
}) {
  const token = CORES[cor];
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-semibold transition hover:brightness-110"
      style={cheio ? { backgroundColor: token, borderColor: token, color: "var(--color-bg)" } : { color: token, borderColor: tint(token, 45), backgroundColor: tint(token, 8) }}
    >
      {children}
    </a>
  );
}

function Estrelas({ nota, tamanho = 14 }: { nota: number; tamanho?: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={tamanho} weight={nota >= i - 0.25 ? "fill" : "regular"} style={{ color: CORES.info }} />
      ))}
    </span>
  );
}

/** Favicon do site via Google, com fallback pras iniciais do nome quando não há site ou a imagem falha. */
function faviconUrl(site: string | null): string | null {
  if (!site) return null;
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(site).hostname}&sz=128`;
  } catch {
    return null;
  }
}

function iniciaisDoNome(nome: string): string {
  const partes = nome
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((p) => p.length > 2)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "");
  return partes.join("") || nome.slice(0, 2).toUpperCase();
}

function LogoEmpresa({ site, nome, cor }: { site: string | null; nome: string; cor: CorDeBloco }) {
  const [falhou, setFalhou] = useState(false);
  const src = faviconUrl(site);
  const token = CORES[cor];
  return (
    <div
      className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border"
      style={{ borderColor: tint(token, 45), backgroundColor: src && !falhou ? "#fff" : tint(token, 18) }}
    >
      {src && !falhou ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-3/5 w-3/5 object-contain" onError={() => setFalhou(true)} />
      ) : (
        <span className="text-lg font-bold" style={{ color: token }}>
          {iniciaisDoNome(nome)}
        </span>
      )}
    </div>
  );
}

function EstadoVazio({ texto }: { texto: string }) {
  return <p className="text-muted-foreground">{texto}</p>;
}

interface CampoProps {
  rotulo: string;
  children: React.ReactNode;
}
function Campo({ rotulo, children }: CampoProps) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{rotulo}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

/** Forma normalizada do `instagram_data`/`cnpj_data` quando NÃO houve achado — mesma dos dois workers. */
function motivoDoJson(data: Record<string, unknown> | null): string | null {
  const motivo = data?.motivo;
  return typeof motivo === "string" ? motivo : null;
}

/** 2677 -> "2,7 mil" — mesma regra de `mil()` da referência que inspirou esta ficha. */
function formatMil(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (n >= 1000) return `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: n >= 10_000 ? 0 : 1 })} mil`;
  return String(n);
}

const anosDesde = (isoDate: string): number =>
  Math.floor((Date.now() - Date.parse(`${isoDate}T12:00:00`)) / (365.25 * 86_400_000));

/** Os 6 testes do "raio-x do site" — cada `naoTem` é argumento de venda pronto. */
function raioXDoSite(
  resultado: Record<string, unknown>,
  t: (texto: string) => string,
): Array<{ chave: string; rotulo: string; brecha: string; ok: boolean }> {
  const b = (chave: string): boolean => Boolean(resultado[chave]);
  return [
    { chave: "mobile", rotulo: t("Versão para celular"), brecha: t("site quebra no celular"), ok: b("mobileResponsive") },
    { chave: "whatsapp", rotulo: t("Botão de WhatsApp"), brecha: t("cliente não acha como chamar"), ok: b("hasWhatsappButton") },
    { chave: "metaPixel", rotulo: t("Pixel da Meta"), brecha: t("não anuncia no Instagram"), ok: b("hasMetaPixel") },
    { chave: "googleAdsPixel", rotulo: t("Tag do Google Ads"), brecha: t("não anuncia no Google"), ok: b("hasGoogleAdsPixel") },
    { chave: "analytics", rotulo: t("Google Analytics"), brecha: t("não mede visita"), ok: b("hasGoogleAnalytics") },
    { chave: "rodape", rotulo: t("Rodapé com o ano"), brecha: t("site parado no tempo"), ok: !b("desatualizado") },
  ];
}

interface Props {
  initialPlace: PlaceFichaDTO;
  /** Pesos DE VERDADE do nicho da busca — `null` degrada (bloco "de onde vem a nota" não aparece). */
  nicheWeights?: NicheWeights | null;
  nicheName?: string | null;
}

/**
 * Ficha por empresa — T15 (`.specs/features/prospeccao-nichos-e-enriquecimento/`),
 * redesenhada pra paridade visual/funcional com o painel de referência do
 * usuário (`prospeccao-kit-aluno`). Continua com os MESMOS 6 blocos
 * (Google/Instagram/Site/Receita/Contato/Venda), mesma doutrina de estado por
 * `status` (`not_applicable`/`pending`/`processing` → "ainda não consultado";
 * `done` sem achado → "não encontrado" + motivo; `failed` → falha, sem
 * prometer retry) — só o LAYOUT e o CONTEÚDO por dentro de cada bloco
 * ganharam profundidade (raio-x do site, sócios da Receita, mapa, sugestão de
 * venda por IA sob demanda).
 *
 * Realtime: mesmo padrão de sempre — assina só esta linha
 * (`id=eq.${place.id}`) e aplica o `new` via `applyFichaUpdate`, sem reload,
 * quando qualquer enriquecimento (site/CNPJ/Instagram/pitch de IA) termina.
 */
export function PlaceFicha({ initialPlace, nicheWeights = null, nicheName = null }: Props) {
  const t = useT();
  const [place, setPlace] = useState<PlaceFichaDTO>(initialPlace);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);

  const handleRealtimeChange = useCallback((payload: unknown) => {
    const data = (payload as Record<string, unknown> | undefined)?.new;
    if (!data || typeof data !== "object") return;
    setPlace((atual) => applyFichaUpdate(atual, data as Record<string, unknown>));
  }, []);

  useRealtimeChannel({
    name: `prospecting-ficha-${place.id}`,
    postgresChanges: {
      event: "UPDATE",
      schema: "public",
      table: "prospected_places",
      filter: `id=eq.${place.id}`,
    },
    onChange: handleRealtimeChange,
    enabled: true,
  });

  async function gerarPitch() {
    setPitchLoading(true);
    setPitchError(null);
    try {
      const res = await fetch(`/api/v1/prospecting/places/${place.id}/pitch`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setPitchError(body?.error?.message ?? t("Não foi possível gerar a sugestão agora."));
        return;
      }
      // O servidor já promoveu pra pending/processing — o Realtime traz o
      // resultado (ou o 'failed') quando o worker terminar, sem reload.
      setPlace((atual) => ({ ...atual, oportunidadePitchStatus: "pending" }));
    } catch {
      setPitchError(t("Não foi possível gerar a sugestão agora."));
    } finally {
      setPitchLoading(false);
    }
  }

  const statusLabel = (place.statusLabel as StatusLabel) ?? "baixa";
  const scoreMeta = STATUS_META[statusLabel] ?? STATUS_META.baixa;
  const corDaClasse = VARIANT_POR_STATUS[statusLabel] ?? "neutral";
  const score = place.scoreFinal ?? place.scoreInitial;
  const whatsappLink = buildWhatsAppLink(place.phoneNumber, place.name);

  const ig = place.instagramData && typeof place.instagramData.usuario === "string" ? `@${place.instagramData.usuario}` : null;
  const seguidores =
    place.instagramData && typeof place.instagramData.seguidores === "number" ? (place.instagramData.seguidores as number) : null;

  const siteRaioX = place.siteAnalysisStatus === "done" && place.siteAnalysisResult ? raioXDoSite(place.siteAnalysisResult, t) : null;
  const brechas = siteRaioX ? siteRaioX.filter((teste) => !teste.ok).length : 0;

  const cnpjData = place.cnpjData as { razaoSocial?: string; socioAdministrador?: string; abertura?: string; porte?: string; capitalSocial?: number; situacao?: string; socios?: Array<{ nome: string; cargo?: string | null }> } | null;
  const anos = cnpjData?.abertura ? anosDesde(cnpjData.abertura) : null;

  const mapaSrc = place.lat != null && place.lng != null
    ? `https://maps.google.com/maps?q=${place.lat},${place.lng}&z=16&hl=pt-BR&output=embed`
    : place.address
      ? `https://maps.google.com/maps?q=${encodeURIComponent(place.address)}&z=16&hl=pt-BR&output=embed`
      : null;
  const linkMaps = place.googleMapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name} ${place.address ?? ""}`)}`;

  const breakdown: ScoreBreakdownItem[] = nicheWeights
    ? scoreBreakdown(
        {
          hasWebsite: !!place.websiteUrl,
          siteReachable: place.siteAnalysisStatus === "done" ? Boolean(place.siteAnalysisResult?.reachable) : undefined,
          hasInstagram: seguidores !== null,
          hasWhatsapp: whatsappLink !== null,
          hasEmail: Boolean(place.email),
          hasPhone: Boolean(place.phoneNumber) && whatsappLink === null,
          rating: place.rating ?? undefined,
          hasCnpj: Boolean(cnpjData?.razaoSocial),
          hasAddress: Boolean(place.address),
        },
        nicheWeights,
      )
    : [];
  const somaPesos = breakdown.reduce((s, item) => s + item.peso, 0) || 100;

  return (
    <div className="flex flex-col gap-4">
      {/* ─── cabeçalho: quem é, a nota e os atalhos ─── */}
      <header
        className="relative overflow-hidden rounded-xl border p-5 lg:p-6"
        style={{ backgroundColor: tint(CORES[corDaClasse], 4), borderColor: "var(--color-border)" }}
        data-testid="ficha-cabecalho"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <LogoEmpresa site={place.websiteUrl} nome={place.name} cor={corDaClasse} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold leading-tight lg:text-2xl">{place.name}</h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <MapPin size={13} aria-hidden />
                  {place.address ?? "—"}
                </span>
                {nicheName ? <span>· {nicheName}</span> : null}
              </p>
            </div>
          </div>

          <div className="shrink-0 lg:text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t("Nota da prospecção")}</p>
            <p className="leading-none">
              <span className="text-4xl font-bold" style={{ color: CORES[corDaClasse] }}>
                {score}
              </span>
              <span className="text-base text-muted-foreground">/100</span>
            </p>
            <div className="mt-2 h-2 w-40 overflow-hidden rounded-full bg-surface-elevated lg:ml-auto">
              <div className="h-full rounded-full" style={{ width: `${Math.min(score, 100)}%`, backgroundColor: CORES[corDaClasse] }} />
            </div>
            <Badge variant={scoreMeta.variant} className="mt-2">
              {t(scoreMeta.label)}
            </Badge>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: "var(--color-border)" }}>
          {place.rating != null ? (
            <Chip cor="info" href={linkMaps}>
              <Star size={12} weight="fill" /> {place.rating.toFixed(1)} {t("no Google")}
              <span className="opacity-70">· {place.reviewCount ?? 0} {t("avaliações")}</span>
            </Chip>
          ) : null}
          {ig ? (
            <Chip cor="default" href={`https://www.instagram.com/${(place.instagramData?.usuario as string) ?? ""}/`}>
              <InstagramLogo size={12} /> {seguidores !== null ? `${formatMil(seguidores)} ${t("seguidores")}` : ig}
            </Chip>
          ) : null}
          <Chip cor={place.websiteUrl ? "success" : "error"}>
            <Globe size={12} />
            {place.websiteUrl ? t("Com site") : t("Sem site")}
          </Chip>
        </div>

        <div className="mt-3 flex flex-wrap gap-2.5">
          {whatsappLink ? (
            <BotaoAtalho href={whatsappLink} cor="success" cheio>
              <ChatCircle size={14} /> {t("WhatsApp")}
            </BotaoAtalho>
          ) : null}
          {place.websiteUrl ? (
            <BotaoAtalho href={place.websiteUrl} cor="success">
              <Globe size={14} /> {t("Ver site")} <ArrowSquareOut size={12} />
            </BotaoAtalho>
          ) : null}
          {place.instagramData?.usuario ? (
            <BotaoAtalho href={`https://www.instagram.com/${place.instagramData.usuario as string}/`} cor="default">
              <InstagramLogo size={14} /> {t("Instagram")} <ArrowSquareOut size={12} />
            </BotaoAtalho>
          ) : null}
          <BotaoAtalho href={linkMaps} cor="info">
            <MapPin size={14} /> {t("Google Maps")} <ArrowSquareOut size={12} />
          </BotaoAtalho>
        </div>
      </header>

      {/* ─── 4 destaques numéricos ─── */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Destaque cor="info" icon={Star} rotulo={t("Google")} valor={place.rating != null ? place.rating.toFixed(1) : "—"} nota={place.reviewCount ? `${place.reviewCount} ${t("avaliações no Maps")}` : t("sem avaliações")}>
          {place.rating != null ? <Estrelas nota={place.rating} /> : null}
        </Destaque>
        <Destaque
          cor="default"
          icon={InstagramLogo}
          rotulo={t("Instagram")}
          valor={seguidores !== null ? formatMil(seguidores) : (ig ?? t("não achou"))}
          nota={
            seguidores !== null
              ? t("seguidores")
              : ig
                ? t("perfil achado")
                : t("nem no site nem na busca do Google")
          }
        />
        <Destaque
          cor="success"
          icon={Globe}
          rotulo={t("Site")}
          valor={!place.websiteUrl ? t("sem") : place.siteAnalysisStatus === "done" ? (place.siteAnalysisResult?.reachable ? t("no ar") : t("fora")) : t("…")}
          nota={siteRaioX ? (brechas ? `${brechas} ${t("de")} ${siteRaioX.length} ${t("testes falharam")}` : t("passou em todos os testes")) : undefined}
        />
        <Destaque
          cor="warning"
          icon={Buildings}
          rotulo={t("Empresa")}
          valor={anos !== null ? `${anos} ${anos === 1 ? t("ano") : t("anos")}` : "—"}
          nota={cnpjData?.porte ? cnpjData.porte.toLowerCase() : t("CNPJ não consultado")}
        />
      </div>

      {/* ─── de onde vem a nota ─── */}
      {breakdown.length > 0 ? (
        <BlocoFicha titulo={t("De onde vem a nota")} sub={nicheName ? `${t("A régua do nicho")} ${nicheName}` : undefined} icon={Sparkle} cor={corDaClasse} testId="ficha-de-onde-vem-a-nota">
          <div className="mb-4 flex h-3 gap-0.5 overflow-hidden rounded-full">
            {breakdown.map((item) => (
              <div
                key={item.sinal}
                title={`${item.sinal}: ${item.atingido ? `+${item.peso}` : `0/${item.peso}`}`}
                style={{ width: `${(item.peso / somaPesos) * 100}%`, backgroundColor: item.atingido ? CORES[corDaClasse] : "var(--color-border)" }}
              />
            ))}
          </div>
          <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {breakdown.map((item) => (
              <li key={item.sinal} className="flex items-center gap-2 text-sm">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                  style={item.atingido ? { backgroundColor: tint(CORES[corDaClasse], 20), color: CORES[corDaClasse] } : { backgroundColor: "var(--color-surface-elevated)", color: "var(--color-text-subtle)" }}
                >
                  {item.atingido ? <Check size={11} weight="bold" /> : <X size={11} weight="bold" />}
                </span>
                <span className={item.atingido ? "" : "text-muted-foreground"}>
                  {item.sinal}
                  {item.naoColetado ? ` (${t("não coletado")})` : ""}
                </span>
                <span className="ml-auto text-xs font-semibold" style={{ color: item.atingido ? CORES[corDaClasse] : "var(--color-text-subtle)" }}>
                  {item.atingido ? `+${item.peso}` : `0/${item.peso}`}
                </span>
              </li>
            ))}
          </ul>
        </BlocoFicha>
      ) : null}

      {/* ─── Google ─── */}
      <BlocoFicha titulo={t("Google")} icon={MapPin} cor="info" testId="ficha-bloco-google">
        <Campo rotulo={t("Avaliação")}>
          {place.rating != null ? (
            <span className="inline-flex items-center gap-1">
              <Star size={13} weight="fill" style={{ color: CORES.info }} aria-hidden />
              {place.rating.toFixed(1)} ({place.reviewCount ?? 0})
            </span>
          ) : (
            "—"
          )}
        </Campo>
        <Campo rotulo={t("Endereço")}>{place.address ?? "—"}</Campo>
        <Campo rotulo={t("Score inicial")}>{place.scoreInitial}</Campo>
        {!place.requisitosOk ? (
          <p className="rounded-md bg-warning-bg/40 p-2 text-xs text-warning-fg" data-testid="ficha-fora-do-perfil">
            {t("Fora do perfil do nicho")}
            {place.motivoRequisitos ? `: ${place.motivoRequisitos}` : ""}
          </p>
        ) : null}
      </BlocoFicha>

      {/* ─── Site (com raio-x) ─── */}
      <BlocoFicha
        titulo={t("Raio-x do site")}
        sub={place.siteAnalysisStatus === "done" ? t("O que a prospecção leu no código do site. Cada falha é argumento de venda.") : undefined}
        icon={Globe}
        cor="success"
        testId="ficha-bloco-site"
      >
        {!place.websiteUrl ? (
          <EstadoVazio texto={t("Sem site divulgado no Maps.")} />
        ) : place.siteAnalysisStatus === "pending" || place.siteAnalysisStatus === "processing" ? (
          <EstadoVazio texto={t("Ainda não consultado…")} />
        ) : place.siteAnalysisStatus === "failed" ? (
          <EstadoVazio texto={t("Não foi possível analisar (fora do ar, ou não respondeu a tempo).")} />
        ) : siteRaioX ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {siteRaioX.map((teste) => (
                <div
                  key={teste.chave}
                  className="rounded-lg border p-2.5"
                  style={teste.ok ? { borderColor: tint(CORES.success, 40), backgroundColor: tint(CORES.success, 8) } : { borderColor: tint(CORES.error, 45), backgroundColor: tint(CORES.error, 10) }}
                >
                  <p className="flex items-center gap-1.5 text-xs font-bold" style={{ color: teste.ok ? CORES.success : CORES.error }}>
                    {teste.ok ? <Check size={12} weight="bold" /> : <X size={12} weight="bold" />} {teste.ok ? t("tem") : t("não tem")}
                  </p>
                  <p className="mt-1 text-sm leading-tight">{teste.rotulo}</p>
                  {!teste.ok ? <p className="mt-0.5 text-[11px] text-muted-foreground">{teste.brecha}</p> : null}
                </div>
              ))}
            </div>
            <a href={place.websiteUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-accent underline underline-offset-2">
              <ArrowSquareOut size={13} aria-hidden />
              {t("Abrir site")}
            </a>
          </>
        ) : null}
      </BlocoFicha>

      {/* ─── Receita ─── */}
      <BlocoFicha titulo={t("Receita")} icon={Buildings} cor="warning" testId="ficha-bloco-receita">
        {place.cnpjStatus === "not_applicable" ? (
          <EstadoVazio texto={t("Ainda não solicitado.")} />
        ) : place.cnpjStatus === "pending" || place.cnpjStatus === "processing" ? (
          <EstadoVazio texto={t("Ainda não consultado…")} />
        ) : place.cnpjStatus === "failed" ? (
          <EstadoVazio texto={t("Não foi possível consultar.")} />
        ) : cnpjData && typeof cnpjData.razaoSocial === "string" ? (
          <>
            <p className="text-base font-medium">{cnpjData.razaoSocial}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {cnpjData.situacao ? <Chip cor={cnpjData.situacao === "ATIVA" ? "success" : "error"}>{cnpjData.situacao.toLowerCase()}</Chip> : null}
              {cnpjData.porte ? <Chip cor="warning">{cnpjData.porte.toLowerCase()}</Chip> : null}
            </div>
            <Campo rotulo={t("Sócio-administrador")}>{cnpjData.socioAdministrador ?? "—"}</Campo>
            <Campo rotulo={t("Abertura")}>{cnpjData.abertura ?? "—"}</Campo>
            {cnpjData.socios && cnpjData.socios.length > 0 ? (
              <div className="mt-2 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Users size={12} aria-hidden /> {t("Quem manda")}
                </p>
                <ul className="flex flex-col gap-2">
                  {cnpjData.socios.map((socio) => (
                    <li key={socio.nome} className="flex items-center gap-2.5">
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                        style={{ backgroundColor: tint(CORES.warning, 20), color: CORES.warning }}
                      >
                        {iniciaisDoNome(socio.nome)}
                      </span>
                      <span className="text-sm">
                        {socio.nome}
                        {socio.cargo ? <span className="block text-xs text-muted-foreground">{socio.cargo}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <EstadoVazio texto={`${t("Não encontrado.")}${motivoDoJson(place.cnpjData) ? ` ${motivoDoJson(place.cnpjData)}` : ""}`} />
        )}
      </BlocoFicha>

      {/* ─── mapa ─── */}
      <BlocoFicha titulo={t("No Google Maps")} sub={place.address ?? undefined} icon={MapPin} cor="info" testId="ficha-mapa">
        {mapaSrc ? (
          <iframe
            src={mapaSrc}
            title={`${t("Mapa de")} ${place.name}`}
            className="h-64 w-full rounded-lg border"
            style={{ borderColor: "var(--color-border)" }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <EstadoVazio texto={t("Sem endereço suficiente para montar o mapa.")} />
        )}
        <a href={linkMaps} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex w-fit items-center gap-1 text-xs text-accent underline underline-offset-2">
          {t("abrir no Maps")} <ArrowSquareOut size={11} aria-hidden />
        </a>
      </BlocoFicha>

      {/* ─── Contato ─── */}
      <BlocoFicha titulo={t("Contato")} icon={ChatCircle} cor="neutral" testId="ficha-bloco-contato">
        <Campo rotulo={t("Telefone")}>{place.phoneNumber ?? "—"}</Campo>
        <Campo rotulo={t("E-mail")}>
          {place.email ? (
            <a href={`mailto:${place.email}`} className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
              <Envelope size={13} aria-hidden />
              {place.email}
            </a>
          ) : (
            "—"
          )}
        </Campo>
        <Campo rotulo={t("WhatsApp")}>
          {whatsappLink ? (
            <a href={whatsappLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
              <Phone size={13} aria-hidden />
              {t("Enviar mensagem")}
            </a>
          ) : (
            t("Sem celular")
          )}
        </Campo>
      </BlocoFicha>

      {/* ─── Instagram ─── */}
      <BlocoFicha titulo={t("Instagram")} sub={ig ?? undefined} icon={InstagramLogo} cor="default" testId="ficha-bloco-instagram">
        {place.instagramStatus === "not_applicable" ? (
          <EstadoVazio texto={t("Este nicho não pede este dado, ou a integração com Apify não está configurada.")} />
        ) : place.instagramStatus === "pending" || place.instagramStatus === "processing" ? (
          <EstadoVazio texto={t("Ainda não consultado…")} />
        ) : place.instagramStatus === "failed" ? (
          <EstadoVazio texto={t("Não foi possível consultar.")} />
        ) : place.instagramData && typeof place.instagramData.seguidores === "number" ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <p className="text-xl font-bold" style={{ color: CORES.default }}>
                  {formatMil(seguidores)}
                </p>
                <p className="text-xs text-muted-foreground">{t("seguidores")}</p>
              </div>
              <div>
                <p className="text-xl font-bold">{(place.instagramData.posts as number | null) ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{t("posts")}</p>
              </div>
              <div>
                <p className="text-xl font-bold">{(place.instagramData.diasSemPostar as number | null) ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{t("dias sem postar")}</p>
              </div>
            </div>
            {place.instagramData.bio ? <p className="mt-1 whitespace-pre-wrap text-sm">{place.instagramData.bio as string}</p> : null}
            {typeof place.instagramData.usuario === "string" ? (
              <a href={`https://www.instagram.com/${place.instagramData.usuario}/`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-accent underline underline-offset-2">
                <ArrowSquareOut size={13} aria-hidden />@{place.instagramData.usuario as string}
              </a>
            ) : null}
            {place.abordagemInstagram ? (
              <div className="mt-2 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t("Ganchos para a abordagem")}</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{place.abordagemInstagram}</p>
              </div>
            ) : null}
          </>
        ) : (
          <EstadoVazio texto={`${t("Não encontrado.")}${motivoDoJson(place.instagramData) ? ` ${motivoDoJson(place.instagramData)}` : ""}`} />
        )}
      </BlocoFicha>

      {/* ─── Venda ─── */}
      <BlocoFicha titulo={t("Venda")} icon={CurrencyDollar} cor="error" testId="ficha-bloco-venda">
        <Campo rotulo={t("Nota final")}>
          <span className="inline-flex items-center gap-1.5">
            {score}
            <Badge variant={scoreMeta.variant}>{t(scoreMeta.label)}</Badge>
          </span>
        </Campo>
        <Campo rotulo={t("Requisitos do nicho")}>{place.requisitosOk ? t("Dentro do perfil") : t("Fora do perfil")}</Campo>
        {place.promotedLeadId ? (
          <a href={`/app/leads/${place.promotedLeadId}`} className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
            {t("Ver no funil")}
            <ArrowRight size={13} aria-hidden />
          </a>
        ) : null}

        <div className="mt-2 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
          {place.oportunidadePitchStatus === "done" && place.justificativaOportunidade ? (
            <div className="flex items-start gap-3 rounded-lg p-3" style={{ backgroundColor: tint(CORES.error, 8) }}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: tint(CORES.error, 20), color: CORES.error }}>
                <Lightbulb size={16} aria-hidden />
              </span>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: CORES.error }}>
                  {t("A venda que cabe")}
                </p>
                <p className="mt-1 text-sm leading-relaxed">{place.justificativaOportunidade}</p>
              </div>
            </div>
          ) : place.oportunidadePitchStatus === "pending" || place.oportunidadePitchStatus === "processing" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ficha-pitch-gerando">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
              {t("Gerando sugestão de venda…")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={gerarPitch}
                disabled={pitchLoading}
                data-testid="ficha-gerar-pitch"
                className="inline-flex w-fit items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-semibold transition hover:brightness-110 disabled:opacity-60"
                style={{ color: CORES.error, borderColor: tint(CORES.error, 45), backgroundColor: tint(CORES.error, 8) }}
              >
                <Sparkle size={14} aria-hidden />
                {place.oportunidadePitchStatus === "failed" ? t("Tentar gerar de novo") : t("Gerar sugestão de venda")}
              </button>
              {pitchError ? (
                <p className="flex items-start gap-1.5 text-xs text-warning-fg" data-testid="ficha-pitch-erro">
                  <Warning size={13} className="mt-0.5 shrink-0" aria-hidden />
                  {pitchError}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </BlocoFicha>
    </div>
  );
}

/**
 * Aplica um update de linha chegado do Realtime ao estado da ficha — mesmo
 * espírito de `applyPlaceUpdate` (`ProspectingResultsTable.tsx`), mapeando
 * os campos que os 4 workers desta feature podem tocar (site/CNPJ/
 * Instagram/pitch de IA) mais os que a rota de busca grava no INSERT original.
 */
export function applyFichaUpdate(
  atual: PlaceFichaDTO,
  updatedData: Record<string, unknown>,
): PlaceFichaDTO {
  const fieldMap: Record<string, keyof PlaceFichaDTO> = {
    score_final: "scoreFinal",
    status_label: "statusLabel",
    site_analysis_status: "siteAnalysisStatus",
    site_analysis_result: "siteAnalysisResult",
    email: "email",
    requisitos_ok: "requisitosOk",
    motivo_requisitos: "motivoRequisitos",
    cnpj_status: "cnpjStatus",
    cnpj_data: "cnpjData",
    cnpj_consultado_em: "cnpjConsultadoEm",
    instagram_status: "instagramStatus",
    instagram_data: "instagramData",
    instagram_consultado_em: "instagramConsultadoEm",
    promoted_lead_id: "promotedLeadId",
    oportunidade_pitch_status: "oportunidadePitchStatus",
    justificativa_oportunidade: "justificativaOportunidade",
    abordagem_instagram: "abordagemInstagram",
    oportunidade_pitch_gerado_em: "oportunidadePitchGeradoEm",
  };

  const patch: Partial<PlaceFichaDTO> = {};
  for (const [dbKey, dtoKey] of Object.entries(fieldMap)) {
    if (dbKey in updatedData) {
      patch[dtoKey] = updatedData[dbKey] as never;
    }
  }
  return { ...atual, ...patch };
}
