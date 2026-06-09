"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Copy,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CaptionEditor } from "@/components/clip-editor/caption-editor";
import { ExportPanel } from "@/components/clip-editor/export-panel";
import { ScoreRing } from "@/components/score-ring";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useClip, useUpdateClip } from "@/hooks/use-api";
import { useProgress } from "@/hooks/use-progress";
import { api } from "@/lib/api";
import type { AspectRatio, CaptionStyle } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

const SCORE_DIMS = [
  ["hook_strength", "Hook strength"],
  ["emotional_intensity", "Emotional intensity"],
  ["curiosity_gap", "Curiosity gap"],
  ["retention_likelihood", "Retention"],
  ["platform_suitability", "Platform fit"],
] as const;

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success("Copied");
}

export default function ClipEditorPage() {
  const params = useParams();
  const clipId = Number(params.id);
  const qc = useQueryClient();
  const { data: clip, isLoading } = useClip(clipId);
  const update = useUpdateClip();

  // Subscribe to clip progress for the whole session so regenerate/render
  // jobs surface immediately even if the cached clip still reads "completed".
  const live = useProgress("clip", clipId, true);
  const busy =
    clip?.status === "processing" ||
    clip?.status === "queued" ||
    live?.status === "processing" ||
    live?.status === "queued";

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [style, setStyle] = useState<CaptionStyle>("hormozi");
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (clip) {
      setStart(clip.start_time);
      setEnd(clip.end_time);
      setAspect(clip.aspect_ratio);
      setStyle(clip.caption_style);
      setTitle(clip.title ?? "");
    }
  }, [clip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (live?.status === "completed" || live?.status === "failed") {
      qc.invalidateQueries({ queryKey: ["clip", clipId] });
    }
  }, [live?.status, clipId, qc]);

  if (isLoading || !clip) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const saveEdits = async () => {
    if (end <= start) {
      toast.error("End must be after start");
      return;
    }
    try {
      await update.mutateAsync({
        id: clip.id,
        data: { start_time: start, end_time: end, aspect_ratio: aspect, caption_style: style, title },
      });
      toast.success("Saved — re-rendering preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  const regenerate = async (key: string) => {
    try {
      await api.regenerateClip(clip.id, { [key]: true });
      toast.success("Regenerating…");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  const pct = Math.round((live?.progress ?? clip.progress ?? 0) * 100);
  const aspectClass =
    aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : aspect === "4:5" ? "aspect-[4/5]" : "aspect-video";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Link
        href={`/videos/${clip.video_id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to clips
      </Link>

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_1fr]">
        {/* ---- Player + trim controls ---- */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className={`relative ${aspectClass} bg-black`}>
              {clip.preview_path ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video key={clip.preview_path} src={clip.preview_path} controls className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No preview yet
                </div>
              )}
              {busy && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60">
                  <Loader2 className="h-6 w-6 animate-spin text-white" />
                  <span className="text-xs text-white">{live?.message || "Rendering"} · {pct}%</span>
                  <Progress value={pct} className="w-3/4" />
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Edit</span>
                <StatusBadge status={clip.status} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="title">Title</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start (s)</Label>
                  <Input type="number" step="0.1" value={start.toFixed(1)} onChange={(e) => setStart(parseFloat(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label>End (s)</Label>
                  <Input type="number" step="0.1" value={end.toFixed(1)} onChange={(e) => setEnd(parseFloat(e.target.value))} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Duration: {formatDuration(end - start)}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Aspect</Label>
                  <Select value={aspect} onValueChange={(v) => setAspect(v as AspectRatio)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["9:16", "1:1", "4:5", "16:9"] as AspectRatio[]).map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Caption style</Label>
                  <Select value={style} onValueChange={(v) => setStyle(v as CaptionStyle)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["hormozi", "modern_tiktok", "minimal", "gaming", "podcast"] as CaptionStyle[]).map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button className="w-full" onClick={saveEdits} disabled={update.isPending || busy}>
                {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save & re-render
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* ---- Tabs ---- */}
        <Card>
          <CardContent className="p-4">
            <Tabs defaultValue="captions">
              <TabsList className="flex w-full flex-wrap">
                <TabsTrigger value="captions">Captions</TabsTrigger>
                <TabsTrigger value="score">Score</TabsTrigger>
                <TabsTrigger value="titles">Titles</TabsTrigger>
                <TabsTrigger value="description">Description</TabsTrigger>
                <TabsTrigger value="broll">B-roll</TabsTrigger>
                <TabsTrigger value="export">Export</TabsTrigger>
              </TabsList>

              <TabsContent value="captions" className="pt-4">
                <CaptionEditor clip={clip} />
              </TabsContent>

              <TabsContent value="score" className="space-y-4 pt-4">
                <div className="flex items-center gap-6">
                  <ScoreRing score={clip.ranking_score || clip.viral_score} size={84} label="score" />
                  <div className="space-y-1 text-sm">
                    <div>Viral estimate: <b>{Math.round(clip.viral_score)}</b></div>
                    <div>Confidence: <b>{Math.round(clip.confidence)}%</b></div>
                    <Button size="sm" variant="outline" onClick={() => regenerate("rerank")}>
                      <RefreshCw className="h-3.5 w-3.5" /> Re-score
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {SCORE_DIMS.map(([key, label]) => {
                    const v = Math.round((clip.score_breakdown?.[key] as number) ?? 0);
                    return (
                      <div key={key} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span>{label}</span>
                          <span className="text-muted-foreground">{v}</span>
                        </div>
                        <Progress value={v} />
                      </div>
                    );
                  })}
                </div>
                {clip.score_breakdown?.explanation && (
                  <p className="rounded-lg bg-muted p-3 text-sm">{clip.score_breakdown.explanation}</p>
                )}
                {clip.reasoning && (
                  <p className="text-sm text-muted-foreground"><b>Why this clip:</b> {clip.reasoning}</p>
                )}
              </TabsContent>

              <TabsContent value="titles" className="space-y-2 pt-4">
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => regenerate("regenerate_titles")}>
                    <Sparkles className="h-3.5 w-3.5" /> Regenerate
                  </Button>
                </div>
                {(clip.title_variations ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No title variations yet.</p>
                ) : (
                  clip.title_variations.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                      <span>{t}</span>
                      <div className="flex shrink-0 gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(t)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => update.mutate({ id: clip.id, data: { title: t } })}
                        >
                          Use
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </TabsContent>

              <TabsContent value="description" className="space-y-3 pt-4">
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => regenerate("regenerate_description")}>
                    <Sparkles className="h-3.5 w-3.5" /> Regenerate
                  </Button>
                </div>
                {clip.description ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label>Description</Label>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(clip.description!)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="rounded-lg bg-muted p-3 text-sm">{clip.description}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No description yet.</p>
                )}
                {clip.hashtags?.length > 0 && (
                  <div className="space-y-1">
                    <Label>Hashtags</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {clip.hashtags.map((h, i) => (
                        <Badge key={i} variant="secondary" className="cursor-pointer" onClick={() => copy(h)}>
                          {h}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {clip.keywords?.length > 0 && (
                  <div className="space-y-1">
                    <Label>Keywords</Label>
                    <p className="text-sm text-muted-foreground">{clip.keywords.join(", ")}</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="broll" className="space-y-2 pt-4">
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => regenerate("regenerate_broll")}>
                    <Sparkles className="h-3.5 w-3.5" /> Regenerate
                  </Button>
                </div>
                {(clip.broll_suggestions ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No B-roll suggestions yet.</p>
                ) : (
                  clip.broll_suggestions.map((b, i) => (
                    <div key={i} className="rounded-lg border p-3 text-sm">
                      <div className="font-medium">
                        {formatDuration(b.start)} – {formatDuration(b.end)}
                      </div>
                      <p className="text-muted-foreground">{b.scene_description}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {b.search_terms.map((s, j) => (
                          <Badge key={j} variant="outline">{s}</Badge>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </TabsContent>

              <TabsContent value="export" className="pt-4">
                <ExportPanel clipId={clip.id} defaultAspect={clip.aspect_ratio} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
