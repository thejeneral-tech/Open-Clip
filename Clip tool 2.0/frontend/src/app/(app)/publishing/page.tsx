"use client";

import {
  Facebook, Instagram, Loader2, Lock, Music2, Send, Trash2, Twitter, Youtube,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBots, useConnectors, usePublishingJobs, useYouTubeStatus } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { Connector } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

const UNASSIGNED = "none";

const COMING_SOON = [
  { key: "tiktok", label: "TikTok", Icon: Music2 },
  { key: "instagram", label: "Instagram", Icon: Instagram },
  { key: "x", label: "X (Twitter)", Icon: Twitter },
  { key: "facebook", label: "Facebook", Icon: Facebook },
] as const;

const STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline" | "default"> = {
  published: "default",
  failed: "destructive",
  awaiting_approval: "outline",
};

// ----------------------------------------------------------------- channels
function YouTubeCard({ c }: { c: Connector }) {
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const refresh = () => qc.invalidateQueries({ queryKey: ["connectors"] });
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast.success(msg); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
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
          <span className="text-xs text-muted-foreground">Posts as</span>
          <Select
            disabled={busy}
            value={c.bot_id ? String(c.bot_id) : UNASSIGNED}
            onValueChange={(v) =>
              run(() => api.assignConnector(c.id, v === UNASSIGNED ? null : Number(v)),
                v === UNASSIGNED ? "Unassigned" : "Assigned to bot")
            }
          >
            <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {bots.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Privacy</span>
          <Select
            disabled={busy}
            value={c.config.privacy || "private"}
            onValueChange={(v) =>
              run(() => api.updateConnector(c.id, { config: { ...c.config, privacy: v } }), "Privacy updated")
            }
          >
            <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["public", "unlisted", "private"].map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="ghost" size="icon" className="h-8 w-8 text-destructive" disabled={busy}
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
              No channels connected. Click <b>Connect channel</b>, then assign each channel to a bot —
              that bot will auto-post its clips there.
            </p>
          )
        ) : (
          <div className="space-y-2">{channels.map((c) => <YouTubeCard key={c.id} c={c} />)}</div>
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
  const qc = useQueryClient();
  const { data: jobs = [], isLoading } = usePublishingJobs(undefined, undefined, true);
  const refresh = () => qc.invalidateQueries({ queryKey: ["pub-jobs"] });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (jobs.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No publishing jobs yet.</p>;

  return (
    <div className="space-y-2">
      {jobs.map((j) => (
        <div key={j.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{j.platform}</Badge>
              <Badge variant={STATUS_VARIANT[j.status] ?? "secondary"}>{j.status.replace("_", " ")}</Badge>
              {j.scheduled_at && <span className="text-xs text-muted-foreground">scheduled {formatRelativeTime(j.scheduled_at)}</span>}
            </div>
            <p className="truncate text-sm font-medium">{j.title || `Clip #${j.clip_id}`}</p>
            {j.external_url && <a href={j.external_url} target="_blank" rel="noreferrer" className="truncate text-xs text-primary">{j.external_url}</a>}
            {j.error && <p className="truncate text-xs text-destructive">{j.error}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            {(j.status === "awaiting_approval" || j.status === "scheduled" || j.status === "pending") && (
              <Button size="sm" onClick={() => act(() => api.approveJob(j.id), "Publishing")}>Publish</Button>
            )}
            {j.status === "failed" && (
              <Button size="sm" variant="outline" onClick={() => act(() => api.retryJob(j.id), "Retrying")}>Retry</Button>
            )}
            {j.status !== "published" && j.status !== "cancelled" && (
              <Button size="sm" variant="ghost" onClick={() => act(() => api.cancelJob(j.id), "Cancelled")}>Cancel</Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PublishingPage() {
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
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Publishing</h1>
        <p className="text-muted-foreground">
          Connect channels and assign them to bots, then review the auto-publish queue.
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
