"use client";

import { ClipboardCheck, DollarSign, Eye, Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWhopAnalytics, useWhopCampaigns } from "@/hooks/use-api";
import type { WhopAnalyticsPoint } from "@/lib/types";
import { formatCompactNumber, formatMoney } from "@/lib/utils";

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function WhopAnalyticsPage() {
  const [days, setDays] = useState(30);
  const [campaignId, setCampaignId] = useState<number | undefined>(undefined);

  const { data: campaigns = [] } = useWhopCampaigns();
  const { data: analytics, isLoading } = useWhopAnalytics({ days, campaign_id: campaignId });

  const header = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Track Analytics</h1>
      <p className="text-muted-foreground">
        Monitor performance and payouts across your campaigns.
      </p>
    </div>
  );

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7">Last 7 days</SelectItem>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="90">Last 90 days</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={campaignId != null ? String(campaignId) : "all"}
        onValueChange={(v) => setCampaignId(v === "all" ? undefined : Number(v))}
      >
        <SelectTrigger className="w-56">
          <SelectValue placeholder="All campaigns" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All campaigns</SelectItem>
          {campaigns.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  if (isLoading || !analytics) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {header}
        {controls}
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const stats: { label: string; value: string; muted?: string; icon: React.ReactNode }[] = [
    {
      label: "Views generated",
      value: formatCompactNumber(analytics.views_total),
      icon: <Eye className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Total payout",
      value: formatMoney(analytics.earnings_total),
      icon: <DollarSign className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Effective CPM",
      value: formatMoney(analytics.effective_cpm),
      muted: "per 1K views",
      icon: <TrendingUp className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Submissions",
      value: String(analytics.submissions_total),
      muted: `${analytics.approval_rate.toFixed(0)}% approval`,
      icon: <ClipboardCheck className="h-4 w-4 text-muted-foreground" />,
    },
  ];

  const hasActivity = analytics.series.some((p) => p.views > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}
      {controls}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-start justify-between pt-6">
              <div>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-sm text-muted-foreground">{s.label}</p>
                {s.muted && <p className="text-xs text-muted-foreground">{s.muted}</p>}
              </div>
              {s.icon}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Views over time</CardTitle>
        </CardHeader>
        <CardContent>
          {hasActivity ? (
            <ViewsChart series={analytics.series} />
          ) : (
            <p className="py-16 text-center text-muted-foreground">
              No view activity in this period yet. Views appear as you update submission counts.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Campaign breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {analytics.campaigns.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No campaigns in this period yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 text-right font-medium">Submissions</th>
                  <th className="pb-2 text-right font-medium">Views</th>
                  <th className="pb-2 text-right font-medium">Earnings</th>
                  <th className="pb-2 text-right font-medium">CPM</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {analytics.campaigns.map((c) => (
                  <tr key={c.campaign_id}>
                    <td className="py-2">
                      <Link
                        href={`/whop/campaigns/${c.campaign_id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="py-2 text-right">{c.submissions}</td>
                    <td className="py-2 text-right">{formatCompactNumber(c.views)}</td>
                    <td className="py-2 text-right">{formatMoney(c.earnings)}</td>
                    <td className="py-2 text-right">
                      {c.views > 0 ? formatMoney((c.earnings / c.views) * 1000) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Hand-rolled responsive SVG area chart — no chart library exists in this
 * project. Theme accent via var(--red); native <title> tooltips per point.
 */
function ViewsChart({ series }: { series: WhopAnalyticsPoint[] }) {
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const maxViews = Math.max(...series.map((p) => p.views), 1);
  const x = (i: number) =>
    PAD.left + (series.length > 1 ? (i / (series.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => PAD.top + innerH - (v / maxViews) * innerH;

  const linePath = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.views).toFixed(1)}`)
    .join(" ");
  const baseline = (PAD.top + innerH).toFixed(1);
  const areaPath = `${linePath} L${x(series.length - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

  // 4 horizontal gridlines at 25/50/75/100% of the max.
  const gridFractions = [0.25, 0.5, 0.75, 1];

  // ~5 evenly spaced x labels (deduped for short ranges).
  const labelIndices = Array.from(
    new Set(
      Array.from({ length: 5 }, (_, i) => Math.round((i * (series.length - 1)) / 4)),
    ),
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Views over time"
    >
      <defs>
        <linearGradient id="whop-views-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--red)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {gridFractions.map((f) => (
        <g key={f}>
          <line
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={y(maxViews * f)}
            y2={y(maxViews * f)}
            stroke="var(--border)"
            strokeWidth="1"
          />
          <text
            x={PAD.left - 6}
            y={y(maxViews * f) + 3}
            textAnchor="end"
            fontSize="10"
            fill="var(--muted-fg)"
          >
            {formatCompactNumber(maxViews * f)}
          </text>
        </g>
      ))}
      <line
        x1={PAD.left}
        x2={PAD.left + innerW}
        y1={PAD.top + innerH}
        y2={PAD.top + innerH}
        stroke="var(--border)"
        strokeWidth="1"
      />

      <path d={areaPath} fill="url(#whop-views-gradient)" />
      <path d={linePath} fill="none" stroke="var(--red)" strokeWidth="2" strokeLinejoin="round" />

      {labelIndices.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 8}
          textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
          fontSize="10"
          fill="var(--muted-fg)"
        >
          {shortDate(series[i].date)}
        </text>
      ))}

      {series.map((p, i) => {
        const left = i === 0 ? PAD.left : (x(i - 1) + x(i)) / 2;
        const right = i === series.length - 1 ? PAD.left + innerW : (x(i) + x(i + 1)) / 2;
        return (
          <rect
            key={p.date}
            x={left}
            y={PAD.top}
            width={Math.max(right - left, 1)}
            height={innerH}
            fill="transparent"
          >
            <title>
              {`${shortDate(p.date)} · ${p.views.toLocaleString("en-US")} views · ${formatMoney(p.earnings)}`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
