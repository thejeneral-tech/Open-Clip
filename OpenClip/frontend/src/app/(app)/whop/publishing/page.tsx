"use client";

import {
  ArrowLeft,
  Check,
  ExternalLink,
  Film,
  Loader2,
  Megaphone,
  Play,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Youtube,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RatePill } from "@/components/whop/platform-meta";
import {
  useWhopCampaigns,
  useWhopChannelCampaigns,
  useWhopChannels,
  useWhopLinkCampaign,
  useWhopPublishClip,
  useWhopReadyClips,
  useWhopUnlinkCampaign,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { WhopCampaign, WhopChannel, WhopReadyClip } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

// Terminal / in-flight publish states for a clip.
function publishBadge(status: string | null) {
  if (status === "published") return { label: "Published", variant: "success" as const };
  if (status === "failed") return { label: "Failed", variant: "destructive" as const };
  if (status && status !== "cancelled")
    return { label: "Publishing…", variant: "warning" as const };
  return null;
}

// ------------------------------------------------------------- connect button
function ConnectYouTube({ label = "Connect a YouTube account" }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const { auth_url } = await api.youtubeAuthUrl({ return_to: "/whop/publishing" });
      window.location.href = auth_url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start YouTube sign-in");
      setBusy(false);
    }
  };
  return (
    <Button onClick={connect} disabled={busy} variant="outline">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      {label}
    </Button>
  );
}

