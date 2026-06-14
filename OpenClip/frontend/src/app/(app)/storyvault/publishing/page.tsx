"use client";

import {
  Check,
  Download,
  ExternalLink,
  Facebook,
  Instagram,
  Loader2,
  Lock,
  Music2,
  RefreshCw,
  Send,
  Trash2,
  Twitter,
  Youtube,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useConnectors,
  useSvDeletePublishJob,
  useSvDeleteVideo,
  useSvPublishJobs,
  useSvPublishVideo,
  useSvRetryPublishJob,
  useSvRetryVideo,
  useSvVideos,
  useYouTubeStatus,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { Connector, SvVideo } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

const PUBLISHABLE = new Set(["ready_for_review", "approved", "completed"]);
const BUSY = new Set(["queued", "processing", "rendering"]);

// More platforms, shown as locked previews — mirrors the main OpenClip Publishing tab.
const COMING_SOON = [
  { key: "tiktok", label: "TikTok", Icon: Music2 },
  { key: "instagram", label: "Instagram", Icon: Instagram },
  { key: "x", label: "X (Twitter)", Icon: Twitter },
  { key: "facebook", label: "Facebook", Icon: Facebook },
] as const;

function jobBadge(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "published") return "default";
  if (status === "failed") return "destructive";
  if (status === "publishing") return "secondary";
  return "outline";
}

function channelReady(c: Connector): { ok: boolean; why?: string } {
  if (c.platform !== "youtube") return { ok: false, why: "coming soon" };
  if (!c.has_credentials) return { ok: false, why: "not connected" };
  return { ok: true };
}

