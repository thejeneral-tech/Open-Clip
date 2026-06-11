"use client";

import {
  BookOpen,
  CheckCircle2,
  Clapperboard,
  Download,
  Eye,
  Film,
  Loader2,
  Search,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useSvDashboard } from "@/hooks/use-api";
import type { SvVideoStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

function statusVariant(status: SvVideoStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "ready_for_review":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

const ACTIVE_STATUSES: SvVideoStatus[] = ["queued", "processing", "rendering"];

export default function StoryVaultCommandPage() {
  const { data: dashboard, isLoading } = useSvDashboard(true);

  if (isLoading || !dashboard) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Command Center</h1>
          <p className="text-muted-foreground">
            Story Vault — turn stories into narrated vertical videos.
          </p>
        </div>
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const stats: { label: string; value: number; muted?: string; icon: React.ReactNode }[] = [
    {
      label: "Stories",
      value: dashboard.stories_total,
      muted: `${dashboard.stories_new} new`,
      icon: <BookOpen className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Approved stories",
      value: dashboard.stories_approved,
      icon: <CheckCircle2 className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Footage clips",
      value: dashboard.segments_total,
      muted: `${dashboard.backgrounds_ready} backgrounds ready`,
      icon: <Film className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "In pipeline",
      value: dashboard.videos_in_pipeline,
      icon: <Workflow className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "In review",
      value: dashboard.videos_in_review,
      icon: <Eye className="h-4 w-4 text-muted-foreground" />,
    },
    {
      label: "Exports",
      value: dashboard.exports_total,
      icon: <Download className="h-4 w-4 text-muted-foreground" />,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Command Center</h1>
        <p className="text-muted-foreground">
          Story Vault — turn stories into narrated vertical videos.
        </p>
      </div>

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
        <Button asChild variant="outline">
          <Link href="/storyvault/library">
            <Search className="h-4 w-4" /> Find stories
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/storyvault/studio">
            <Clapperboard className="h-4 w-4" /> Create a video
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/storyvault/review">
            <Eye className="h-4 w-4" /> Review queue
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/storyvault/exports">
            <Download className="h-4 w-4" /> Exports
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent videos</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.recent_videos.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No videos yet — create one in the Studio.
            </p>
          ) : (
            <div className="space-y-4">
              {dashboard.recent_videos.map((v) => (
                <div key={v.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {v.story_title ?? v.title ?? `Video #${v.id}`}
                      </span>
                      <Badge variant={statusVariant(v.status)}>{v.status.replace(/_/g, " ")}</Badge>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(v.updated_at)}
                    </span>
                  </div>
                  {ACTIVE_STATUSES.includes(v.status) && (
                    <div className="flex items-center gap-2">
                      <Progress value={v.progress} className="h-1.5" />
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {v.stage ?? "working"} · {Math.round(v.progress)}%
                      </span>
                    </div>
                  )}
                  {v.status === "failed" && v.error && (
                    <p className="text-xs text-destructive">{v.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
