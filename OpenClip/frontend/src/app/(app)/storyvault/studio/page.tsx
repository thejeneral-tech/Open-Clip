"use client";

import { Clapperboard, Loader2, RotateCcw, Save, Star, Wand2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CaptionControls, useCaptionEditor } from "@/components/storyvault/caption-generator";
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
  useSvCloneStatus,
  useSvCreateVideo,
  useSvMeta,
  useSvProjects,
  useSvRetryVideo,
  useSvStories,
  useSvTemplates,
  useSvVideos,
  useSvVoicePresets,
  useSvVoices,
} from "@/hooks/use-api";
import { PhonePreview, type PreviewPhase, type PreviewStory } from "@/components/storyvault/template-preview";
import { categoryLabel } from "@/lib/utils";
import type { SvProject, SvTemplate, SvTemplateData, SvVideo, SvVoicePreset } from "@/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "processing", "rendering", "failed"]);
const PICKABLE_STATUSES = new Set(["new", "saved", "approved"]);

// Captions are styled per-preset in the Captions editor below; the render still
// needs a base caption_style string, so send the prior default unconditionally.
const DEFAULT_CAPTION_STYLE = "modern_tiktok";

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

// The intro beats the render burns in, in play order, with their chip labels.
const PHASE_LABEL: Record<PreviewPhase, string> = {
  topic: "Reddit card",
  author: "Author intro",
  caption: "Captions",
};

