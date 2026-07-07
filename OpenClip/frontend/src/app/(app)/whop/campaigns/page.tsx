"use client";

import {
  ExternalLink,
  Loader2,
  Megaphone,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CampaignPicker } from "@/components/whop/campaign-picker";
import { BudgetBar, PlatformIcons, RatePill } from "@/components/whop/platform-meta";
import {
  useWhopCampaigns,
  useWhopDeleteCampaign,
  useWhopRescan,
  useWhopUpdateCampaign,
} from "@/hooks/use-api";
import type { WhopCampaign, WhopCampaignStatus } from "@/lib/types";
import { cn, formatCompactNumber } from "@/lib/utils";

type StatusFilter = "all" | WhopCampaignStatus;
type SortKey = "recent" | "views" | "reward";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "views", label: "Most views" },
  { value: "reward", label: "Highest reward" },
];

// Small always-on status indicator — a coloured dot beats another badge.
function StatusDot({ status }: { status: WhopCampaignStatus }) {
  const color =
    status === "active"
      ? "bg-emerald-500"
      : status === "paused"
        ? "bg-amber-500"
        : "bg-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1 text-xs capitalize text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {status}
    </span>
  );
}

function CampaignCard({ c }: { c: WhopCampaign }) {
  const updateCampaign = useWhopUpdateCampaign();
  const deleteCampaign = useWhopDeleteCampaign();

  const setStatus = async (status: WhopCampaignStatus, message: string) => {
    try {
      await updateCampaign.mutateAsync({ id: c.id, data: { status } });
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update campaign");
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            {c.thumbnail_url ? (
              <img
                src={c.thumbnail_url}
                alt=""
                className="h-9 w-9 shrink-0 rounded-lg border object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-600/30">
                <Megaphone className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <CardTitle className="truncate">
                <Link href={`/whop/campaigns/${c.id}`} className="hover:text-primary">
                  {c.name}
                </Link>
              </CardTitle>
              <div className="mt-1 flex items-center gap-2">
                <RatePill rate={c.rate_per_1k} />
                <StatusDot status={c.status} />
              </div>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/whop/campaigns/${c.id}`}>
                  <ExternalLink className="h-4 w-4" /> Open
                </Link>
              </DropdownMenuItem>
              {c.status === "active" && (
                <DropdownMenuItem onClick={() => setStatus("paused", "Campaign paused")}>
                  <Pause className="h-4 w-4" /> Pause
                </DropdownMenuItem>
              )}
              {c.status === "paused" && (
                <DropdownMenuItem onClick={() => setStatus("active", "Campaign resumed")}>
                  <Play className="h-4 w-4" /> Resume
                </DropdownMenuItem>
              )}
              {c.status !== "ended" && (
                <DropdownMenuItem
                  onClick={async () => {
                    if (confirm(`End "${c.name}"? Clippers can no longer submit to it.`)) {
                      await setStatus("ended", "Campaign ended");
                    }
                  }}
                >
                  <Square className="h-4 w-4" /> End campaign
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive"
                onClick={async () => {
                  if (confirm(`Delete "${c.name}"? Its submissions are deleted too.`)) {
                    try {
                      await deleteCampaign.mutateAsync(c.id);
                      toast.success("Campaign deleted");
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to delete campaign");
                    }
                  }
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="mt-auto space-y-2">
        <BudgetBar paidOut={c.paid_out} budget={c.budget} />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <PlatformIcons platforms={c.platforms} />
          <span>{formatCompactNumber(c.views_total)} views</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function WhopCampaignsPage() {
  const { data: campaigns = [], isLoading } = useWhopCampaigns();
  const rescan = useWhopRescan();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  // "In use" = campaigns you're actively working on (opened in Studio, or have
  // submissions) — vs the full marketplace list.
  const [tab, setTab] = useState<"all" | "in_use">("all");

  // One-click rescan: the backend scrapes Whop's marketplace and upserts/reconciles.
  const onRescan = async () => {
    try {
      const res = await rescan.mutateAsync();
      const bits = [
        res.created ? `${res.created} added` : "",
        res.updated ? `${res.updated} updated` : "",
        res.ended ? `${res.ended} ended` : "",
      ].filter(Boolean);
      toast.success(
        `Rescanned ${res.total} campaigns` +
          (bits.length ? ` — ${bits.join(", ")}` : " — nothing changed") +
          (res.reconciled ? "" : " (statuses left as-is — scan looked partial)"),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rescan failed");
    }
  };

  const inUseCount = useMemo(
    () => campaigns.filter((c) => c.studio_project_id != null || c.submissions_total > 0).length,
    [campaigns],
  );

  const visible = useMemo(() => {
    let filtered = status === "all" ? campaigns : campaigns.filter((c) => c.status === status);
    if (tab === "in_use") {
      filtered = filtered.filter((c) => c.studio_project_id != null || c.submissions_total > 0);
    }
    const arr = [...filtered];
    if (sort === "views") arr.sort((a, b) => b.views_total - a.views_total);
    else if (sort === "reward") arr.sort((a, b) => b.rate_per_1k - a.rate_per_1k);
    return arr; // "recent" keeps the API's updated_at ordering
  }, [campaigns, status, sort, tab]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">
            Paste a Whop link to add a campaign, then track how its budget pays out.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={onRescan}
            disabled={rescan.isPending}
            title="Rescan Whop's marketplace — adds new campaigns and updates active/ended statuses"
          >
            {rescan.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {rescan.isPending ? "Rescanning…" : "Rescan"}
          </Button>
          <CampaignPicker label="Find a campaign" />
        </div>
      </div>

      {/* All vs the campaigns you're actively working on. */}
      <div className="inline-flex rounded-lg border bg-secondary p-1">
        <button
          type="button"
          onClick={() => setTab("all")}
          className={cn(
            "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
            tab === "all" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          All campaigns
        </button>
        <button
          type="button"
          onClick={() => setTab("in_use")}
          className={cn(
            "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
            tab === "in_use"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          In use{inUseCount > 0 ? ` · ${inUseCount}` : ""}
        </button>
      </div>

      {/* Dropdown filters. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {visible.length} {visible.length === 1 ? "campaign" : "campaigns"}
        </span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No campaigns yet. Paste a Whop link to add your first one.
            </p>
            <CampaignPicker label="Find your first campaign" />
          </CardContent>
        </Card>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          {tab === "in_use"
            ? "No campaigns in use yet — open one in the Studio to start."
            : `No ${status === "all" ? "" : `${status} `}campaigns.`}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <CampaignCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}
