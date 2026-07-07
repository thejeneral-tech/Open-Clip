"use client";

import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ExternalLink,
  LayoutGrid,
  ListFilter,
  Loader2,
  Megaphone,
  RefreshCw,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CampaignForm } from "@/components/whop/campaign-form";
import { RatePill } from "@/components/whop/platform-meta";
import {
  useWhopCampaigns,
  useWhopCreateCampaign,
  useWhopUploadThumbnail,
} from "@/hooks/use-api";
import type { WhopCampaignStatus } from "@/lib/types";
import { cn, formatCompactNumber } from "@/lib/utils";

type StatusFilter = "all" | WhopCampaignStatus;
type SortKey = "recent" | "reward" | "views";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "reward", label: "$ / 1K" },
  { value: "views", label: "Most views" },
];

// Where clippers browse real Content Rewards campaigns on Whop (no API to import them).
const WHOP_DISCOVER_URL = "https://whop.com/discover/content-rewards/";

function statusDot(status: WhopCampaignStatus): string {
  return status === "active"
    ? "bg-emerald-500"
    : status === "paused"
      ? "bg-amber-500"
      : "bg-muted-foreground";
}

// A button that opens a window of campaign choices — pick one to open, or step into
// "Find a new campaign" to add one via the Whop-link importer. Reusable on any page.
export function CampaignPicker({
  label = "Choose a campaign",
  variant = "default",
}: {
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"choose" | "create">("choose");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  // Poll while the window is open so newly created / updated campaigns stream in.
  const { data: campaigns = [], isLoading, isFetching, refetch } = useWhopCampaigns(undefined, open);
  const createCampaign = useWhopCreateCampaign();
  const uploadThumbnail = useWhopUploadThumbnail();

  const visible = (
    statusFilter === "all" ? campaigns : campaigns.filter((c) => c.status === statusFilter)
  )
    .slice()
    .sort((a, b) => {
      if (sort === "reward") return b.rate_per_1k - a.rate_per_1k;
      if (sort === "views") return b.views_total - a.views_total;
      return 0; // "recent" keeps the API's updated_at ordering
    });

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void refetch(); // always show the latest campaigns (incl. brand-new ones) on open
    } else {
      setMode("choose"); // always reopen on the list, never mid-create
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <LayoutGrid className="h-4 w-4" /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "max-h-[88vh] overflow-y-auto",
          mode === "create" ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
      >
        {mode === "choose" ? (
          <>
            <DialogHeader>
              <DialogTitle>Choose a campaign</DialogTitle>
              <DialogDescription>Pick a campaign to open, or find a new one.</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as StatusFilter)}
              >
                <SelectTrigger className="h-8 w-auto gap-1.5" aria-label="Filter by status">
                  <ListFilter className="h-3.5 w-3.5 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-8 w-auto gap-1.5" aria-label="Sort campaigns">
                  <ArrowDownWideNarrow className="h-3.5 w-3.5 text-muted-foreground" />
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
              <span className="ml-auto text-xs text-muted-foreground">
                {visible.length} of {campaigns.length}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => refetch()}
                disabled={isFetching}
                title="Refresh"
                aria-label="Refresh campaigns"
              >
                <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
              </Button>
            </div>

            <div className="max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
              {isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : campaigns.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No campaigns yet — find your first one below.
                </p>
              ) : visible.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No {statusFilter} campaigns.
                </p>
              ) : (
                visible.map((c) => (
                  <Link
                    key={c.id}
                    href={`/whop/campaigns/${c.id}`}
                    onClick={() => setOpen(false)}
                    className="flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors hover:bg-accent"
                  >
                    {c.thumbnail_url ? (
                      <img
                        src={c.thumbnail_url}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted">
                        <Megaphone className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <span className="inline-flex items-center gap-1 text-xs capitalize text-muted-foreground">
                        <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(c.status))} />
                        {c.status} · {formatCompactNumber(c.views_total)} views
                      </span>
                    </div>
                    <RatePill rate={c.rate_per_1k} />
                  </Link>
                ))
              )}
            </div>

            <div className="space-y-2">
              <Button onClick={() => setMode("create")} className="w-full">
                <Search className="h-4 w-4" /> Find a new campaign
              </Button>
              <a
                href={WHOP_DISCOVER_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Browse campaigns on Whop <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <button
                type="button"
                onClick={() => setMode("choose")}
                className="mb-1 inline-flex items-center gap-1 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" /> Back to campaigns
              </button>
              <DialogTitle>Find a campaign</DialogTitle>
              <DialogDescription>
                Paste a Whop campaign link to auto-fill it, then fine-tune every option before adding.
              </DialogDescription>
            </DialogHeader>
            <CampaignForm
              submitLabel="Add campaign"
              submitting={createCampaign.isPending || uploadThumbnail.isPending}
              onSubmit={async (value, thumbnail) => {
                try {
                  const created = await createCampaign.mutateAsync({
                    name: value.name,
                    description: value.description || null,
                    campaign_type: value.campaign_type,
                    category: value.category,
                    rate_per_1k: value.rate_per_1k,
                    budget: value.budget,
                    min_payout: value.min_payout,
                    max_payout: value.max_payout,
                    platforms: value.platforms,
                    requirements: value.requirements,
                    asset_links: value.asset_links,
                    whop_url: value.whop_url || null,
                    ends_at: value.ends_at,
                  });
                  if (thumbnail) {
                    await uploadThumbnail.mutateAsync({ id: created.id, file: thumbnail });
                  }
                  toast.success("Campaign added");
                  setMode("choose"); // back to the list — the new campaign is now in it
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to add campaign");
                }
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
