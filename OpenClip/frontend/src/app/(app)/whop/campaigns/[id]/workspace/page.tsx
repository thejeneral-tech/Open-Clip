"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Film,
  Loader2,
  Megaphone,
  Search,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { CampaignForm, type CampaignFormValue } from "@/components/whop/campaign-form";
import { EditingOptionsPanel } from "@/components/whop/finder-shared";
import { PlatformIcons, RatePill } from "@/components/whop/platform-meta";
import { ClipDetailModal, StudioClipCard, SubmitClipDialog, videoStageLabel } from "@/components/whop/studio-shared";
import { PayoutMathPanel, ScoredMatchCard, StrategyPanel } from "@/components/whop/workspace-shared";
import {
  useClips,
  useModels,
  useProcessVideo,
  useVideos,
  useWhopCampaign,
  useWhopEnsureStudio,
  useWhopFindVideos,
  useWhopScoreVideos,
  useWhopStrategy,
  useWhopUpdateCampaign,
  useWhopUploadThumbnail,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import { budgetRemaining, projectPayout } from "@/lib/campaign-math";
import type {
  Clip,
  ProcessOptions,
  Video,
  WhopCampaign,
  WhopStrategy,
  WhopVideoMatch,
} from "@/lib/types";
import { formatDuration, formatMoney } from "@/lib/utils";

// Projected earnings range for a clip that scores `score`, from the campaign's
// RPM + a view band (its own history when available, else a default), scaled by
// score. A labeled estimate — mirrors the backend's per-video projection.
function clipProjection(score: number, campaign: WhopCampaign): [number, number] {
  const remaining = budgetRemaining(campaign.budget, campaign.paid_out);
  const avg =
    campaign.submissions_total > 0 ? campaign.views_total / campaign.submissions_total : null;
  const [loV, hiV] = avg && avg > 0 ? [avg * 0.5, avg * 2] : [3000, 40000];
  const factor = 0.6 + score / 100;
  const opts = {
    minPayout: campaign.min_payout,
    maxPayout: campaign.max_payout,
    remaining,
  };
  return [
    projectPayout(loV * factor, campaign.rate_per_1k, opts),
    projectPayout(hiV * factor, campaign.rate_per_1k, opts),
  ];
}

// ---------------------------------------------------------- one video's clips
function VideoBlock({
  video,
  campaign,
  onOpen,
}: {
  video: Video;
  campaign: WhopCampaign;
  onOpen: (c: Clip) => void;
}) {
  const busy = video.status === "processing" || video.status === "queued";
  const pct = Math.round((video.progress || 0) * 100);
  const { data: clips = [] } = useClips(video.id, "score", true);
  const best = clips[0]; // useClips(sort="score") returns best-first
  const bestScore = best ? best.ranking_score || best.viral_score : 0;
  const [pLo, pHi] = best ? clipProjection(bestScore, campaign) : [0, 0];

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {video.title || `Source video #${video.id}`}
        </h3>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          <span>{videoStageLabel(video)}</span>
        </div>
      </div>

      {busy && <Progress value={pct} />}
      {video.status === "failed" && video.error && (
        <p className="text-sm text-destructive">{video.error}</p>
      )}

      {best && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-semibold text-primary">Best clip moment</span>
          <span className="tabular-nums">
            {formatDuration(best.start_time)}–{formatDuration(best.end_time)}
          </span>
          <span className="tabular-nums text-muted-foreground">{Math.round(bestScore)}/100</span>
          <span className="ml-auto font-semibold text-emerald-500">
            Projected {formatMoney(pLo)}–{formatMoney(pHi)}
          </span>
        </div>
      )}

      {clips.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {clips.map((c) => (
            <StudioClipCard key={c.id} clip={c} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CampaignWorkspacePage() {
  const params = useParams();
  const campaignId = Number(params.id);
  const qc = useQueryClient();

  const { data: campaign, isLoading } = useWhopCampaign(campaignId, true);
  const updateCampaign = useWhopUpdateCampaign();
  const uploadThumbnail = useWhopUploadThumbnail();
  const ensureStudio = useWhopEnsureStudio();
  const { data: models = [] } = useModels();
  const defaultModel =
    models.find((m) => !/(moondream|llava|bakllava|vision|-vl|minicpm-v|:0\.5|0\.5b)/i.test(m.name))
      ?.name ?? models[0]?.name;

  // Live form values → drive the payout math panel without waiting for Save.
  const [live, setLive] = useState<CampaignFormValue | null>(null);

  // Studio workspace project (lazily ensured, exactly once).
  const [projectId, setProjectId] = useState<number | null>(null);
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (ensuredRef.current || !campaignId) return;
    ensuredRef.current = true;
    ensureStudio
      .mutateAsync(campaignId)
      .then((studio) => setProjectId(studio.project_id))
      .catch((err) => {
        ensuredRef.current = false;
        toast.error(err instanceof Error ? err.message : "Couldn't open the workspace");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const { data: videos = [] } = useVideos(projectId ?? 0, !!projectId);

  // ---- Auto Finder ----
  const findVideos = useWhopFindVideos();
  const scoreVideos = useWhopScoreVideos();
  const strategyMut = useWhopStrategy();
  const [matches, setMatches] = useState<WhopVideoMatch[]>([]);
  const [strategy, setStrategy] = useState<WhopStrategy | null>(null);
  const [understanding, setUnderstanding] = useState<string | null>(null);
  const [scoringUrls, setScoringUrls] = useState<Set<string>>(new Set());
  const [channelInput, setChannelInput] = useState("");
  const [strictChannel, setStrictChannel] = useState(true);
  const [filterInput, setFilterInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sortedMatches = useMemo(
    () => [...matches].sort((a, b) => b.score - a.score),
    [matches],
  );

  // Ask the Copilot for a strategy over the deep-scored candidates.
  const runStrategy = (list: WhopVideoMatch[]) => {
    const videos = [...list]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((m) => ({
        url: m.url,
        title: m.title,
        score: m.score,
        duration: m.duration,
        projected_low: m.projected_low ?? null,
        projected_high: m.projected_high ?? null,
        reasons: (m.reasons ?? []).map((r) => r.text).slice(0, 3),
      }));
    if (videos.length === 0) return;
    strategyMut.mutate(
      { campaignId, videos },
      { onSuccess: setStrategy, onError: () => setStrategy(null) },
    );
  };

  // Deepen (Stage 4) the found candidates: full metadata + captions transcript,
  // re-score, merge the richer scores back in place so cards visibly rerank with
  // a delta + rising confidence, then hand the top set to the Copilot.
  const deepen = (list: WhopVideoMatch[]) => {
    const urls = list.map((m) => m.url).slice(0, 12);
    if (urls.length === 0) return;
    const prevScores: Record<string, number> = {};
    for (const m of list) prevScores[m.url] = m.score;
    setScoringUrls(new Set(urls));
    scoreVideos.mutate(
      { campaignId, urls, stage: 4, prevScores },
      {
        onSuccess: (res) => {
          const byUrl = new Map(res.matches.map((m) => [m.url, m]));
          setMatches((prev) => prev.map((m) => byUrl.get(m.url) ?? m));
          runStrategy(res.matches);
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Couldn't deepen the scores"),
        onSettled: () => setScoringUrls(new Set()),
      },
    );
  };

  const runFind = () => {
    setSelected(new Set());
    setStrategy(null);
    const filters = filterInput
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    findVideos.mutate(
      {
        campaignId,
        limit: 12,
        channel: channelInput.trim() || undefined,
        strictChannel: channelInput.trim() ? strictChannel : undefined,
        filters,
      },
      {
        onSuccess: (res) => {
          setMatches(res.matches);
          setUnderstanding(res.understanding);
          deepen(res.matches); // immediately start the deeper pass
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Couldn't find videos"),
      },
    );
  };

  const toggleSelect = (m: WhopVideoMatch) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.url)) next.delete(m.url);
      else next.add(m.url);
      return next;
    });

  // ---- editing features + clip-here ----
  const [editOpts, setEditOpts] = useState<Partial<ProcessOptions>>({
    target_clip_count: 10,
    aspect_ratios: ["9:16"],
    caption_style: "hormozi",
    enable_captions: true,
    enable_reframe: true,
    generate_titles: true,
    generate_descriptions: true,
    generate_broll: false,
  });
  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  useEffect(() => {
    if (defaultModel) setEditOpts((o) => (o.model ? o : { ...o, model: defaultModel }));
  }, [defaultModel]);

  const [awaiting, setAwaiting] = useState<Map<number, Partial<ProcessOptions>>>(new Map());
  const processingRef = useRef<Set<number>>(new Set());
  const processVideo = useProcessVideo();
  const [clipping, setClipping] = useState(false);

  const clipSelected = async () => {
    if (!projectId) return;
    const picks = sortedMatches.filter((m) => selected.has(m.url));
    if (picks.length === 0) {
      toast.error("Select at least one video");
      return;
    }
    const model = editOpts.model || defaultModel || undefined;
    const options: Partial<ProcessOptions> = {
      ...editOpts,
      ...(model ? { model } : {}),
      caption_config: editOpts.enable_captions ? { style: capStyle } : undefined,
    };
    setClipping(true);
    const done: number[] = [];
    let failed = 0;
    for (const m of picks) {
      try {
        const v = await api.importYouTube(projectId, m.url, m.title);
        done.push(v.id);
      } catch {
        failed += 1;
      }
    }
    setClipping(false);
    if (done.length > 0) {
      qc.invalidateQueries({ queryKey: ["videos", projectId] });
      setAwaiting((prev) => {
        const next = new Map(prev);
        for (const id of done) next.set(id, options);
        return next;
      });
      setSelected(new Set());
    }
    if (failed > 0 && done.length > 0) toast(`Clipping ${done.length}… ${failed} couldn't import.`);
    else if (failed > 0) toast.error("Couldn't import the selected video(s).");
    else toast.success(`Clipping ${done.length} video${done.length > 1 ? "s" : ""}… see below.`);
  };

  // Auto-process any awaited video once its ingest completes with no clips yet.
  useEffect(() => {
    for (const v of videos) {
      const options = awaiting.get(v.id);
      if (options && v.status === "completed" && v.clip_count === 0 && !processingRef.current.has(v.id)) {
        processingRef.current.add(v.id);
        processVideo
          .mutateAsync({ id: v.id, options })
          .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to generate clips"))
          .finally(() =>
            setAwaiting((prev) => {
              const next = new Map(prev);
              next.delete(v.id);
              return next;
            }),
          );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  // ---- clip modals ----
  const [openClip, setOpenClip] = useState<Clip | null>(null);
  const [clipDetailOpen, setClipDetailOpen] = useState(false);
  const [submitClip, setSubmitClip] = useState<Clip | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const onSave = async (value: CampaignFormValue, thumbnail: File | null) => {
    try {
      await updateCampaign.mutateAsync({
        id: campaignId,
        data: {
          name: value.name,
          description: value.description || null,
          campaign_type: value.campaign_type,
          category: value.category,
          rate_per_1k: value.rate_per_1k,
          budget: value.budget,
          min_payout: value.min_payout,
          max_payout: value.max_payout,
          platforms: value.platforms,
          requirements: value.requirements,
          asset_links: value.asset_links,
          whop_url: value.whop_url || null,
          ends_at: value.ends_at,
        },
      });
      if (thumbnail) await uploadThumbnail.mutateAsync({ id: campaignId, file: thumbnail });
      toast.success("Campaign saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save campaign");
    }
  };

  if (isLoading || !campaign) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const anyScoring = scoringUrls.size > 0 || scoreVideos.isPending;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Back + header */}
      <div>
        <Link
          href={`/whop/campaigns/${campaignId}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to campaign
        </Link>
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
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{campaign.name}</h1>
              <RatePill rate={campaign.rate_per_1k} />
              <PlatformIcons platforms={campaign.platforms} />
            </div>
            <p className="text-sm text-muted-foreground">
              Campaign workspace — tune the brief, find & score sources, then clip.
            </p>
          </div>
        </div>
      </div>

      {/* Brief & rules + live payout math */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Campaign brief &amp; rules</CardTitle>
            <CardDescription>Edit the brief — the finder and payout math react instantly.</CardDescription>
          </CardHeader>
          <CardContent>
            <CampaignForm
              initial={campaign}
              submitLabel="Save changes"
              submitting={updateCampaign.isPending || uploadThumbnail.isPending}
              onSubmit={onSave}
              onChange={setLive}
              hideBusinessFields
            />
          </CardContent>
        </Card>
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <PayoutMathPanel
            campaign={campaign}
            ratePer1k={live?.rate_per_1k ?? campaign.rate_per_1k}
            budget={live ? live.budget : campaign.budget}
            minPayout={live ? live.min_payout : campaign.min_payout}
            maxPayout={live ? live.max_payout : campaign.max_payout}
            endsAt={live ? live.ends_at : campaign.ends_at}
          />
          <StrategyPanel matches={matches} strategy={strategy} loading={strategyMut.isPending} />
        </div>
      </div>

      {/* Auto Finder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Auto Finder</CardTitle>
          <CardDescription>
            Search YouTube for source videos that fit this campaign, scored and ranked for you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={channelInput}
              onChange={(e) => setChannelInput(e.target.value)}
              placeholder="Creator or team — name, @handle, or link"
            />
            <Input
              value={filterInput}
              onChange={(e) => setFilterInput(e.target.value)}
              placeholder="Filter words (optional) — mindset, money"
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
          <Button className="w-full" size="lg" onClick={runFind} disabled={findVideos.isPending || !projectId}>
            {findVideos.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {findVideos.isPending ? "Finding videos…" : matches.length ? "Find again" : "Find matching videos"}
          </Button>

          {understanding && (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {understanding}
            </p>
          )}
          {anyScoring && (
            <p className="flex items-center gap-2 text-sm text-primary">
              <Loader2 className="h-4 w-4 animate-spin" /> Deepening ranks — reading transcripts,
              velocity &amp; engagement…
            </p>
          )}

          {sortedMatches.length > 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {sortedMatches.map((m) => (
                  <ScoredMatchCard
                    key={m.url}
                    match={m}
                    selected={selected.has(m.url)}
                    scoring={scoringUrls.has(m.url)}
                    onToggle={toggleSelect}
                  />
                ))}
              </div>

              <EditingOptionsPanel
                opts={editOpts}
                setOpts={setEditOpts}
                capStyle={capStyle}
                setCapStyle={setCapStyle}
                models={models}
              />

              <Button
                className="w-full"
                size="lg"
                onClick={clipSelected}
                disabled={clipping || selected.size === 0}
              >
                {clipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {selected.size === 0 ? "Select videos to clip" : `Clip ${selected.size} selected here`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Clips produced right here */}
      {videos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Clips</CardTitle>
            <CardDescription>
              Open a clip to see its score breakdown and submit it to the campaign.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {videos.map((v) => (
              <VideoBlock key={v.id} video={v} campaign={campaign} onOpen={(c) => {
                setOpenClip(c);
                setClipDetailOpen(true);
              }} />
            ))}
          </CardContent>
        </Card>
      )}

      {campaign.whop_url && (
        <a
          href={campaign.whop_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" /> View on Whop
        </a>
      )}

      <ClipDetailModal
        clip={openClip}
        campaign={campaign}
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
        campaign={campaign}
        open={submitOpen}
        onOpenChange={setSubmitOpen}
      />
    </div>
  );
}
