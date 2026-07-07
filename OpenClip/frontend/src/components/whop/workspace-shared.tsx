"use client";

import {
  AlertTriangle,
  Check,
  Clapperboard,
  ExternalLink,
  Film,
  Sparkles,
  ThumbsUp,
  TrendingUp,
  Wand2,
} from "lucide-react";
import { ScoreRing } from "@/components/score-ring";
import { Badge } from "@/components/ui/badge";
import {
  budgetRemaining,
  burnRatePerDay,
  configWarnings,
  daysUntilExhausted,
  maxPayableViews,
  viewsToClear,
} from "@/lib/campaign-math";
import type { WhopCampaign, WhopStrategy, WhopVideoMatch } from "@/lib/types";
import {
  cn,
  formatCompactNumber,
  formatDuration,
  formatDurationLabel,
  formatMoney,
} from "@/lib/utils";

function projectedLabel(m: WhopVideoMatch): string | null {
  if (m.projected_low == null || m.projected_high == null) return null;
  if (m.projected_low === m.projected_high) return formatMoney(m.projected_low);
  return `${formatMoney(m.projected_low)}–${formatMoney(m.projected_high)}`;
}

function formatViews(n: number | null | undefined): string {
  if (n == null) return "";
  return formatCompactNumber(n);
}

