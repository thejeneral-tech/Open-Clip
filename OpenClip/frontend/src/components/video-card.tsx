"use client";

import { Film, MoreVertical, Play, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ProcessDialog } from "@/components/process-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { useDeleteVideo } from "@/hooks/use-api";
import { useProgress } from "@/hooks/use-progress";
import type { Video } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

export function VideoCard({ video, projectId }: { video: Video; projectId: number }) {
  const deleteVideo = useDeleteVideo(projectId);
  const [processOpen, setProcessOpen] = useState(false);
  const isBusy = video.status === "processing" || video.status === "queued";
  const live = useProgress("video", isBusy ? video.id : null, isBusy);

  const pct = Math.round((live?.progress ?? video.progress ?? 0) * 100);
  const ingesting = (video.stage ?? "").match(/upload|download|ingest/) && !video.duration_seconds;
  const canProcess = !isBusy && !!video.duration_seconds;

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="relative aspect-video bg-muted">
        {video.thumbnail_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumbnail_path} alt={video.title ?? "video"} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        {video.duration_seconds ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
            {formatDuration(video.duration_seconds)}
          </span>
        ) : null}
        <div className="absolute left-2 top-2">
          <StatusBadge status={video.status} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 flex-1 text-sm font-medium" title={video.title ?? undefined}>
            {video.title || video.original_filename || `Video #${video.id}`}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive"
                onClick={async () => {
                  if (confirm("Delete this video and its clips?")) {
                    await deleteVideo.mutateAsync(video.id);
                    toast.success("Video deleted");
                  }
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isBusy ? (
          <div className="space-y-1.5">
            <Progress value={pct} />
            <p className="truncate text-xs text-muted-foreground">
              {live?.message || video.stage || "Working…"} · {pct}%
            </p>
          </div>
        ) : video.status === "failed" ? (
          <p className="line-clamp-2 text-xs text-destructive">{video.error || "Processing failed"}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {video.clip_count} clips{ingesting ? " · ingesting…" : ""}
          </p>
        )}

        <div className="mt-auto flex gap-2 pt-2">
          {video.clip_count > 0 && (
            <Button asChild variant="secondary" size="sm" className="flex-1">
              <Link href={`/videos/${video.id}`}>
                <Play className="h-3.5 w-3.5" /> Clips
              </Link>
            </Button>
          )}
          <Button size="sm" className="flex-1" disabled={!canProcess} onClick={() => setProcessOpen(true)}>
            <Sparkles className="h-3.5 w-3.5" />
            {video.clip_count > 0 ? "Reprocess" : "Generate"}
          </Button>
        </div>
      </div>

      <ProcessDialog videoId={video.id} open={processOpen} onOpenChange={setProcessOpen} />
    </Card>
  );
}
