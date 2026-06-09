"use client";

import { Film, Play } from "lucide-react";
import Link from "next/link";
import { ScoreRing } from "@/components/score-ring";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useProgress } from "@/hooks/use-progress";
import type { Clip } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

export function ClipCard({ clip }: { clip: Clip }) {
  const busy = clip.status === "processing" || clip.status === "queued";
  const live = useProgress("clip", busy ? clip.id : null, busy);
  const pct = Math.round((live?.progress ?? clip.progress ?? 0) * 100);
  const score = clip.ranking_score || clip.viral_score;

  return (
    <Card className="group flex flex-col overflow-hidden">
      <Link href={`/clips/${clip.id}`} className="relative block aspect-[9/16] bg-black">
        {clip.thumbnail_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={clip.thumbnail_path} alt={clip.title ?? "clip"} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90">
            <Play className="h-5 w-5 fill-black text-black" />
          </div>
        </div>
        <div className="absolute right-2 top-2">
          <ScoreRing score={score} size={44} />
        </div>
        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
          {formatDuration(clip.duration)}
        </span>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-sm font-medium" title={clip.title ?? undefined}>
          {clip.title || `Clip #${clip.id}`}
        </h3>
        {busy ? (
          <div className="space-y-1">
            <Progress value={pct} />
            <p className="truncate text-xs text-muted-foreground">{live?.message || clip.status} · {pct}%</p>
          </div>
        ) : (
          <div className="mt-auto flex items-center justify-between">
            <StatusBadge status={clip.status} />
            {clip.confidence > 0 && (
              <span className="text-xs text-muted-foreground">{Math.round(clip.confidence)}% conf.</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
