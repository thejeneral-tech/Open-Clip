"use client";

import { Clapperboard, Loader2, RotateCcw, Star, Wand2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useSvBackgrounds,
  useSvCreateVideo,
  useSvMeta,
  useSvRetryVideo,
  useSvStories,
  useSvTemplates,
  useSvVideos,
  useSvVoicePresets,
  useSvVoices,
} from "@/hooks/use-api";
import { categoryLabel } from "@/lib/utils";
import type { SvTemplate, SvTemplateData, SvVideo, SvVoicePreset } from "@/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "processing", "rendering", "failed"]);
const PICKABLE_STATUSES = new Set(["new", "saved", "approved"]);

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Fish Speech (cloned) presets vs. plain SAPI system-voice presets. Prefer the
// explicit engine; fall back to sniffing the voice string for older rows.
function isClonedVoice(preset: SvVoicePreset): boolean {
  if (preset.engine) return preset.engine !== "sapi";
  return /clone|fish/i.test(preset.voice);
}

// One-line descriptor for a preset, mirroring the Presets page.
function templateTagline(t: SvTemplateData): string {
  const cap = t.captions || {};
  const style = cap.style === "pop" ? "Pop" : "Karaoke";
  const split = t.gameplay?.mode === "split_bottom" ? " · split" : "";
  return `${style} · ${cap.size || 80}px${split}`;
}

function TemplateBadge({ t }: { t: SvTemplate }) {
  if (t.is_default) {
    return (
      <Badge variant="success" className="gap-1">
        <Star className="h-3 w-3 fill-current" /> Default
      </Badge>
    );
  }
  if (t.builtin) return <Badge variant="secondary">Built-in</Badge>;
  return (
    <Badge variant="outline" className="border-primary/40 text-primary">
      Custom
    </Badge>
  );
}