function PublishCard({ video, channels }: { video: SvVideo; channels: Connector[] }) {
  const publish = useSvPublishVideo();
  const retryVideo = useSvRetryVideo();
  const deleteVideo = useSvDeleteVideo();

  const [selected, setSelected] = useState<number[]>([]);
  const [title, setTitle] = useState(video.story_title ?? video.title ?? "");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState("public");

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const onPublish = async () => {
    if (selected.length === 0) return;
    try {
      const jobs = await publish.mutateAsync({
        videoId: video.id,
        data: { connector_ids: selected, title, description: description || undefined, privacy },
      });
      toast.success(
        `Queued ${jobs.length} upload${jobs.length === 1 ? "" : "s"} — final render happens automatically`,
      );
      setSelected([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Publish failed");
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={video.preview_url ?? undefined}
          controls
          preload="metadata"
          className="aspect-[9/16] w-full shrink-0 rounded-md bg-black object-contain sm:w-48"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate font-semibold">
              {video.story_title ?? video.title ?? `Video #${video.id}`}
            </h3>
            <Badge variant={video.status === "completed" ? "default" : "secondary"}>
              {video.status.replaceAll("_", " ")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {video.duration_target}s target · {video.caption_style} captions ·{" "}
            {Math.round(video.narration_duration ?? 0)}s narration · {formatRelativeTime(video.updated_at)}
          </p>

          <div className="space-y-2">
            <Label htmlFor={`title-${video.id}`}>Title</Label>
            <Input
              id={`title-${video.id}`}
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`desc-${video.id}`}>Description (optional — #Shorts is added automatically)</Label>
            <Textarea
              id={`desc-${video.id}`}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Channels</Label>
            {channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No channels yet — connect a YouTube channel in the Channels tab.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {channels.map((c) => {
                  const ready = channelReady(c);
                  const active = selected.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!ready.ok}
                      title={ready.why}
                      onClick={() => toggle(c.id)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                        !ready.ok && "cursor-not-allowed opacity-50",
                        active
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border hover:bg-muted/60",
                      )}
                    >
                      {active ? <Check className="h-3.5 w-3.5" /> : <Youtube className="h-3.5 w-3.5" />}
                      {c.name}
                      {!ready.ok && <span className="text-[10px] uppercase">({ready.why})</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Select value={privacy} onValueChange={setPrivacy}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={onPublish} disabled={selected.length === 0 || publish.isPending}>
              {publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Publish to {selected.length || ""} channel{selected.length === 1 ? "" : "s"}
            </Button>
            {video.render_url && (
              <Button asChild variant="outline" size="sm">
                <a href={video.render_url} download>
                  <Download className="h-4 w-4" /> Download
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              title="Regenerate this video"
              onClick={async () => {
                try {
                  await retryVideo.mutateAsync(video.id);
                  toast.success("Regenerating — it will reappear here when ready");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed");
                }
              }}
            >
              <RefreshCw className="h-4 w-4" /> Regenerate
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title="Delete video"
              onClick={async () => {
                if (!confirm("Delete this video and its files?")) return;
                try {
                  await deleteVideo.mutateAsync(video.id);
                  toast.success("Video deleted");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed");
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------- channels
// One connected channel: default privacy + disconnect. (StoryVault publishes
// per-video, so unlike the main app's card there's no bot assignment here.)
function SvChannelCard({ c }: { c: Connector }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["connectors"] });

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const thumb = c.config.channel_thumbnail;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {thumb ? (
          <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-full" />
        ) : (
          <Youtube className="h-10 w-10 shrink-0 text-red-600" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{c.config.channel_title || c.name}</span>
            <Badge variant={c.status === "connected" ? "default" : "destructive"}>{c.status}</Badge>
          </div>
          {c.last_error && <p className="truncate text-xs text-destructive">{c.last_error}</p>}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Privacy</span>
          <Select
            disabled={busy}
            value={c.config.privacy || "public"}
            onValueChange={(v) =>
              run(() => api.updateConnector(c.id, { config: { ...c.config, privacy: v } }), "Privacy updated")
            }
          >
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["public", "unlisted", "private"].map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive"
          disabled={busy}
          onClick={() => run(() => api.deleteConnector(c.id), "Channel disconnected")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

function ChannelsTab() {
  const { data: connectors = [] } = useConnectors();
  const { data: yt, isLoading } = useYouTubeStatus();
  const [connecting, setConnecting] = useState(false);
  const channels = connectors.filter((c) => c.platform === "youtube");

  const connect = async () => {
    setConnecting(true);
    try {
      const { auth_url } = await api.youtubeAuthUrl({});
      window.location.href = auth_url; // full-page redirect to Google consent
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start YouTube sign-in");
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ---- YouTube ---- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Youtube className="h-5 w-5 text-red-600" />
            <h2 className="font-semibold">YouTube</h2>
          </div>
          <Button onClick={connect} disabled={connecting || (yt && !yt.configured)}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4" />}
            Connect channel
          </Button>
        </div>

        {!isLoading && yt && !yt.configured && (
          <Card className="border-dashed">
            <CardContent className="space-y-2 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">YouTube isn&apos;t configured yet.</p>
              <p>
                Add a Google OAuth client to <code>.env</code> (<code>GOOGLE_CLIENT_ID</code> /{" "}
                <code>GOOGLE_CLIENT_SECRET</code>) with the YouTube Data API v3 enabled, then register
                this redirect URI on the client:
              </p>
              <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{yt.redirect_uri}</code>
            </CardContent>
          </Card>
        )}

        {channels.length === 0 ? (
          yt?.configured && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No channels connected. Click <b>Connect channel</b>, then pick it for each story video in
              the Queue tab.
            </p>
          )
        ) : (
          <div className="space-y-2">{channels.map((c) => <SvChannelCard key={c.id} c={c} />)}</div>
        )}
      </section>

      {/* ---- Coming soon ---- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">More platforms</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {COMING_SOON.map(({ key, label, Icon }) => (
            <Card key={key} className="opacity-60">
              <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
                <Icon className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm font-medium">{label}</span>
                <Badge variant="outline" className="gap-1 text-xs">
                  <Lock className="h-3 w-3" /> Coming soon
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

// -------------------------------------------------------------------- queue
function QueueTab() {
  const { data: videos = [], isLoading: videosLoading } = useSvVideos(undefined, true);
  const { data: connectors = [] } = useConnectors();
  const { data: jobs = [], isLoading: jobsLoading } = useSvPublishJobs(true);
  const retryJob = useSvRetryPublishJob();
  const deleteJob = useSvDeletePublishJob();
  const retryVideo = useSvRetryVideo();

  const publishable = videos.filter((v) => PUBLISHABLE.has(v.status));
  const busy = videos.filter((v) => BUSY.has(v.status));
  const failed = videos.filter((v) => v.status === "failed");

  return (
    <div className="space-y-6">
      {/* Ready to publish */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ready to publish
        </h2>
        {videosLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : publishable.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Nothing ready yet — generate a video in the Studio
              {busy.length > 0 && ` (${busy.length} currently processing)`}.
            </CardContent>
          </Card>
        ) : (
          publishable.map((v) => <PublishCard key={v.id} video={v} channels={connectors} />)
        )}
        {failed.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Needs attention</CardTitle>
              <CardDescription>These videos failed to generate.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {failed.map((v) => (
                <div key={v.id} className="flex items-center gap-3 rounded-md border border-border p-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{v.story_title ?? v.title ?? `Video #${v.id}`}</p>
                    <p className="line-clamp-1 text-xs text-destructive">{v.error}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await retryVideo.mutateAsync(v.id);
                        toast.success("Regenerating");
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed");
                      }
                    }}
                  >
                    <RefreshCw className="h-4 w-4" /> Retry
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>

      {/* Upload history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Upload history
        </h2>
        {jobsLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No uploads yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-2 pt-6">
              {jobs.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5">
                  <Badge variant={jobBadge(j.status)}>
                    {j.status === "publishing" && <Loader2 className="h-3 w-3 animate-spin" />}
                    {j.status}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="font-medium">{j.title ?? j.video_title ?? `Video #${j.sv_video_id}`}</span>
                      <span className="text-muted-foreground"> → {j.channel_name ?? j.platform}</span>
                    </p>
                    {j.error && <p className="line-clamp-1 text-xs text-destructive">{j.error}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(j.created_at)}</span>
                  {j.external_url && (
                    <Button asChild variant="outline" size="sm">
                      <a href={j.external_url} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" /> View
                      </a>
                    </Button>
                  )}
                  {j.status === "failed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          await retryJob.mutateAsync(j.id);
                          toast.success("Retrying upload");
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed");
                        }
                      }}
                    >
                      <RefreshCw className="h-4 w-4" /> Retry
                    </Button>
                  )}
                  {j.status !== "publishing" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="Remove from history"
                      onClick={async () => {
                        try {
                          await deleteJob.mutateAsync(j.id);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed");
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

export default function StoryVaultPublishingPage() {
  // Surface the result of the OAuth redirect (?connected / ?error), then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const connected = p.get("connected");
    const error = p.get("error");
    if (connected === "youtube") toast.success(`Connected ${p.get("channel") || "YouTube channel"}`);
    else if (error) toast.error(error);
    if (connected || error) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Publishing</h1>
        <p className="text-muted-foreground">
          Connect channels, then pick where each story video goes — the final 1080×1920 render and
          upload run automatically.
        </p>
      </div>
      <Tabs defaultValue="channels">
        <TabsList>
          <TabsTrigger value="channels"><Youtube className="mr-1 h-4 w-4" /> Channels</TabsTrigger>
          <TabsTrigger value="queue"><Send className="mr-1 h-4 w-4" /> Queue</TabsTrigger>
        </TabsList>
        <TabsContent value="channels" className="pt-4"><ChannelsTab /></TabsContent>
        <TabsContent value="queue" className="pt-4"><QueueTab /></TabsContent>
      </Tabs>
    </div>
  );
}
