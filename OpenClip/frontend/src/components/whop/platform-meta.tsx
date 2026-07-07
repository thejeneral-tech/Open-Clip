"use client";

import { Instagram, Music2, Twitter, Youtube, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WhopPlatform } from "@/lib/types";
import { formatMoney } from "@/lib/utils";

// Single source of truth for platform rendering across the Whop pages.
export const WHOP_PLATFORMS: { value: WhopPlatform; label: string; icon: LucideIcon }[] = [
  { value: "tiktok", label: "TikTok", icon: Music2 },
  { value: "instagram", label: "Instagram", icon: Instagram },
  { value: "youtube", label: "YouTube", icon: Youtube },
  { value: "x", label: "X", icon: Twitter },
];

// Mirrors the backend campaign_type vocabulary.
export const WHOP_TYPES: { value: string; label: string }[] = [
  { value: "clipping", label: "Clipping" },
  { value: "ugc", label: "UGC" },
  { value: "faceless", label: "Faceless" },
];

// Mirrors the backend category vocabulary.
export const WHOP_CATEGORIES: { value: string; label: string }[] = [
  { value: "personal_brand", label: "Personal Brand" },
  { value: "products", label: "Products" },
  { value: "education", label: "Education" },
  { value: "entertainment", label: "Entertainment" },
  { value: "music", label: "Music" },
  { value: "gaming", label: "Gaming" },
  { value: "other", label: "Other" },
];

export function platformLabel(p: WhopPlatform): string {
  return WHOP_PLATFORMS.find((m) => m.value === p)?.label ?? p;
}

// Row of muted platform icons with native title tooltips.
export function PlatformIcons({
  platforms,
  size = 14,
}: {
  platforms: WhopPlatform[];
  size?: number;
}) {
  if (platforms.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      {platforms.map((p) => {
        const meta = WHOP_PLATFORMS.find((m) => m.value === p);
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <span key={p} title={meta.label} className="inline-flex">
            <Icon width={size} height={size} />
          </span>
        );
      })}
    </span>
  );
}

// Blue "$X.XX / 1K" pill used everywhere a campaign rate shows up.
export function RatePill({ rate }: { rate: number }) {
  return (
    <Badge className="border-transparent bg-blue-500/15 text-blue-500 hover:bg-blue-500/15">
      ${rate.toFixed(2)} / 1K
    </Badge>
  );
}

// Orange budget progress line: "$X of $Y paid out … NN%" (or the unlimited note).
export function BudgetBar({ paidOut, budget }: { paidOut: number; budget: number | null }) {
  if (budget == null || budget <= 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {formatMoney(paidOut)} paid out · Unlimited budget
      </p>
    );
  }
  const pct = Math.min(100, Math.max(0, (paidOut / budget) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {formatMoney(paidOut)} of {formatMoney(budget)} paid out
        </span>
        <span className="shrink-0">{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
