"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Film, Loader2, Play, Send } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ScoreRing } from "@/components/score-ring";
import { StatusBadge } from "@/components/status-badge";
import { WHOP_PLATFORMS } from "@/components/whop/platform-meta";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useExports, useWhopCreateSubmission } from "@/hooks/use-api";
import { useProgress } from "@/hooks/use-progress";
import { api } from "@/lib/api";
import type { Clip, Video, WhopCampaign, WhopPlatform } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

// 0-100 virality score → OpusClip-style letter grade.
export function scoreGrade(n: number): string {
  const s = Math.max(0, Math.min(100, n));
  if (s >= 93) return "A+";
  if (s >= 85) return "A";
  if (s >= 80) return "A-";
  if (s >= 75) return "B+";
  if (s >= 68) return "B";
  if (s >= 60) return "B-";
  if (s >= 45) return "C";
  return "D";
}

// Friendly pipeline label from a source video's status/stage/progress.
export function videoStageLabel(v: Video): string {
  const stage = (v.stage ?? "").toLowerCase();
  switch (v.status) {
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
    case "queued":
    case "pending":
      return "Downloading…";
    case "processing":
      if (stage.includes("transcribe") || stage.includes("transcript")) return "Transcribing…";
      if (stage.includes("detect") || stage.includes("viral") || stage.includes("score"))
        return "Finding viral moments…";
      if (stage.includes("render") || stage.includes("reframe") || stage.includes("caption"))
        return "Rendering clips…";
      if (stage.includes("ingest") || stage.includes("download")) return "Downloading…";
      return "Working…";
    default:
      return "Working…";
  }
}