// Renders the phone preview scaled to fully fit the space it's given (by height,
// capped by width) so the whole 9:16 frame is always visible without clipping or
// scrolling, however tall the column is. It also cycles through the intro beats
// the render burns in — Reddit card → "Posted by u/…" → captions — drawing the
// selected story's real data so the preview matches the exported video.
function PreviewPane({ data, story }: { data: SvTemplateData; story: PreviewStory | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(240);
  const aspect = ((data.canvas?.width ?? 1080) / (data.canvas?.height ?? 1920));
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const byHeight = el.clientHeight * aspectRef.current;
      const fit = Math.min(el.clientWidth, byHeight, 360);
      setWidth(Math.max(120, Math.floor(fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const phases: PreviewPhase[] = [];
  if (data.topicCard?.enabled !== false) phases.push("topic");
  if (data.authorIntro?.enabled !== false) phases.push("author");
  if (data.captions?.enabled !== false) phases.push("caption");
  if (phases.length === 0) phases.push("caption");

  // Manual beat selection via the chips below — no auto-cycling. Reset to the
  // first beat when the set of beats changes (e.g. switching presets).
  const [idx, setIdx] = useState(0);
  const phaseKey = phases.join(",");
  useEffect(() => {
    setIdx(0);
  }, [phaseKey]);
  const phase = phases[Math.min(idx, phases.length - 1)];

  return (
    <>
      <div ref={ref} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div key={phase} className="animate-in fade-in duration-500">
          <PhonePreview t={data} width={width} story={story} phase={phase} />
        </div>
      </div>
      {phases.length > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2">
          {phases.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => setIdx(i)}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${
                p === phase ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${p === phase ? "bg-primary" : "bg-muted-foreground/40"}`} />
              {PHASE_LABEL[p]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function StudioInner() {
  const searchParams = useSearchParams();
  const storyParam = searchParams.get("story");
  const templateParam = searchParams.get("template");
  const projectParam = searchParams.get("project");

  const { data: stories = [], isLoading: storiesLoading } = useSvStories({ status: undefined, sort: "score" });
  const { data: meta } = useSvMeta();
  const { data: voices = [] } = useSvVoices();
  const { data: videos = [] } = useSvVideos(undefined, true);
  const { data: templates = [] } = useSvTemplates();
  const { data: backgrounds = [] } = useSvBackgrounds();
  const { data: voicePresets = [] } = useSvVoicePresets();
  const { data: projects = [] } = useSvProjects();
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
  // Base caption style for the render. No longer a visible control — the preset's
  // caption config (edited below) drives the look — but a project recipe can still
  // carry one, so it's kept in state and sent with the request.
  const [captionStyle, setCaptionStyle] = useState(DEFAULT_CAPTION_STYLE);
  const [backgroundCategory, setBackgroundCategory] = useState("any");
  const [footageId, setFootageId] = useState("auto");
  const [scriptEngine, setScriptEngine] = useState("auto");
  const [templateId, setTemplateId] = useState<number | null>(
    templateParam ? Number(templateParam) : null,
  );
  const [projectId, setProjectId] = useState(projectParam ?? "none");

  // A cloned (Fish Speech) voice is selected as "preset:<id>"; its engine must be
  // running to generate. Poll its status only while one is picked, so the studio
  // shows the choice is recognized — and warns early if the server is offline.
  const selectedIsClone = voice.startsWith("preset:");
  const { data: cloneStatus } = useSvCloneStatus(selectedIsClone);

  // Pull a project's saved recipe into the form so the whole thing is pre-filled.
  const applyProject = (p: SvProject) => {
    setProjectId(String(p.id));
    const s = p.settings;
    setDuration(String(s.duration_target));
    setVoice(s.voice ?? "auto");
    setCaptionStyle(s.caption_style);
    setBackgroundCategory(s.background_category ?? "any");
    setFootageId(s.background_id != null ? String(s.background_id) : "auto");
    setScriptEngine(s.script_engine);
    if (s.template_id != null) setTemplateId(s.template_id);
  };

  const onProjectChange = (value: string) => {
    if (value === "none") {
      setProjectId("none");
      return;
    }
    const p = projects.find((proj) => proj.id === Number(value));
    if (p) applyProject(p);
  };

  // When arriving via ?project=, auto-fill once the projects load.
  useEffect(() => {
    if (projectParam && projectId === projectParam) {
      const p = projects.find((proj) => proj.id === Number(projectParam));
      if (p && duration === "60") applyProject(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

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
  // The story whose real text/handle/counts the preview card should show.
  const selectedStory = stories.find((s) => String(s.id) === storyId) ?? null;
  // Caption-editing state for the selected preset, shared by the controls (under
  // the form) and the live preview (right column).
  const capEditor = useCaptionEditor(selectedTemplate);

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
        project_id: projectId !== "none" ? Number(projectId) : undefined,
      });
      toast.success("Video queued — it will appear in Publishing when ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue video");
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4 lg:p-5">
      <div className="shrink-0">
        <h1 className="text-xl font-bold tracking-tight">Video Studio</h1>
        <p className="text-sm text-muted-foreground">Turn a curated story into a narrated short-form video.</p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="shrink-0 pb-3">
            <CardTitle>Create a video</CardTitle>
            <CardDescription>Pick a story and tune the narration and background.</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {storiesLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
              <form id="sv-create" onSubmit={onSubmit} className="space-y-3">
                {projects.length > 0 && (
                  <div className="space-y-2">
                    <Label>Project</Label>
                    <Select value={projectId} onValueChange={onProjectChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="No project" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No project</SelectItem>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {projectId !== "none" && (
                      <p className="text-xs text-muted-foreground">
                        Settings below are pre-filled from this project. Tweak any of them before
                        generating.
                      </p>
                    )}
                  </div>
                )}

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

                <div className="grid gap-3 sm:grid-cols-2">
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
                    {selectedIsClone && (
                      <p className="flex items-center gap-1.5 text-xs">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            cloneStatus?.reachable ? "bg-emerald-500" : "bg-amber-500"
                          }`}
                        />
                        <span className="text-muted-foreground">
                          {cloneStatus?.reachable
                            ? "Cloned voice — narration runs on the Fish Speech server."
                            : "Fish Speech server is offline — start it (Voice Lab shows its status), or this video will fail."}
                        </span>
                      </p>
                    )}
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
              </form>

              {selectedTemplate && (
                <div className="space-y-3 border-t pt-4">
                  <div>
                    <h3 className="text-sm font-semibold tracking-tight">Captions</h3>
                    <p className="text-xs text-muted-foreground">
                      Edits apply to {selectedTemplate.name}.
                    </p>
                  </div>
                  <CaptionControls editor={capEditor} />
                </div>
              )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col gap-4">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0 pb-3">
            <CardTitle>Preview</CardTitle>
            <CardDescription>How the selected preset renders, with your caption edits.</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 pb-4">
            {selectedTemplate && capEditor.editedData ? (
              <>
                <PreviewPane data={capEditor.editedData} story={selectedStory} />
                <p className="shrink-0 text-center text-xs text-muted-foreground">
                  Live preview — tap a beat to see the intro card, author intro, or captions
                  {selectedStory ? " for the selected story" : ""}.
                </p>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Clapperboard className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Pick a preset to preview it.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shrink-0">
          <CardHeader className="pb-3">
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Videos currently being generated.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-44 space-y-3 overflow-y-auto">
            {pipeline.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Clapperboard className="h-7 w-7 text-muted-foreground" />
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

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-3">
        <Button
          type="submit"
          form="sv-create"
          disabled={!storyId || createVideo.isPending}
          className="disabled:opacity-80"
        >
          {createVideo.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="h-4 w-4" />
          )}
          Generate video
        </Button>
        {selectedTemplate && (
          <div className="flex items-center overflow-hidden rounded-md border border-input bg-background shadow-sm">
            <Button
              variant="ghost"
              onClick={() => capEditor.save()}
              disabled={!capEditor.dirty || capEditor.saving}
              className="rounded-none"
            >
              {capEditor.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
            <div className="h-5 w-px shrink-0 bg-border" />
            <Button
              variant="ghost"
              onClick={capEditor.reset}
              disabled={!capEditor.dirty}
              className="rounded-none"
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
          </div>
        )}
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
