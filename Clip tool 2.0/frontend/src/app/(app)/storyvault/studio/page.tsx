"use client";

import { Clapperboard, Loader2, RotateCcw, Wand2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  useSvCreateVideo,
  useSvMeta,
  useSvRetryVideo,
  useSvStories,
  useSvVideos,
  useSvVoices,
} from "@/hooks/use-api";
import type { SvVideo } from "@/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "processing", "rendering", "failed"]);
const PICKABLE_STATUSES = new Set(["new", "saved", "approved"]);

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

  const { data: stories = [], isLoading: storiesLoading } = useSvStories({ status: undefined, sort: "score" });
  const { data: meta } = useSvMeta();
  const { data: voices = [] } = useSvVoices();
  const { data: videos = [] } = useSvVideos(undefined, true);
  const createVideo = useSvCreateVideo();

  const pickable = stories.filter((s) => PICKABLE_STATUSES.has(s.status));
  const pipeline = videos.filter((v) => ACTIVE_STATUSES.has(v.status));

  const [storyId, setStoryId] = useState(storyParam ?? "");
  const [duration, setDuration] = useState("60");
  const [hookStyle, setHookStyle] = useState("conflict");
  const [narrationStyle, setNarrationStyle] = useState("dramatic");
  const [dramaLevel, setDramaLevel] = useState(3);
  const [voice, setVoice] = useState("auto");
  const [speed, setSpeed] = useState(1.0);
  const [captionStyle, setCaptionStyle] = useState("hormozi");
  const [backgroundCategory, setBackgroundCategory] = useState("any");
  const [scriptEngine, setScriptEngine] = useState("auto");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storyId) return;
    try {
      await createVideo.mutateAsync({
        story_id: Number(storyId),
        duration_target: Number(duration),
        hook_style: hookStyle,
        narration_style: narrationStyle,
        drama_level: dramaLevel,
        voice: voice === "auto" ? undefined : voice,
        speed,
        caption_style: captionStyle,
        background_category: backgroundCategory === "any" ? undefined : backgroundCategory,
        script_engine: scriptEngine,
      });
      toast.success("Video queued — it will land in the Review Queue");
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
                    <Label>Hook style</Label>
                    <Select value={hookStyle} onValueChange={setHookStyle}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(meta?.hook_styles ?? ["conflict"]).map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Narration style</Label>
                    <Select value={narrationStyle} onValueChange={setNarrationStyle}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(meta?.narration_styles ?? ["dramatic"]).map((n) => (
                          <SelectItem key={n} value={n}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Drama level: {dramaLevel}</Label>
                    <Slider
                      min={1}
                      max={5}
                      step={1}
                      value={[dramaLevel]}
                      onValueChange={([v]) => setDramaLevel(v)}
                      className="py-2"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Voice</Label>
                    <Select value={voice} onValueChange={setVoice}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        {voices.map((v) => (
                          <SelectItem key={v.name} value={v.name}>
                            {v.name}
                            {v.gender ? ` (${v.gender})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Speed: ×{speed.toFixed(2)}</Label>
                    <Slider
                      min={0.7}
                      max={1.4}
                      step={0.05}
                      value={[speed]}
                      onValueChange={([v]) => setSpeed(v)}
                      className="py-2"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Caption style</Label>
                    <Select value={captionStyle} onValueChange={setCaptionStyle}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(meta?.caption_styles ?? ["hormozi"]).map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Background</Label>
                    <Select value={backgroundCategory} onValueChange={setBackgroundCategory}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any</SelectItem>
                        {(meta?.background_categories ?? []).map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
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
              href="/storyvault/review"
              className="block text-sm text-muted-foreground hover:text-primary"
            >
              Go to review queue →
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