// ------------------------------------------------------------- clip card
// Mirrors ClipCard visuals but is a <button> that opens the detail modal.
export function StudioClipCard({ clip, onOpen }: { clip: Clip; onOpen: (c: Clip) => void }) {
  const busy = clip.status === "processing" || clip.status === "queued";
  const live = useProgress("clip", busy ? clip.id : null, busy);
  const pct = Math.round((live?.progress ?? clip.progress ?? 0) * 100);
  const score = clip.ranking_score || clip.viral_score;

  return (
    <Card className="group flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => onOpen(clip)}
        className="relative block aspect-[9/16] bg-black text-left"
      >
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
      </button>

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

// ----------------------------------------------------------- detail modal
// The grade rows on the left rail map score_breakdown → four friendly labels.
const GRADE_ROWS: { label: string; key: keyof NonNullable<Clip["score_breakdown"]> }[] = [
  { label: "Hook", key: "hook_strength" },
  { label: "Flow", key: "retention_likelihood" },
  { label: "Value", key: "emotional_intensity" },
  { label: "Trend", key: "platform_suitability" },
];

export function ClipDetailModal({
  clip,
  campaign,
  open,
  onOpenChange,
  onSubmit,
}: {
  clip: Clip | null;
  campaign: WhopCampaign;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (clip: Clip) => void;
}) {
  // Poll the clip's exports so the "Download HD" button reflects render state.
  const { data: exports = [] } = useExports(clip?.id ?? 0, open && !!clip);
  const [downloading, setDownloading] = useState(false);

  const score = clip ? clip.ranking_score || clip.viral_score : 0;
  const breakdown = clip?.score_breakdown ?? {};
  const timeRange = clip
    ? `${formatDuration(clip.start_time)} – ${formatDuration(clip.end_time)}`
    : "";

  // The most recent completed 1080p mp4 export, if any (ready to open directly).
  const readyExport = useMemo(
    () =>
      exports.find((e) => e.status === "completed" && e.resolution === "1080p" && e.format === "mp4"),
    [exports],
  );

  const downloadHd = async () => {
    if (!clip) return;
    setDownloading(true);
    try {
      const exp = await api.createExport(clip.id, {
        format: "mp4",
        resolution: "1080p",
        aspect_ratio: clip.aspect_ratio,
        burn_captions: true,
      });
      // If it rendered synchronously, open now; otherwise the poll surfaces it.
      if (exp.status === "completed") {
        window.open(api.exportDownloadUrl(exp.id), "_blank");
      } else {
        toast.success("Rendering HD export… the download opens when it's ready.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  const hashtags = clip?.hashtags ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="line-clamp-1">{clip?.title || "Clip"}</DialogTitle>
          <DialogDescription>Review the clip, then submit it to {campaign.name}.</DialogDescription>
        </DialogHeader>

        {clip && (
          <div className="grid gap-4 lg:grid-cols-[auto_1fr_1fr]">
            {/* Left rail: score + grade breakdown */}
            <div className="flex flex-col items-center gap-3 lg:w-32">
              <ScoreRing score={score} size={72} label="score" />
              <div className="w-full space-y-1.5">
                {GRADE_ROWS.map((row) => {
                  const value = breakdown[row.key];
                  return (
                    <div key={row.key} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-semibold">
                        {typeof value === "number" ? scoreGrade(value) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Center: player */}
            <div className="space-y-2">
              {clip.preview_path ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={clip.preview_path}
                  controls
                  className="aspect-[9/16] w-full rounded-lg bg-black"
                />
              ) : (
                <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg bg-black text-center text-sm text-muted-foreground">
                  Preview still rendering…
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {formatDuration(clip.duration)} · {timeRange}
              </p>
            </div>

            {/* Right: scene analysis */}
            <div className="min-w-0 space-y-3">
              <h4 className="text-sm font-semibold">Scene analysis</h4>
              {clip.reasoning ? (
                <p className="text-sm text-muted-foreground">{clip.reasoning}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No analysis available.</p>
              )}
              {clip.transcript_text && (
                <div className="max-h-64 overflow-y-auto rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                  {clip.transcript_text}
                </div>
              )}
              {hashtags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {hashtags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      #{tag.replace(/^#/, "")}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {clip && readyExport ? (
              <Button asChild variant="secondary">
                <a href={api.exportDownloadUrl(readyExport.id)} target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4" /> Download HD
                </a>
              </Button>
            ) : (
              <Button variant="secondary" onClick={downloadHd} disabled={!clip || downloading}>
                {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download HD
              </Button>
            )}
            {clip && (
              <Button asChild variant="outline">
                <Link href={`/clips/${clip.id}`}>
                  <ExternalLink className="h-4 w-4" /> Edit clip
                </Link>
              </Button>
            )}
          </div>
          <Button onClick={() => clip && onSubmit(clip)} disabled={!clip}>
            <Send className="h-4 w-4" /> Submit to campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------- submit dialog
export function SubmitClipDialog({
  clip,
  campaign,
  open,
  onOpenChange,
}: {
  clip: Clip | null;
  campaign: WhopCampaign;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const createSubmission = useWhopCreateSubmission();
  const defaultPlatform: WhopPlatform = campaign.platforms[0] ?? "tiktok";

  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<WhopPlatform>(defaultPlatform);
  const [postUrl, setPostUrl] = useState("");
  const [views, setViews] = useState("0");
  const [notes, setNotes] = useState("");

  // Reset the form whenever a new clip opens the dialog.
  const [seedClipId, setSeedClipId] = useState<number | null>(null);
  if (open && clip && clip.id !== seedClipId) {
    setSeedClipId(clip.id);
    setTitle(clip.title ?? "");
    setPlatform(campaign.platforms[0] ?? "tiktok");
    setPostUrl("");
    setViews("0");
    setNotes("");
  }

  const submit = async () => {
    if (!postUrl.trim()) {
      toast.error("Add the link to your posted clip.");
      return;
    }
    try {
      await createSubmission.mutateAsync({
        campaignId: campaign.id,
        data: {
          platform,
          post_url: postUrl.trim(),
          title: title.trim() || null,
          views: Number(views) || 0,
          notes: notes.trim() || null,
        },
      });
      toast.success("Submitted to campaign");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Submission failed");
    }
  };

  const busy = createSubmission.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Submit to {campaign.name}</DialogTitle>
          <DialogDescription>Paste the link to your posted clip once it&apos;s live.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="submit-title">Title</Label>
            <Input
              id="submit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Clip title"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as WhopPlatform)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {WHOP_PLATFORMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="submit-url">Post URL</Label>
            <Input
              id="submit-url"
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              placeholder="https://www.tiktok.com/@you/video/… (your posted clip)"
            />
            <p className="text-xs text-muted-foreground">
              Paste the link to your posted clip once it&apos;s live.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="submit-views">Views</Label>
            <Input
              id="submit-views"
              type="number"
              min={0}
              value={views}
              onChange={(e) => setViews(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="submit-notes">Notes</Label>
            <Textarea
              id="submit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the reviewer should know (optional)"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            <Send className="h-4 w-4" /> Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
