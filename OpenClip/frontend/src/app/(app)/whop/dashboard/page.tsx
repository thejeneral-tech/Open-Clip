"use client";

import {
  BarChart3,
  ClipboardCheck,
  DollarSign,
  ExternalLink,
  Eye,
  HelpCircle,
  Loader2,
  Megaphone,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CampaignPicker } from "@/components/whop/campaign-picker";
import { BudgetBar, RatePill } from "@/components/whop/platform-meta";
import { WHOP_TOUR_KEY, WhopTour } from "@/components/whop/whop-tour";
import { useWhopDashboard } from "@/hooks/use-api";
import type { WhopSubmissionStatus } from "@/lib/types";
import { formatCompactNumber, formatMoney, formatRelativeTime } from "@/lib/utils";

function statusVariant(
  status: WhopSubmissionStatus
): "default" | "success" | "destructive" | "outline" {
  switch (status) {
    case "paid":
      return "default";
    case "approved":
      return "success";
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}

export default function WhopDashboardPage() {
  const { data: dashboard, isLoading } = useWhopDashboard(true);
  const [tourOpen, setTourOpen] = useState(false);

  // Auto-open the tour on first visit; the tour marks itself seen on close.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(WHOP_TOUR_KEY) !== "1") setTourOpen(true);
    } catch {
      // localStorage unavailable — skip the auto tour.
    }
  }, []);

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Whop Campaigns</h1>
        <p className="text-muted-foreground">
          Run clipping campaigns, review submissions, and track payouts.
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        title="Take the tour"
        onClick={() => setTourOpen(true)}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>
    </div>
  );

  if (isLoading || !dashboard) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {header}
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
        <WhopTour open={tourOpen} onOpenChange={setTourOpen} />
      </div>
    );
  }

  const stats: { label: string; value: string; muted?: string; icon: React.ReactNode }[] = [
    {
      label: "Active campaigns",
      value: `${dashboard.campaigns_active}`,
      muted: `${dashboard.campaigns_total} total`,
      icon: <Megaphone className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Pending review",
      value: `${dashboard.submissions_pending}`,
      muted: `${dashboard.submissions_total} submissions`,
      icon: <ClipboardCheck className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Total views",
      value: formatCompactNumber(dashboard.views_total),
      icon: <Eye className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Paid out",
      value: formatMoney(dashboard.paid_out),
      muted: `${formatMoney(dashboard.pending_payout)} pending`,
      icon: <DollarSign className="h-4 w-4 text-muted-foreground" />,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}

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

      <div className="flex flex-wrap gap-2">
        <CampaignPicker label="Choose a campaign" />
        <Button asChild variant="outline">
          <Link href="/whop/campaigns">
            <Plus className="h-4 w-4" /> New campaign
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/whop/review">
            <ClipboardCheck className="h-4 w-4" /> Review submissions
            {dashboard.submissions_pending > 0 && ` (${dashboard.submissions_pending})`}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/whop/analytics">
            <BarChart3 className="h-4 w-4" /> Analytics
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>My campaigns</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.campaigns.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-muted-foreground">
                  No campaigns yet — create your first campaign.
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href="/whop/campaigns">
                    <Plus className="h-4 w-4" /> New campaign
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {dashboard.campaigns.map((c) => (
                  <div key={c.id} className="space-y-1.5">
                    <div className="flex items-center gap-3">
                      {c.thumbnail_url ? (
                        <img
                          src={c.thumbnail_url}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">
                          <Megaphone className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <Link
                          href={`/whop/campaigns/${c.id}`}
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                        <RatePill rate={c.rate_per_1k} />
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatCompactNumber(c.views_total)} views
                      </span>
                    </div>
                    <BudgetBar paidOut={c.paid_out} budget={c.budget} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent submissions</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.recent_submissions.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">
                No submissions yet — they appear here as clippers post.
              </p>
            ) : (
              <div className="space-y-4">
                {dashboard.recent_submissions.map((s) => (
                  <div key={s.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <a
                          href={s.post_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
                        >
                          <span className="truncate">{s.title ?? s.post_url}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </a>
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                        {s.clawback_requested && <Badge variant="warning">Clawback</Badge>}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeTime(s.updated_at)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {s.campaign_name && `${s.campaign_name} · `}
                      {formatCompactNumber(s.views)} views ·{" "}
                      {formatMoney(s.status === "paid" ? s.paid_amount : s.earnings_estimate)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <WhopTour open={tourOpen} onOpenChange={setTourOpen} />
    </div>
  );
}
