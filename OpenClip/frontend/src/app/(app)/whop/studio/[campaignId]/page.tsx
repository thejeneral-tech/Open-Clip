"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Film,
  FlaskConical,
  Link as LinkIcon,
  Loader2,
  Megaphone,
  MoreVertical,
  Scissors,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditingOptionsPanel, MatchCard } from "@/components/whop/finder-shared";
import {
  FormulaCard,
  FormulaInline,
  FormulaReportModal,
} from "@/components/whop/formula-shared";
import { PlatformIcons, RatePill } from "@/components/whop/platform-meta";
import {
  ClipDetailModal,
  StudioClipCard,
  SubmitClipDialog,
  videoStageLabel,
} from "@/components/whop/studio-shared";
import {
  useClips,
  useModels,
  useProcessVideo,
  useVideos,
  useWhopCampaign,
  useWhopCreateFormula,
  useWhopDeleteFormula,
  useWhopEnsureStudio,
  useWhopFindVideos,
  useWhopFormulas,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import type {
  Clip,
  ProcessOptions,
  Video,
  WhopCampaign,
  WhopFormula,
  WhopVideoMatch,
} from "@/lib/types";

// -------------------------------------------------------------- clips grid
// A child component so useClips isn't called inside a loop over videos.
function VideoClips({ video, onOpen }: { video: Video; onOpen: (c: Clip) => void }) {
  const busy = video.status === "processing" || video.status === "queued";
  const { data: clips = [], isLoading } = useClips(video.id, "score", true);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (clips.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {clips.map((c) => (
        <StudioClipCard key={c.id} clip={c} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ---------------------------------------------------- one source video row
// A source video and everything made from it — clips + formula — together, so
// the results feed reads as one thing per video instead of split-by-type lists.
function WorkspaceVideo({
  video,
  formula,
  awaitingClips,
  awaitingFormula,
  onOpenClip,
  onGenerateClips,
  onBuildFormula,
  onOpenFormula,
  onRetryFormula,
}: {
  video: Video;
  formula: WhopFormula | null;
  awaitingClips: boolean;
  awaitingFormula: boolean;
  onOpenClip: (c: Clip) => void;
  onGenerateClips: (v: Video) => void;
  onBuildFormula: (v: Video) => void;
  onOpenFormula: (f: WhopFormula) => void;
  onRetryFormula: (f: WhopFormula) => void;
}) {
  const busy = video.status === "processing" || video.status === "queued";
  const pct = Math.round((video.progress || 0) * 100);
  const ready = video.status === "completed";

  // Manual fallbacks / cross-outputs, offered once the video is ready. Don't
  // offer Build formula while a clip run is queued — let clips finish first so
  // the formula reuses that transcript instead of racing a second one.
  const canGenerateClips = ready && video.clip_count === 0 && !awaitingClips;
  const canBuildFormula = ready && !formula && !awaitingFormula && !awaitingClips;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {video.title || `Source video #${video.id}`}
        </h3>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          <span>{videoStageLabel(video)}</span>
        </div>
        {canGenerateClips && (
          <Button size="sm" variant="outline" onClick={() => onGenerateClips(video)}>
            <Scissors className="h-4 w-4" /> Make clips
          </Button>
        )}
        {canBuildFormula && (
          <Button size="sm" variant="outline" onClick={() => onBuildFormula(video)}>
            <FlaskConical className="h-4 w-4" /> Build formula
          </Button>
        )}
      </div>

      {busy && <Progress value={pct} />}
      {video.status === "failed" && video.error && (
        <p className="text-sm text-destructive">{video.error}</p>
      )}

      {(formula || awaitingFormula) &&
        (formula ? (
          <FormulaInline formula={formula} onOpen={onOpenFormula} onRetry={onRetryFormula} />
        ) : (
          <div className="flex items-center gap-3 rounded-lg border bg-card p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
            Formula queued — starts once this video is ready…
          </div>
        ))}

      <VideoClips video={video} onOpen={onOpenClip} />
    </div>
  );
}

// A small selectable output pill (Clips / Formula) for the composer.
function OutputChip({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Scissors;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-secondary text-muted-foreground hover:text-foreground"
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
          active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
        }`}
      >
        {active ? "✓" : ""}
      </span>
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

export default function WhopStudioCampaignPage() {
  const params = useParams();
  const campaignId = Number(params.campaignId);
  const qc = useQueryClient();

  const { data: campaign } = useWhopCampaign(campaignId, true);
  const ensureStudio = useWhopEnsureStudio();
  const { data: models = [] } = useModels();
  // Prefer a real text model for clip analysis — skip vision-only tags (moondream/llava)
  // and tiny 0.5B models that give weak results.
  const defaultModel =
    models.find((m) => !/(moondream|llava|bakllava|vision|-vl|minicpm-v|:0\.5|0\.5b)/i.test(m.name))
      ?.name ?? models[0]?.name;

  const [projectId, setProjectId] = useState<number | null>(null);

  // Ensure the campaign has a workspace project — fires exactly once.
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (ensuredRef.current || !campaignId) return;
    ensuredRef.current = true;
    ensureStudio
      .mutateAsync(campaignId)
      .then((studio) => setProjectId(studio.project_id))
      .catch((err) => {
        ensuredRef.current = false;
        toast.error(err instanceof Error ? err.message : "Couldn't open the studio workspace");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const { data: videos = [] } = useVideos(projectId ?? 0, !!projectId);

  // ------------------------------------------------------------- composer state
  // Two independent axes, unified into one flow:
  //   SOURCE — where the video comes from (paste/upload, or auto-find).
  //   OUTPUTS — what to make from it (clips, a formula, or both).
  const [source, setSource] = useState<"input" | "find">("find");
  const [wantClips, setWantClips] = useState(true);
  const [wantFormula, setWantFormula] = useState(true);
  // Never allow both outputs off — keep at least one selected.
  const setOutputs = (clips: boolean, formula: boolean) => {
    if (!clips && !formula) return;
    setWantClips(clips);
    setWantFormula(formula);
  };

  const [tab, setTab] = useState<"link" | "upload">("link");
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);

  // One editing-features config drives clips for BOTH sources (paste & auto-find).
  const [editOpts, setEditOpts] = useState<Partial<ProcessOptions>>({
    target_clip_count: 10,
    aspect_ratios: ["9:16"],
    caption_style: "hormozi",
    enable_captions: true,
    enable_reframe: true,
    generate_titles: true,
    generate_descriptions: true,
    generate_broll: true,
  });
  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  // Seed the editing panel's model with the default once models load.
  useEffect(() => {
    if (defaultModel) setEditOpts((o) => (o.model ? o : { ...o, model: defaultModel }));
  }, [defaultModel]);

  // ProcessOptions for a clip run, from the shared editing config.
  const buildClipOptions = (): Partial<ProcessOptions> => {
    const m = editOpts.model || defaultModel || undefined;
    return {
      ...editOpts,
      ...(m ? { model: m } : {}),
      caption_config: editOpts.enable_captions ? { style: capStyle } : undefined,
    };
  };

  // ------------------------------------------------------------ clip pipeline
  const processVideo = useProcessVideo();
  // Videos whose ingest we launched, awaiting auto-process once ready. The value
  // is the ProcessOptions to run with.
  const [awaiting, setAwaiting] = useState<Map<number, Partial<ProcessOptions>>>(new Map());
  // Guards the auto-process effect against double-firing per video.
  const processingRef = useRef<Set<number>>(new Set());

  // ----------------------------------------------------------- formula pipeline
  const createFormula = useWhopCreateFormula();
  const deleteFormula = useWhopDeleteFormula();
  // Videos whose ingest we launched for a formula, awaiting analysis on ready.
  const [awaitingFormula, setAwaitingFormula] = useState<Set<number>>(new Set());
  const formulaCreatingRef = useRef<Set<number>>(new Set());
  // Subset of awaitingFormula whose finished formula should auto-open the report —
  // single runs; NOT batches (which stay in the feed).
  const autoOpenFormulaRef = useRef<Set<number>>(new Set());
  // Videos queued to get a formula AFTER their clip run finishes, so the formula
  // reuses that run's transcript instead of racing a second transcription
  // (process_video and analyze_formula on the same video at once).
  const pendingFormulaRef = useRef<Set<number>>(new Set());
  const [autoOpenFormulaId, setAutoOpenFormulaId] = useState<number | null>(null);
  const [openFormulaId, setOpenFormulaId] = useState<number | null>(null);
  const [formulaModalOpen, setFormulaModalOpen] = useState(false);

  // The formula query self-polls while any analysis is in flight; the flag just
  // covers the gap between "queued locally" and "first row shows processing".
  const keepPollingFormulas = awaitingFormula.size > 0 || autoOpenFormulaId != null;
  const { data: formulas = [] } = useWhopFormulas(campaignId, keepPollingFormulas);
  const openFormula = formulas.find((f) => f.id === openFormulaId) ?? null;

  // Latest formula per source video + any orphans (video deleted → video_id null).
  const { formulasByVideo, orphanFormulas } = useMemo(() => {
    const byVideo = new Map<number, WhopFormula>();
    const orphans: WhopFormula[] = [];
    const videoIds = new Set(videos.map((v) => v.id));
    for (const f of formulas) {
      if (f.video_id != null && videoIds.has(f.video_id)) {
        const existing = byVideo.get(f.video_id);
        if (!existing || f.id > existing.id) byVideo.set(f.video_id, f);
      } else {
        orphans.push(f);
      }
    }
    return { formulasByVideo: byVideo, orphanFormulas: orphans };
  }, [formulas, videos]);

  // ------------------------------------------------------------------ ingest
  // Ingest the dropped link/upload into the campaign's workspace, returning the
  // new Video (or null if the input was empty).
  const ingestSource = async (): Promise<Video | null> => {
    if (!projectId) return null;
    if (tab === "link") {
      if (!url.trim()) {
        toast.error("Drop a video link first");
        return null;
      }
      const v = await api.importYouTube(projectId, url.trim());
      setUrl("");
      return v;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a file first");
      return null;
    }
    const v = await api.uploadVideo(projectId, file);
    if (fileRef.current) fileRef.current.value = "";
    return v;
  };

  // Queue the chosen outputs for freshly-ingested videos. Clips run first; when a
  // formula is also wanted it's deferred until clips exist (shared transcript, no
  // concurrent-transcription race). Formula-only runs go straight to analysis.
  const queueOutputs = (ids: number[], autoOpenFormula: boolean) => {
    if (ids.length === 0) return;
    if (wantClips) {
      const options = buildClipOptions();
      setAwaiting((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.set(id, options);
        return next;
      });
      if (wantFormula) for (const id of ids) pendingFormulaRef.current.add(id);
    } else if (wantFormula) {
      if (autoOpenFormula) for (const id of ids) autoOpenFormulaRef.current.add(id);
      setAwaitingFormula((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
    }
  };

  const outputsWord = wantClips && wantFormula ? "clips + formula" : wantClips ? "clips" : "formula";

  // Paste/upload → ingest → queue the chosen outputs.
  const runInput = async () => {
    if (!projectId) return;
    setSubmitting(true);
    try {
      const v = await ingestSource();
      if (!v) return;
      qc.invalidateQueries({ queryKey: ["videos", projectId] });
      // Formula-only single run → auto-open its report when done.
      queueOutputs([v.id], !wantClips);
      toast.success(`Downloading & analyzing… ${outputsWord} will appear below.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start");
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-process on ready: any awaited video that finished ingest with no clips
  // gets sent through the clip pipeline once, then dropped from the map.
  useEffect(() => {
    for (const v of videos) {
      const options = awaiting.get(v.id);
      if (
        options &&
        v.status === "completed" &&
        v.clip_count === 0 &&
        !processingRef.current.has(v.id)
      ) {
        processingRef.current.add(v.id);
        processVideo
          .mutateAsync({ id: v.id, options })
          .catch((err) => {
            toast.error(err instanceof Error ? err.message : "Failed to generate clips");
          })
          .finally(() => {
            setAwaiting((prev) => {
              const next = new Map(prev);
              next.delete(v.id);
              return next;
            });
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  // Once an awaited video finishes ingest, kick off its formula exactly once.
  useEffect(() => {
    for (const v of videos) {
      if (
        awaitingFormula.has(v.id) &&
        v.status === "completed" &&
        !formulaCreatingRef.current.has(v.id)
      ) {
        formulaCreatingRef.current.add(v.id);
        const shouldOpen = autoOpenFormulaRef.current.has(v.id);
        createFormula
          .mutateAsync({ campaignId, videoId: v.id })
          .then((f) => {
            if (shouldOpen) setAutoOpenFormulaId(f.id);
          })
          .catch((err) =>
            toast.error(err instanceof Error ? err.message : "Couldn't start the analysis"),
          )
          .finally(() => {
            autoOpenFormulaRef.current.delete(v.id);
            setAwaitingFormula((prev) => {
              const next = new Set(prev);
              next.delete(v.id);
              return next;
            });
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  // Promote a deferred formula once its clip run has produced clips — by then the
  // transcript exists, so analyze_formula reuses it (no re-transcribe, no race).
  useEffect(() => {
    for (const v of videos) {
      if (pendingFormulaRef.current.has(v.id) && v.clip_count > 0) {
        pendingFormulaRef.current.delete(v.id);
        setAwaitingFormula((prev) => new Set(prev).add(v.id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  // Auto-open a freshly analyzed formula the moment it completes.
  useEffect(() => {
    if (autoOpenFormulaId == null) return;
    const f = formulas.find((x) => x.id === autoOpenFormulaId);
    if (f && f.status === "completed") {
      setOpenFormulaId(f.id);
      setFormulaModalOpen(true);
      setAutoOpenFormulaId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formulas, autoOpenFormulaId]);

  // -------------------------------------------------------------- auto-find
  const findVideos = useWhopFindVideos();
  const findResult = findVideos.data ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set()); // by url
  const [channelInput, setChannelInput] = useState("");
  const [strictChannel, setStrictChannel] = useState(false);
  const [filterInput, setFilterInput] = useState("");

  const runFind = () => {
    setSelected(new Set());
    const filters = filterInput
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    findVideos.mutate(
      {
        campaignId,
        limit: 48,
        channel: channelInput.trim() || undefined,
        strictChannel: channelInput.trim() ? strictChannel : undefined,
        filters,
      },
      { onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't find videos") },
    );
  };

  const toggleSelect = (m: WhopVideoMatch) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.url)) next.delete(m.url);
      else next.add(m.url);
      return next;
    });
  };

  // Import each selected match, then queue the chosen outputs. Import resiliently:
  // queue each success as it resolves so one failed URL can't strand the rest.
  const runFindSelected = async () => {
    if (!projectId) return;
    const matches = (findResult?.matches ?? []).filter((m) => selected.has(m.url));
    if (matches.length === 0) {
      toast.error("Select at least one video");
      return;
    }
    setSubmitting(true);
    const done: number[] = [];
    let failed = 0;
    for (const m of matches) {
      try {
        const v = await api.importYouTube(projectId, m.url, m.title);
        done.push(v.id);
      } catch {
        failed += 1;
      }
    }
    setSubmitting(false);

    if (done.length > 0) {
      qc.invalidateQueries({ queryKey: ["videos", projectId] });
      queueOutputs(done, false); // batch → don't auto-open the report
      setSelected(new Set());
    }
    if (failed > 0 && done.length > 0) {
      toast(`Making ${outputsWord} for ${done.length}… ${failed} couldn't be imported.`);
    } else if (failed > 0) {
      toast.error("Couldn't import the selected video(s).");
    } else {
      toast.success(
        `Making ${outputsWord} for ${done.length} video${done.length > 1 ? "s" : ""}… see below.`,
      );
    }
  };

  // ----------------------------------------------- per-video result actions
  const generateClipsFor = (v: Video) => {
    processingRef.current.delete(v.id);
    processVideo
      .mutateAsync({ id: v.id, options: buildClipOptions() })
      .then(() => toast.success("Generating clips…"))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to start"));
  };

  // The video is already ingested & ready, so analyze it directly — routing
  // through the awaiting effect wouldn't fire (a static video's array reference
  // never changes, so the [videos] effect never re-runs).
  const buildFormulaFor = (v: Video) => {
    formulaCreatingRef.current.delete(v.id);
    createFormula
      .mutateAsync({ campaignId, videoId: v.id })
      .then((f) => setAutoOpenFormulaId(f.id)) // single run → auto-open the report
      .catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't start the analysis"));
    toast.success("Analyzing formula…");
  };

  const retryFormula = (f: WhopFormula) => {
    if (f.video_id == null) return;
    formulaCreatingRef.current.delete(f.video_id);
    createFormula
      .mutateAsync({ campaignId, videoId: f.video_id })
      .then((nf) => {
        setAutoOpenFormulaId(nf.id);
        // Drop the old failed row so the feed doesn't keep a stale duplicate.
        deleteFormula.mutateAsync(f.id).catch(() => {});
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Retry failed"));
  };

  const removeFormula = (f: WhopFormula) => {
    setFormulaModalOpen(false);
    deleteFormula
      .mutateAsync(f.id)
      .then(() => toast.success("Formula deleted"))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Delete failed"));
  };

  const openFormulaReport = (f: WhopFormula) => {
    setOpenFormulaId(f.id);
    setFormulaModalOpen(true);
  };

  // ------------------------------------------------------------------ clips
  const [openClip, setOpenClip] = useState<Clip | null>(null);
  const [clipDetailOpen, setClipDetailOpen] = useState(false);
  const [submitClip, setSubmitClip] = useState<Clip | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const onOpen = (c: Clip) => {
    setOpenClip(c);
    setClipDetailOpen(true);
  };

  // Workspace still provisioning (or campaign loading) — show the spinner.
  if (projectId === null || !campaign) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const requirements = campaign.requirements;
  const shownRequirements = requirements.slice(0, 6);
  const extraRequirements = requirements.length - shownRequirements.length;

  const findHasResults = source === "find" && !!findResult;
  const primaryVerb = wantClips && wantFormula ? "Make clips + formula" : wantClips ? "Make clips" : "Build formula";
  const hasFeed = videos.length > 0 || orphanFormulas.length > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Back link */}
      <Link
        href="/whop/studio"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Studio
      </Link>

      {/* Campaign header */}
      <div className="flex flex-wrap items-start gap-3">
        {campaign.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={campaign.thumbnail_url}
            alt={`${campaign.name} thumbnail`}
            className="h-12 w-12 shrink-0 rounded-lg border object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-600/30">
            <Megaphone className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{campaign.name}</h1>
            <Badge
              variant={
                campaign.status === "active"
                  ? "success"
                  : campaign.status === "paused"
                    ? "warning"
                    : "outline"
              }
              className="capitalize"
            >
              {campaign.status}
            </Badge>
            <RatePill rate={campaign.rate_per_1k} />
            <PlatformIcons platforms={campaign.platforms} />
            {campaign.whop_url && (
              <a
                href={campaign.whop_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open on Whop
              </a>
            )}
          </div>
          {shownRequirements.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {shownRequirements.map((req) => (
                <span
                  key={req}
                  className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {req}
                </span>
              ))}
              {extraRequirements > 0 && (
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  +{extraRequirements} more
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The composer — one card: pick a source, pick outputs, go. */}
      <Card className="mx-auto max-w-2xl">
        <CardContent className="space-y-5 pt-6">
          {/* Source: where the video comes from. */}
          <div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
              <button
                type="button"
                onClick={() => setSource("find")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                  source === "find"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Search className="h-4 w-4" /> Auto-find
              </button>
              <button
                type="button"
                onClick={() => setSource("input")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                  source === "input"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <LinkIcon className="h-4 w-4" /> Paste / Upload
              </button>
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {source === "input"
                ? "Bring your own video — paste a link or upload a file."
                : "Let the studio find source videos that match this campaign."}
            </p>
          </div>

          {/* Source input */}
          {source === "input" ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "link" | "upload")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="link">
                  <LinkIcon className="mr-1 h-4 w-4" /> Paste link
                </TabsTrigger>
                <TabsTrigger value="upload">
                  <Upload className="mr-1 h-4 w-4" /> Upload
                </TabsTrigger>
              </TabsList>
              <TabsContent value="link" className="space-y-2 pt-4">
                <div className="relative">
                  <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="Drop a video link (YouTube, Vimeo, …)"
                    className="pl-9"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Supports YouTube, Vimeo, Twitch, and most public video links.
                </p>
              </TabsContent>
              <TabsContent value="upload" className="space-y-2 pt-4">
                <Input ref={fileRef} type="file" accept="video/*" />
                <p className="text-xs text-muted-foreground">MP4, MOV, MKV, WEBM, AVI.</p>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                  placeholder="Creator or team — name, @handle, or link"
                  className="h-10"
                />
                <Input
                  value={filterInput}
                  onChange={(e) => setFilterInput(e.target.value)}
                  placeholder="Filter words (optional) — mindset, money"
                  className="h-10"
                />
              </div>
              {channelInput.trim() ? (
                <label className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2">
                  <Switch checked={strictChannel} onCheckedChange={setStrictChannel} />
                  <span className="text-sm">
                    Only this creator&apos;s videos
                    <span className="ml-1 text-muted-foreground">
                      — skip other people&apos;s videos about them
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Name a creator or team to pin their own videos — or leave blank to auto-detect.
                </p>
              )}
              <Button
                variant={findHasResults ? "outline" : "default"}
                className="w-full"
                size="lg"
                onClick={runFind}
                disabled={findVideos.isPending || !projectId}
              >
                {findVideos.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                {findVideos.isPending
                  ? "Finding videos…"
                  : findResult
                    ? "Find again"
                    : "Find matching videos"}
              </Button>
            </div>
          )}

          {/* Outputs: what to make. Shared by both sources. */}
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Make</p>
            <div className="flex gap-2">
              <OutputChip
                active={wantClips}
                onClick={() => setOutputs(!wantClips, wantFormula)}
                icon={Scissors}
                label="Clips"
              />
              <div className="relative flex flex-1">
                <OutputChip
                  active={wantFormula}
                  onClick={() => setOutputs(wantClips, !wantFormula)}
                  icon={FlaskConical}
                  label="Formula"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="What is a clip formula?"
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-w-xs">
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <FlaskConical className="h-4 w-4 text-primary" /> What&apos;s a clip formula?
                    </DropdownMenuLabel>
                    <p className="px-2 pb-2 pt-0.5 text-xs leading-relaxed text-muted-foreground">
                      It reverse-engineers a video into a reusable playbook — the hook, script
                      psychology, ranked viral timestamps, editing &amp; retention tricks, a
                      step-by-step recreation plan, and a submission checklist. Turn it on to build
                      one for every video you make, so you can repeat what works.
                    </p>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {wantClips && wantFormula
                ? "Ready-to-post clips plus a reverse-engineered formula for each video."
                : wantClips
                  ? "Turn each video into ready-to-post clips."
                  : "Reverse-engineer each video into a reusable formula — hook, script, editing, and a submission checklist."}
            </p>
          </div>

          {/* Editing features — only relevant when making clips. */}
          {wantClips && (
            <EditingOptionsPanel
              opts={editOpts}
              setOpts={setEditOpts}
              capStyle={capStyle}
              setCapStyle={setCapStyle}
              models={models}
            />
          )}

          {/* Primary action for the paste/upload source. Auto-find commits below
              its results grid instead. */}
          {source === "input" && (
            <Button
              className="w-full"
              size="lg"
              onClick={runInput}
              disabled={submitting || !projectId}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : wantFormula && !wantClips ? (
                <FlaskConical className="h-4 w-4" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {primaryVerb}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Auto-find candidate grid + commit */}
      {source === "find" && !findResult && !findVideos.isPending && (
        <p className="text-center text-sm text-muted-foreground">
          Hit “Find matching videos” to search YouTube for source videos that fit this campaign.
        </p>
      )}
      {source === "find" && findResult && (
        <div className="space-y-5">
          <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            {findResult.understanding}
          </p>
          {findResult.matches.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              No matching videos found — try a richer campaign description, or paste a link instead.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {findResult.matches.map((m) => (
                  <MatchCard
                    key={m.url}
                    match={m}
                    selected={selected.has(m.url)}
                    onToggle={toggleSelect}
                  />
                ))}
              </div>
              <Button
                className="mx-auto flex w-full max-w-2xl"
                size="lg"
                onClick={runFindSelected}
                disabled={submitting || selected.size === 0}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {selected.size === 0
                  ? "Select videos above"
                  : `${primaryVerb} from ${selected.size} selected`}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Unified results feed — every source video with its clips + formula. */}
      {hasFeed ? (
        <div className="space-y-8">
          {videos.map((v) => (
            <WorkspaceVideo
              key={v.id}
              video={v}
              formula={formulasByVideo.get(v.id) ?? null}
              awaitingClips={awaiting.has(v.id)}
              awaitingFormula={awaitingFormula.has(v.id) || pendingFormulaRef.current.has(v.id)}
              onOpenClip={onOpen}
              onGenerateClips={generateClipsFor}
              onBuildFormula={buildFormulaFor}
              onOpenFormula={openFormulaReport}
              onRetryFormula={retryFormula}
            />
          ))}
          {orphanFormulas.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {orphanFormulas.map((f) => (
                <FormulaCard key={f.id} formula={f} onOpen={openFormulaReport} onRetry={retryFormula} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          {source === "find"
            ? "Find videos above, pick a few, and choose what to make."
            : "Paste a link above and choose what to make — clips, a formula, or both."}
        </p>
      )}

      <FormulaReportModal
        formula={openFormula}
        campaign={campaign as WhopCampaign}
        open={formulaModalOpen}
        onOpenChange={setFormulaModalOpen}
        onDelete={removeFormula}
      />

      <ClipDetailModal
        clip={openClip}
        campaign={campaign as WhopCampaign}
        open={clipDetailOpen}
        onOpenChange={setClipDetailOpen}
        onSubmit={(c) => {
          setClipDetailOpen(false);
          setSubmitClip(c);
          setSubmitOpen(true);
        }}
      />
      <SubmitClipDialog
        clip={submitClip}
        campaign={campaign as WhopCampaign}
        open={submitOpen}
        onOpenChange={setSubmitOpen}
      />
    </div>
  );
}