// ---------------------------------------------------- add-campaign search
function CampaignSearchResults({
  connectorId,
  q,
  connectedIds,
}: {
  connectorId: number;
  q: string;
  connectedIds: Set<number>;
}) {
  const { data: campaigns = [], isLoading } = useWhopCampaigns({ q });
  const link = useWhopLinkCampaign();

  const onAdd = async (campaignId: number) => {
    try {
      await link.mutateAsync({ connectorId, campaignId });
      toast.success("Campaign added to channel");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add campaign");
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (campaigns.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No campaigns match “{q}”.</p>;
  }
  return (
    <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {campaigns.map((c) => {
        const already = connectedIds.has(c.id);
        return (
          <div key={c.id} className="flex items-center gap-3 rounded-md border border-border p-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                ${c.rate_per_1k.toFixed(2)}/1K · {c.status}
              </p>
            </div>
            <Button
              size="sm"
              variant={already ? "outline" : "default"}
              disabled={already || link.isPending}
              onClick={() => onAdd(c.id)}
            >
              {already ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {already ? "Added" : "Add"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function AddCampaignDialog({
  connectorId,
  connectedIds,
}: {
  connectorId: number;
  connectedIds: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add campaign
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a campaign to this channel</DialogTitle>
          <DialogDescription>
            Search your campaigns and pick the ones this channel publishes clips for.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search campaigns by name…"
            className="pl-8"
          />
        </div>
        {q.trim().length < 2 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search.
          </p>
        ) : (
          <CampaignSearchResults connectorId={connectorId} q={q.trim()} connectedIds={connectedIds} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------- campaigns for the chosen channel
function ChannelCampaignList({
  channel,
  onOpen,
}: {
  channel: WhopChannel;
  onOpen: (campaign: WhopCampaign) => void;
}) {
  const { data: connected = [], isLoading } = useWhopChannelCampaigns(channel.connector_id);
  const unlink = useWhopUnlinkCampaign();
  const [removeTarget, setRemoveTarget] = useState<WhopCampaign | null>(null);

  const connectedIds = useMemo(
    () => new Set(connected.map((c) => c.campaign.id)),
    [connected],
  );

  const channelName = channel.channel_title || channel.name;

  const onConfirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await unlink.mutateAsync({ connectorId: channel.connector_id, campaignId: removeTarget.id });
      toast.success("Campaign removed from channel");
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove campaign");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Campaigns you&apos;ve added to this channel — only these show up here to publish.
        </p>
        <AddCampaignDialog connectorId={channel.connector_id} connectedIds={connectedIds} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : connected.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-muted-foreground">
              No campaigns added to this channel yet. Use <b>Add campaign</b> above to choose which
              campaigns publish their clips here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connected.map(({ campaign: c, source }) => (
            <div
              key={c.id}
              className="relative flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary/50"
            >
              <button
                type="button"
                onClick={() => onOpen(c)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {c.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.thumbnail_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-600/30">
                    <Megaphone className="h-4 w-4 text-muted-foreground" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate font-medium">{c.name}</p>
                    {source === "auto" && (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Sparkles className="h-3 w-3" /> auto
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs capitalize text-muted-foreground">{c.status}</p>
                </div>
              </button>
              <RatePill rate={c.rate_per_1k} />
              {source === "manual" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  title="Remove campaign from this channel"
                  aria-label="Remove campaign from this channel"
                  onClick={() => setRemoveTarget(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : (
                // Auto-detected links aren't manually removable — keep the row aligned.
                <span className="w-8 shrink-0" aria-hidden />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Safety confirmation before removing a campaign from this channel */}
      <Dialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this campaign?</DialogTitle>
            <DialogDescription>
              This unlinks <b>{removeTarget?.name}</b> from {channelName}, so its clips will no
              longer appear here to publish. It won&apos;t delete the campaign or any videos you
              already published — you can add it back anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={unlink.isPending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmRemove} disabled={unlink.isPending}>
              {unlink.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Remove campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- clip card
function ReadyClipCard({
  clip,
  channelName,
  onPublish,
  publishing,
}: {
  clip: WhopReadyClip;
  channelName: string;
  onPublish: (clip: WhopReadyClip) => void;
  publishing: boolean;
}) {
  const badge = publishBadge(clip.publish_status);
  const published = clip.publish_status === "published";
  const inFlight =
    clip.publish_status != null &&
    clip.publish_status !== "published" &&
    clip.publish_status !== "failed" &&
    clip.publish_status !== "cancelled";

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="relative aspect-[9/16] bg-black">
        {clip.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={clip.thumbnail_url} alt={clip.title ?? "clip"} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        {clip.preview_url && (
          <a
            href={clip.preview_url}
            target="_blank"
            rel="noreferrer"
            className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity hover:opacity-100"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90">
              <Play className="h-5 w-5 fill-black text-black" />
            </span>
          </a>
        )}
        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
          {formatDuration(clip.duration)}
        </span>
        {badge && (
          <span className="absolute right-2 top-2">
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-sm font-medium" title={clip.title ?? undefined}>
          {clip.title || `Clip #${clip.id}`}
        </h3>
        <div className="mt-auto">
          {published ? (
            clip.external_url ? (
              <Button asChild variant="secondary" size="sm" className="w-full">
                <a href={clip.external_url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> View on YouTube
                </a>
              </Button>
            ) : (
              <Button variant="secondary" size="sm" className="w-full" disabled>
                <Check className="h-4 w-4" /> Published
              </Button>
            )
          ) : (
            <Button
              size="sm"
              className="w-full"
              onClick={() => onPublish(clip)}
              disabled={publishing || inFlight}
            >
              {publishing || inFlight ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Youtube className="h-4 w-4" />
              )}
              {inFlight
                ? "Publishing…"
                : clip.publish_status === "failed"
                  ? "Retry publish"
                  : `Publish to ${channelName}`}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function WhopPublishingPage() {
  const { data: channels = [], isLoading: channelsLoading } = useWhopChannels(true);
  const publish = useWhopPublishClip();

  const [channel, setChannel] = useState<WhopChannel | null>(null);
  const [campaign, setCampaign] = useState<WhopCampaign | null>(null);
  const [publishingId, setPublishingId] = useState<number | null>(null);

  const { data: clips = [], isLoading: clipsLoading } = useWhopReadyClips(
    campaign?.id ?? null,
    !!campaign, // poll while viewing a campaign so publish states update live
  );

  // OAuth returns here with ?connected=youtube — surface it and clean the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "youtube") {
      toast.success("YouTube channel connected");
      window.history.replaceState({}, "", "/whop/publishing");
    }
  }, []);

  const onPublish = (clip: WhopReadyClip) => {
    if (!channel || !campaign) return;
    setPublishingId(clip.id);
    publish
      .mutateAsync({ campaignId: campaign.id, clipId: clip.id, connectorId: channel.connector_id })
      .then(() => toast.success("Publishing to YouTube…"))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Publish failed"))
      .finally(() => setPublishingId(null));
  };

  const channelName = channel?.channel_title || channel?.name || "channel";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Publishing</h1>
          <p className="text-muted-foreground">
            Publish your campaign clips straight to a connected YouTube channel.
          </p>
        </div>
        {channels.length > 0 && <ConnectYouTube label="Add account" />}
      </div>

      {/* Breadcrumb */}
      {channel && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setChannel(null);
              setCampaign(null);
            }}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Channels
          </button>
          <span className="text-muted-foreground">/</span>
          {campaign ? (
            <>
              <button
                type="button"
                onClick={() => setCampaign(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                {channelName}
              </button>
              <span className="text-muted-foreground">/</span>
              <span className="font-medium">{campaign.name}</span>
            </>
          ) : (
            <span className="font-medium">{channelName}</span>
          )}
        </div>
      )}

      {/* Level 0 — channels */}
      {!channel &&
        (channelsLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : channels.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <Youtube className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">
                Connect a YouTube account to publish your campaign clips to it.
              </p>
              <ConnectYouTube />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {channels.map((ch) => (
              <button
                key={ch.connector_id}
                type="button"
                onClick={() => setChannel(ch)}
                className="flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-primary/50"
              >
                {ch.channel_thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={api.channelAvatarUrl(ch.connector_id)} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-500/15">
                    <Youtube className="h-5 w-5 text-red-500" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{ch.channel_title || ch.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {ch.has_credentials ? "Connected" : "Reconnect needed"}
                  </p>
                </div>
                <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        ))}

      {/* Level 1 — campaigns added to the chosen channel */}
      {channel && !campaign && <ChannelCampaignList channel={channel} onOpen={setCampaign} />}

      {/* Level 2 — ready clips */}
      {channel &&
        campaign &&
        (clipsLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : clips.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No rendered clips ready to publish for this campaign yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {clips.map((clip) => (
              <ReadyClipCard
                key={clip.id}
                clip={clip}
                channelName={channelName}
                onPublish={onPublish}
                publishing={publishingId === clip.id}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
