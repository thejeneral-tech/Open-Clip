"use client";

import { ArrowLeft, Loader2, Scissors, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ClipCard } from "@/components/clip-card";
import { ProcessDialog } from "@/components/process-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useClips, useVideo } from "@/hooks/use-api";
import { useProgress } from "@/hooks/use-progress";
import { formatDuration } from "@/lib/utils";

export default function VideoClipsPage() {
  const params = useParams();
  const videoId = Number(params.id);
  const [sort, setSort] = useState<"score" | "time">("score");
  const [processOpen, setProcessOpen] = useState(false);

  const { data: video } = useVideo(videoId, true);
  const busy = video?.status === "processing" || video?.status === "queued";
  const { data: clips = [], isLoading } = useClips(videoId, sort, busy);
  const live = useProgress("video", busy ? videoId : null, busy);
  const pct = Math.round((live?.progress ?? video?.progress ?? 0) * 100);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        {video && (
          <Link
            href={`/projects/${video.project_id}`}
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to project
          </Link>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{video?.title || "Clips"}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {video && <StatusBadge status={video.status} />}
              {video?.duration_seconds ? <span>{formatDuration(video.duration_seconds)}</span> : null}
              <span>· {clips.length} clips</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setSort(v as "score" | "time")}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score">Top scored</SelectItem>
                <SelectItem value="time">Chronological</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setProcessOpen(true)} disabled={busy}>
              <Sparkles className="h-4 w-4" /> {clips.length ? "Reprocess" : "Generate"}
            </Button>
          </div>
        </div>
      </div>

      {busy && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {live?.message || "Processing…"}
              </span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <Progress value={pct} />
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : clips.length === 0 && !busy ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Scissors className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No clips yet. Generate clips to populate this view.</p>
            <Button onClick={() => setProcessOpen(true)}>
              <Sparkles className="h-4 w-4" /> Generate clips
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {clips.map((c) => (
            <ClipCard key={c.id} clip={c} />
          ))}
        </div>
      )}

      <ProcessDialog videoId={videoId} open={processOpen} onOpenChange={setProcessOpen} />
    </div>
  );
}