// ------------------------------------------------------------ scored video card
export function ScoredMatchCard({
  match,
  selected,
  scoring,
  onToggle,
}: {
  match: WhopVideoMatch;
  selected: boolean;
  scoring?: boolean; // a deeper (Stage 3) pass is in flight for this card
  onToggle: (m: WhopVideoMatch) => void;
}) {
  const projected = projectedLabel(match);
  const reasons = (match.reasons ?? []).slice(0, 4);
  const factors = match.factors ?? [];
  const delta = match.delta ?? null;

  return (
    <div
      onClick={() => onToggle(match)}
      className={cn(
        "group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition",
        selected ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
      )}
    >
      <div className="relative aspect-video bg-black">
        {match.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={match.thumbnail} alt={match.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <span
          className={cn(
            "absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/70 bg-black/40 text-transparent",
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <ScoreRing score={match.score} size={40} />
          {delta != null && delta !== 0 && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                delta > 0 ? "bg-emerald-500/90 text-white" : "bg-rose-500/90 text-white",
              )}
            >
              {delta > 0 ? `+${delta}` : delta}
            </span>
          )}
        </div>
        {match.duration ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
            {formatDurationLabel(match.duration)}
          </span>
        ) : null}
        {projected && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-emerald-600/90 px-1.5 py-0.5 text-xs font-semibold text-white">
            <TrendingUp className="h-3 w-3" /> {projected}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 text-sm font-medium" title={match.title}>
          {match.title}
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {match.uploader}
          {match.view_count != null ? ` · ${formatViews(match.view_count)} views` : ""}
        </p>

        {/* best transcript moment (Stage 4) */}
        {match.best_moment_start != null && match.best_moment_end != null && (
          <span className="inline-flex w-fit items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            <Clapperboard className="h-3 w-3" /> Best moment {formatDuration(match.best_moment_start)}–
            {formatDuration(match.best_moment_end)}
          </span>
        )}

        {/* confidence + stage */}
        {match.confidence != null && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{match.confidence}% confident</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", scoring ? "animate-pulse bg-primary/60" : "bg-primary")}
                style={{ width: `${match.confidence}%` }}
              />
            </span>
          </div>
        )}

        {/* reasons checklist — the "why" */}
        {reasons.length > 0 && (
          <ul className="space-y-0.5">
            {reasons.map((r, i) => (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-1 text-[11px]",
                  r.kind === "ok" ? "text-foreground" : "text-amber-500",
                )}
              >
                {r.kind === "ok" ? (
                  <Check className="mt-[1px] h-3 w-3 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                )}
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        )}

        {/* full factor breakdown — transparent, on demand */}
        {factors.length > 0 && (
          <details className="mt-0.5" onClick={(e) => e.stopPropagation()}>
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
              Score breakdown
            </summary>
            <div className="mt-1.5 space-y-1">
              {factors.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground" title={f.label}>
                    {f.label}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        f.measured ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                      style={{ width: `${Math.round(f.value)}%` }}
                    />
                  </span>
                  <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {Math.round(f.value)}
                  </span>
                </div>
              ))}
              <p className="pt-0.5 text-[10px] text-muted-foreground">
                Dim bars are estimates; they firm up as deeper analysis runs.
              </p>
            </div>
          </details>
        )}

        <a
          href={match.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-auto inline-flex w-fit items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" /> Watch on YouTube
        </a>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- payout math panel
// Live values come straight from the (possibly-unsaved) form, so this recomputes
// as the user types — no round-trip.
export function PayoutMathPanel({
  campaign,
  ratePer1k,
  budget,
  minPayout,
  maxPayout,
  endsAt,
}: {
  campaign: WhopCampaign;
  ratePer1k: number;
  budget: number | null;
  minPayout: number | null;
  maxPayout: number | null;
  endsAt: string | null;
}) {
  const payable = maxPayableViews(budget, ratePer1k);
  const remaining = budgetRemaining(budget, campaign.paid_out);
  const burn = burnRatePerDay(campaign.paid_out, campaign.created_at);
  const runway = daysUntilExhausted(budget, campaign.paid_out, campaign.created_at);
  const minViews = viewsToClear(minPayout, ratePer1k);
  const warnings = configWarnings({ ratePer1k, budget, minPayout, maxPayout, endsAt });

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: "Cost per 1K views", value: formatMoney(ratePer1k) },
    {
      label: "Budget buys",
      value: payable != null ? `${formatCompactNumber(payable)} views` : "Unlimited",
      hint: "at the current rate",
    },
    {
      label: "Budget left",
      value: remaining != null ? formatMoney(remaining) : "Unlimited",
      hint: budget != null ? `of ${formatMoney(budget)}` : undefined,
    },
    { label: "Spent so far", value: formatMoney(campaign.paid_out), hint: `${burn ? formatMoney(burn) : "$0"}/day` },
  ];
  if (runway != null) rows.push({ label: "Runway at this burn", value: `~${runway} days` });
  if (minViews != null)
    rows.push({ label: "Views to clear min", value: `${formatCompactNumber(minViews)} views` });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">Payout math</p>
        <span className="text-xs text-muted-foreground">updates live</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.label}</dt>
            <dd className="text-sm font-semibold tabular-nums">{r.value}</dd>
            {r.hint && <dd className="text-[11px] text-muted-foreground">{r.hint}</dd>}
          </div>
        ))}
      </dl>
      {warnings.length > 0 && (
        <ul className="space-y-1 border-t pt-2">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
              <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------- copilot panel
// The Campaign Copilot: an LLM-synthesized recommendation (best opportunity +
// why + clip plan + worth-joining verdict) over the ranked set. Falls back to a
// deterministic top-pick while the strategy is loading or if no model is reachable.
export function StrategyPanel({
  matches,
  strategy,
  loading,
}: {
  matches: WhopVideoMatch[];
  strategy?: WhopStrategy | null;
  loading?: boolean;
}) {
  const scored = matches.filter((m) => m.confidence != null);
  if (scored.length === 0) return null;

  // The recommended source: the copilot's pick if given, else the top score.
  const top =
    (strategy?.recommended_url && scored.find((m) => m.url === strategy.recommended_url)) ||
    [...scored].sort((a, b) => b.score - a.score)[0];
  const projected = projectedLabel(top);
  const opportunity = strategy?.opportunity_score ?? top.score;

  const reasons =
    strategy && strategy.reasoning.length > 0
      ? strategy.reasoning.map((text) => ({ kind: "ok" as const, text }))
      : (top.reasons ?? []).filter((r) => r.kind === "ok").slice(0, 3);

  const oneClip = (top.duration ?? 0) < 300;
  const clipPlan =
    strategy?.clip_plan ||
    (oneClip
      ? "Make one tight 20–40s clip from the strongest moment."
      : "Pull 3 clips from the highest-scoring moments to spread your shots.");

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">Campaign copilot</p>
        {strategy && (
          <Badge variant="outline" className="ml-auto text-[10px] uppercase">
            {strategy.source === "ai" ? "AI" : "Rules"}
          </Badge>
        )}
      </div>

      {strategy?.headline && (
        <p className="text-sm font-medium leading-snug">{strategy.headline}</p>
      )}

      <div className="flex items-start gap-3">
        <ScoreRing score={opportunity} size={56} label="opportunity" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">Recommended source</p>
          <p className="line-clamp-2 text-sm font-semibold" title={top.title}>
            {top.title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {projected && (
              <Badge variant="success" className="gap-1">
                <TrendingUp className="h-3 w-3" /> Projected {projected}
              </Badge>
            )}
            {strategy && (
              <Badge
                variant={strategy.worth_joining ? "success" : "warning"}
                className="gap-1"
              >
                <ThumbsUp className="h-3 w-3" />
                {strategy.worth_joining ? "Worth joining" : "Marginal"}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {reasons.length > 0 && (
        <ul className="space-y-0.5">
          {reasons.slice(0, 4).map((r, i) => (
            <li key={i} className="flex items-start gap-1 text-xs">
              <Check className="mt-[1px] h-3 w-3 shrink-0 text-emerald-500" />
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="rounded-md bg-background/60 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Clip plan: </span>
        {clipPlan}
      </p>

      {loading && (
        <p className="flex items-center gap-1.5 text-xs text-primary">
          <Sparkles className="h-3.5 w-3.5 animate-pulse" /> Thinking through your best move…
        </p>
      )}
    </div>
  );
}