function PipelineRow({ video }: { video: SvVideo }) {
  const retryVideo = useSvRetryVideo();
  const active = video.status === "queued" || video.status === "processing" || video.status === "rendering";

  const onRetry = async () => {
    try {
      await retryVideo.mutateAsync(video.id);
      toast.success("Video requeued");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry video");
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-1 text-sm font-medium">
          {video.title || video.story_title || `Video #${video.id}`}
        </p>
        <Badge variant={video.status === "failed" ? "destructive" : "secondary"}>{video.status}</Badge>
      </div>
      {active && (
        <div className="space-y-1">
          {video.stage && <p className="text-xs text-muted-foreground">{video.stage}</p>}
          <Progress value={video.progress * 100} />
        </div>
      )}
      {video.status === "failed" && (
        <div className="space-y-2">
          {video.error && <p className="line-clamp-2 text-xs text-destructive">{video.error}</p>}
          <Button variant="outline" size="sm" disabled={retryVideo.isPending} onClick={onRetry}>
            <RotateCcw className="h-4 w-4" /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function StudioInner() {
  const searchParams = useSearchParams();
  const storyParam = searchParams.get("story");
  const captionParam = searchParams.get("caption");
  const templateParam = searchParams.get("template");

  const { data: stories = [], isLoading: storiesLoading } = useSvStories({ status: undefined, sort: "score" });
  const { data: meta } = useSvMeta();
  const { data: voices = [] } = useSvVoices();
  const { data: videos = [] } = useSvVideos(undefined, true);
  const { data: templates = [] } = useSvTemplates();
  const { data: backgrounds = [] } = useSvBackgrounds();
  const { data: voicePresets = [] } = useSvVoicePresets();
  const createVideo = useSvCreateVideo();

  // Footage the user can pin to the gameplay layer — only ready clips with segments.
  const readyFootage = backgrounds.filter((b) => b.status === "completed" && b.segment_count > 0);

  // Cloned voices made in Voice Lab — selectable alongside the system SAPI voices.
  const clonedPresets = voicePresets.filter(isClonedVoice);

  const pickable = stories.filter((s) => PICKABLE_STATUSES.has(s.status));
  const pipeline = videos.filter((v) => ACTIVE_STATUSES.has(v.status));

  const [storyId, setStoryId] = useState(storyParam ?? "");
  const [duration, setDuration] = useState("60");
  const hookStyle = "conflict";
  const [voice, setVoice] = useState("auto");
  const [captionStyle, setCaptionStyle] = useState(captionParam || "modern_tiktok");
  const [backgroundCategory, setBackgroundCategory] = useState("any");
  const [footageId, setFootageId] = useState("auto");
  const [scriptEngine, setScriptEngine] = useState("auto");
  const [templateId, setTemplateId] = useState<number | null>(
    templateParam ? Number(templateParam) : null,
  );

  // Preselect the preset: the one passed in via ?template=, else the user's default.
  useEffect(() => {
    if (templates.length === 0) return;
    if (templateId !== null && templates.some((t) => t.id === templateId)) return;
    const def = templates.find((t) => t.is_default) ?? templates[0];
    setTemplateId(def.id);
  }, [templates, templateId]);

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  // Footage selection only applies to split-screen presets (gameplay fills the
  // bottom half); full-screen presets use the whole frame.
  const isSplitScreen = selectedTemplate?.data?.gameplay?.mode === "split_bottom";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storyId) return;
    try {
      await createVideo.mutateAsync({
        story_id: Number(storyId),
        duration_target: Number(duration),
        hook_style: hookStyle,
        voice: voice === "auto" ? undefined : voice,
        caption_style: captionStyle,
        background_category: backgroundCategory === "any" ? undefined : backgroundCategory,
        background_id: isSplitScreen && footageId !== "auto" ? Number(footageId) : undefined,
        script_engine: scriptEngine,
        template_id: templateId ?? undefined,
      });
      toast.success("Video queued — it will appear in Publishing when ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue video");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Video Studio</h1>
        <p className="text-muted-foreground">Turn a curated story into a narrated short-form video.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Create a video</CardTitle>
            <CardDescription>Pick a story and tune the narration, captions, and background.</CardDescription>
          </CardHeader>
          <CardContent>
            {storiesLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label>Story</Label>
                  <Select value={storyId} onValueChange={setStoryId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a story" />
                    </SelectTrigger>
                    <SelectContent>
                      {pickable.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {truncate(s.title)} · {Math.round(s.score)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {pickable.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No stories available — find some in the{" "}
                      <Link href="/storyvault/library" className="underline">
                        Story Library
                      </Link>
                      .
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Preset</Label>
                  <Select
                    value={templateId !== null ? String(templateId) : ""}
                    onValueChange={(v) => setTemplateId(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a preset" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedTemplate ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/60 bg-primary/5 px-4 py-3 ring-1 ring-primary/30">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-primary">{selectedTemplate.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {templateTagline(selectedTemplate.data)}
                        </div>
                      </div>
                      <TemplateBadge t={selectedTemplate} />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No presets yet — create one in{" "}
                      <Link href="/storyvault/presets" className="underline">
                        Presets
                      </Link>
                      .
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select value={duration} onValueChange={setDuration}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(meta?.durations ?? [60]).map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d}s
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Voice</Label>
                    <Select value={voice} onValueChange={setVoice}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        {clonedPresets.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Cloned voices (Fish Speech)</SelectLabel>
                            {clonedPresets.map((p) => (
                              <SelectItem key={`preset-${p.id}`} value={`preset:${p.id}`}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        <SelectGroup>
                          <SelectLabel>System voices</SelectLabel>
                          {voices.map((v) => (
                            <SelectItem key={v.name} value={v.name}>
                              {v.name}
                              {v.gender ? ` (${v.gender})` : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Caption style</Label>
                    <Select value={captionStyle} onValueChange={setCaptionStyle}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(meta?.caption_styles ?? ["modern_tiktok"]).map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Background</Label>
                    <Select
                      value={backgroundCategory}
                      onValueChange={setBackgroundCategory}
                      disabled={isSplitScreen && footageId !== "auto"}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any</SelectItem>
                        {(meta?.background_categories ?? []).map((b) => (
                          <SelectItem key={b} value={b}>
                            {categoryLabel(b)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {isSplitScreen && (
                    <div className="space-y-2">
                      <Label>Footage</Label>
                      <Select value={footageId} onValueChange={setFootageId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto (from category)</SelectItem>
                          {readyFootage.map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {truncate(b.original_filename || `Footage #${b.id}`, 32)} · {b.segment_count} seg
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {footageId !== "auto" && (
                        <p className="text-xs text-muted-foreground">
                          Gameplay segments come from this clip only.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>Script engine</Label>
                    <Select value={scriptEngine} onValueChange={setScriptEngine}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">AI with fallback</SelectItem>
                        <SelectItem value="ai">AI only</SelectItem>
                        <SelectItem value="heuristic">Instant, no AI</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button type="submit" disabled={!storyId || createVideo.isPending}>
                  {createVideo.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  Generate video
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Videos currently being generated.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pipeline.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Clapperboard className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Nothing processing.</p>
              </div>
            ) : (
              pipeline.map((v) => <PipelineRow key={v.id} video={v} />)
            )}
            <Link
              href="/storyvault/publishing"
              className="block text-sm text-muted-foreground hover:text-primary"
            >
              Go to publishing →
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function VideoStudioPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <StudioInner />
    </Suspense>
  );
}
