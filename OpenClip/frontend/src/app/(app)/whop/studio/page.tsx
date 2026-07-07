"use client";

import { ExternalLink, Loader2, Megaphone, Scissors } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BudgetBar, PlatformIcons, RatePill } from "@/components/whop/platform-meta";
import { useWhopCampaigns } from "@/hooks/use-api";
import type { WhopCampaign } from "@/lib/types";
import { cn } from "@/lib/utils";

function StudioCampaignCard({ c }: { c: WhopCampaign }) {
  const router = useRouter();
  const goToStudio = () => router.push(`/whop/studio/${c.id}`);

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={goToStudio}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goToStudio();
        }
      }}
      className="flex cursor-pointer flex-col transition hover:border-primary/50 hover:shadow-md"
    >
      <CardHeader className="pb-3">
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
          <CardTitle className="truncate">{c.name}</CardTitle>
          <div className="ml-auto shrink-0">
            <RatePill rate={c.rate_per_1k} />
          </div>
        </div>
        {c.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <BudgetBar paidOut={c.paid_out} budget={c.budget} />
        <PlatformIcons platforms={c.platforms} />
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {c.whop_url ? (
            <a
              href={c.whop_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open on Whop
            </a>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              goToStudio();
            }}
          >
            <Scissors className="h-4 w-4" /> Start clipping
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function WhopStudioPage() {
  const { data: campaigns = [], isLoading } = useWhopCampaigns();
  // "In use" = campaigns you've already opened in Studio or that have submissions.
  const [tab, setTab] = useState<"all" | "in_use">("all");
  const inUseCount = useMemo(
    () => campaigns.filter((c) => c.studio_project_id != null || c.submissions_total > 0).length,
    [campaigns],
  );
  const displayed = useMemo(
    () =>
      tab === "in_use"
        ? campaigns.filter((c) => c.studio_project_id != null || c.submissions_total > 0)
        : campaigns,
    [campaigns, tab],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Studio</h1>
        <p className="text-muted-foreground">
          Turn long videos into viral clips for your campaigns — pick a campaign to start.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Scissors className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No campaigns yet. Create a campaign first, then clip for it.
            </p>
            <Button asChild>
              <Link href="/whop/campaigns">
                <Megaphone className="h-4 w-4" /> Go to Campaigns
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* All vs the campaigns you're actively clipping. */}
          <div className="inline-flex rounded-lg border bg-secondary p-1">
            <button
              type="button"
              onClick={() => setTab("all")}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                tab === "all"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
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

          {displayed.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No campaigns in use yet — open one from “All campaigns” to start clipping.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {displayed.map((c) => (
                <StudioCampaignCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
