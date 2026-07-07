"use client";

import {
  Check,
  CheckCircle2,
  DollarSign,
  ExternalLink,
  Eye,
  Link as LinkIcon,
  Loader2,
  Megaphone,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
  Youtube,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { platformLabel, WHOP_PLATFORMS } from "@/components/whop/platform-meta";
import {
  useWhopApproveSubmission,
  useWhopCampaigns,
  useWhopChannelCampaigns,
  useWhopChannels,
  useWhopClawbackSubmission,
  useWhopDeleteSubmission,
  useWhopLinkCampaign,
  useWhopPaySubmission,
  useWhopRejectSubmission,
  useWhopSubmissions,
  useWhopUnlinkCampaign,
  useWhopUpdateSubmission,
  useYouTubeStatus,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { WhopChannel, WhopSubmission, WhopSubmissionStatus } from "@/lib/types";
import { cn, formatCompactNumber, formatMoney, formatRelativeTime } from "@/lib/utils";

type StatusFilter = "pending" | "approved" | "paid" | "rejected" | "all";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All statuses" },
];

const EMPTY_COPY: Record<StatusFilter, string> = {
  pending: "Nothing pending review — you're all caught up.",
  approved: "No approved submissions for this channel.",
  paid: "No submissions have been paid out for this channel yet.",
  rejected: "No rejected submissions for this channel.",
  all: "No submissions yet for this channel's campaigns.",
};

function submissionBadgeVariant(
  status: WhopSubmissionStatus,
): "outline" | "success" | "destructive" | "default" {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
      return "destructive";
    case "paid":
      return "default";
    default:
      return "outline";
  }
}

// Kick off the Google consent flow, returning here (/whop/review) once connected.
function useConnectChannel() {
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    setConnecting(true);
    try {
      const { auth_url } = await api.youtubeAuthUrl({ return_to: "/whop/review" });
      window.location.href = auth_url; // full-page redirect to Google consent
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start YouTube sign-in");
      setConnecting(false);
    }
  };
  return { connecting, connect };
}

// Compact inline editor for a submission's view count.
function ViewsEditor({ submission }: { submission: WhopSubmission }) {
  const updateSubmission = useWhopUpdateSubmission();
  const inputRef = useRef<HTMLInputElement>(null);

  const onSave = async () => {
    const raw = inputRef.current?.value.trim() ?? "";
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < 0) return;
    const views = Math.round(parsed);
    if (views === submission.views) return;
    try {
      await updateSubmission.mutateAsync({ id: submission.id, data: { views } });
      toast.success("Views updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update views");
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Eye className="h-4 w-4 text-muted-foreground" />
      <Input
        key={submission.views}
        ref={inputRef}
        type="number"
        min={0}
        defaultValue={submission.views}
        className="h-8 w-24"
        aria-label="Views"
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onSave}
        disabled={updateSubmission.isPending}
        title="Update views"
        aria-label="Update views"
      >
        {updateSubmission.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function ReviewRow({
  submission,
  onReason,
}: {
  submission: WhopSubmission;
  onReason: (submission: WhopSubmission, mode: "reject" | "clawback") => void;
}) {
  const approve = useWhopApproveSubmission();
  const pay = useWhopPaySubmission();
  const remove = useWhopDeleteSubmission();
  const meta = WHOP_PLATFORMS.find((m) => m.value === submission.platform);
  const Icon = meta?.icon ?? LinkIcon;

  const onApprove = async () => {
    try {
      await approve.mutateAsync(submission.id);
      toast.success("Submission approved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve submission");
    }
  };

  const onPay = async () => {
    try {
      await pay.mutateAsync(submission.id);
      toast.success("Submission marked paid");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mark submission paid");
    }
  };

  const onDelete = async () => {
    if (!window.confirm("Delete this submission? This cannot be undone.")) return;
    try {
      await remove.mutateAsync(submission.id);
      toast.success("Submission deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete submission");
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 py-4">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          title={platformLabel(submission.platform)}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <a
            href={submission.post_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-sm font-medium hover:text-primary"
          >
            <span className="truncate">{submission.title || submission.post_url}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
          </a>
          <p className="text-xs text-muted-foreground">
            {submission.campaign_name ? `${submission.campaign_name} · ` : ""}
            {submission.creator_handle ? `${submission.creator_handle} · ` : ""}
            {formatRelativeTime(submission.created_at)}
          </p>
          {submission.status === "rejected" && submission.rejection_reason && (
            <p className="mt-1 text-xs text-destructive">
              Rejected: {submission.rejection_reason}
            </p>
          )}
          {submission.clawback_requested && submission.clawback_reason && (
            <p className="mt-1 text-xs text-amber-500">
              Clawback: {submission.clawback_reason}
            </p>
          )}
        </div>

        <ViewsEditor submission={submission} />

        <span className="w-24 shrink-0 text-right text-sm font-medium">
          {submission.status === "paid"
            ? formatMoney(submission.paid_amount)
            : formatMoney(submission.earnings_estimate)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {submission.status === "paid" ? "paid" : "est."}
          </span>
        </span>

        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant={submissionBadgeVariant(submission.status)} className="capitalize">
            {submission.status}
          </Badge>
          {submission.clawback_requested && <Badge variant="warning">Clawback</Badge>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {submission.status === "pending" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500"
                onClick={onApprove}
                disabled={approve.isPending}
              >
                {approve.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onReason(submission, "reject")}
              >
                <X className="h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {submission.status === "approved" && (
            <>
              <Button size="sm" onClick={onPay} disabled={pay.isPending}>
                {pay.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <DollarSign className="h-4 w-4" />
                )}
                Mark paid
              </Button>
              {!submission.clawback_requested && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-amber-500 hover:text-amber-500"
                  onClick={() => onReason(submission, "clawback")}
                >
                  <Undo2 className="h-4 w-4" /> Clawback
                </Button>
              )}
            </>
          )}
          {submission.status === "paid" && !submission.clawback_requested && (
            <Button
              variant="ghost"
              size="sm"
              className="text-amber-500 hover:text-amber-500"
              onClick={() => onReason(submission, "clawback")}
            >
              <Undo2 className="h-4 w-4" /> Clawback
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={remove.isPending}
            aria-label="Delete submission"
          >
            {remove.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------- review tab
function ChannelReview({ channel }: { channel: WhopChannel }) {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [campaignId, setCampaignId] = useState<string>("all");

  const { data: connected = [] } = useWhopChannelCampaigns(channel.connector_id);

  const params = useMemo(() => {
    const p: { connector_id: number; status?: string; campaign_id?: number } = {
      connector_id: channel.connector_id,
    };
    if (status !== "all") p.status = status;
    if (campaignId !== "all") p.campaign_id = Number(campaignId);
    return p;
  }, [channel.connector_id, status, campaignId]);

  const { data: submissions = [], isLoading } = useWhopSubmissions(params, true);

  const rejectSubmission = useWhopRejectSubmission();
  const clawbackSubmission = useWhopClawbackSubmission();

  const [reasonTarget, setReasonTarget] = useState<{
    submission: WhopSubmission;
    mode: "reject" | "clawback";
  } | null>(null);
  const [reason, setReason] = useState("");

  const openReason = (submission: WhopSubmission, mode: "reject" | "clawback") => {
    setReason("");
    setReasonTarget({ submission, mode });
  };

  const onReasonConfirm = async () => {
    if (!reasonTarget) return;
    const { submission, mode } = reasonTarget;
    const trimmed = reason.trim();
    try {
      if (mode === "reject") {
        await rejectSubmission.mutateAsync({ id: submission.id, reason: trimmed || undefined });
        toast.success("Submission rejected");
      } else {
        await clawbackSubmission.mutateAsync({ id: submission.id, reason: trimmed || undefined });
        toast.success("Clawback requested");
      }
      setReasonTarget(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : mode === "reject"
            ? "Failed to reject submission"
            : "Failed to request clawback",
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={campaignId} onValueChange={setCampaignId}>
          <SelectTrigger className="w-60">
            <SelectValue placeholder="All connected campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All connected campaigns</SelectItem>
            {connected.map((c) => (
              <SelectItem key={c.campaign.id} value={String(c.campaign.id)}>
                {c.campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : submissions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <CheckCircle2 className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              {connected.length === 0
                ? "This channel has no connected campaigns yet — add some in the Campaigns tab."
                : EMPTY_COPY[status]}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {submissions.map((s) => (
            <ReviewRow key={s.id} submission={s} onReason={openReason} />
          ))}
        </div>
      )}

      <Dialog open={reasonTarget !== null} onOpenChange={(o) => !o && setReasonTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reasonTarget?.mode === "clawback" ? "Request clawback" : "Reject submission"}
            </DialogTitle>
            <DialogDescription>
              {reasonTarget?.mode === "clawback"
                ? "Flag this submission for clawback. The reason is shown alongside it."
                : "Optionally tell the creator why this clip was rejected."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonTarget(null)}>
              Cancel
            </Button>
            {reasonTarget?.mode === "clawback" ? (
              <Button
                variant="outline"
                className="border-amber-500/40 text-amber-500 hover:bg-amber-500/10 hover:text-amber-500"
                onClick={onReasonConfirm}
                disabled={clawbackSubmission.isPending}
              >
                {clawbackSubmission.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Undo2 className="h-4 w-4" />
                )}
                Request clawback
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={onReasonConfirm}
                disabled={rejectSubmission.isPending}
              >
                {rejectSubmission.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                Reject submission
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --------------------------------------------------------- campaigns tab
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
      toast.success("Campaign linked to channel");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link campaign");
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
          <div
            key={c.id}
            className="flex items-center gap-3 rounded-md border border-border p-2.5"
          >
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
              {already ? "Linked" : "Add"}
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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add campaign
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a campaign to this channel</DialogTitle>
          <DialogDescription>
            Search your campaigns and pin the ones this channel clips for.
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

function ChannelCampaigns({ channel }: { channel: WhopChannel }) {
  const { data: connected = [], isLoading } = useWhopChannelCampaigns(channel.connector_id);
  const unlink = useWhopUnlinkCampaign();
  const connectedIds = useMemo(
    () => new Set(connected.map((c) => c.campaign.id)),
    [connected],
  );

  const onUnlink = async (campaignId: number) => {
    try {
      await unlink.mutateAsync({ connectorId: channel.connector_id, campaignId });
      toast.success("Campaign unlinked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unlink campaign");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Campaigns this channel is clipping for. Auto-detected links appear when a submission
          matches this channel; add more by hand.
        </p>
        <AddCampaignDialog connectorId={channel.connector_id} connectedIds={connectedIds} />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : connected.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No campaigns connected yet. Click <b>Add campaign</b> to pin one, or they&apos;ll
              appear automatically when a submission from this channel matches a campaign.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {connected.map(({ campaign, source }) => (
            <Card key={campaign.id}>
              <CardContent className="flex flex-wrap items-center gap-4 py-3.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {campaign.thumbnail_url ? (
                  <img
                    src={campaign.thumbnail_url}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Megaphone className="h-4 w-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{campaign.name}</span>
                    {source === "auto" ? (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Sparkles className="h-3 w-3" /> auto
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        manual
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    ${campaign.rate_per_1k.toFixed(2)}/1K · {campaign.status} ·{" "}
                    {formatCompactNumber(campaign.views_total)} views
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  <span title="Pending review">
                    <b className="text-foreground">{campaign.submissions_pending}</b> pending
                  </span>
                  <span title="Total submissions">
                    <b className="text-foreground">{campaign.submissions_total}</b> total
                  </span>
                </div>
                {source === "manual" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    title="Unlink from channel"
                    disabled={unlink.isPending}
                    onClick={() => onUnlink(campaign.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : (
                  <span className="w-8 shrink-0" aria-hidden />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ channel card
function ChannelCard({
  channel,
  active,
  onSelect,
}: {
  channel: WhopChannel;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex min-w-[220px] items-center gap-3 rounded-lg border p-3 text-left transition",
        active ? "border-primary bg-primary/10" : "border-border hover:bg-muted/60",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {channel.channel_thumbnail ? (
        <img src={api.channelAvatarUrl(channel.connector_id)} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
      ) : (
        <Youtube className="h-10 w-10 shrink-0 text-red-600" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{channel.channel_title || channel.name}</p>
        <p className="text-xs text-muted-foreground">
          {channel.campaigns_connected} campaign{channel.campaigns_connected === 1 ? "" : "s"}
        </p>
      </div>
      {channel.submissions_pending > 0 && (
        <Badge variant="secondary" className="shrink-0">
          {channel.submissions_pending}
        </Badge>
      )}
    </button>
  );
}

export default function WhopReviewPage() {
  const { data: channels = [], isLoading } = useWhopChannels(true);
  const { data: yt } = useYouTubeStatus();
  const { connecting, connect } = useConnectChannel();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Surface the OAuth redirect result (?connected / ?error), then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const connected = p.get("connected");
    const error = p.get("error");
    if (connected === "youtube") toast.success(`Connected ${p.get("channel") || "YouTube channel"}`);
    else if (error) toast.error(error);
    if (connected || error) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Default the selection to the first channel; keep it valid as channels change.
  useEffect(() => {
    if (channels.length === 0) {
      setSelectedId(null);
    } else if (selectedId == null || !channels.some((c) => c.connector_id === selectedId)) {
      setSelectedId(channels[0].connector_id);
    }
  }, [channels, selectedId]);

  const selected = channels.find((c) => c.connector_id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Review</h1>
          <p className="text-muted-foreground">
            Pick a YouTube channel to see its campaigns and review its submissions.
          </p>
        </div>
        {channels.length > 0 && (
          <Button variant="outline" onClick={connect} disabled={connecting || (yt && !yt.configured)}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4" />}
            Connect another channel
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : channels.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <Youtube className="h-12 w-12 text-red-600" />
            <div className="space-y-1">
              <p className="font-medium">No YouTube channels connected yet</p>
              <p className="text-sm text-muted-foreground">
                Connect a channel to link campaigns to it and review submissions per channel.
              </p>
            </div>
            {yt && !yt.configured ? (
              <div className="max-w-md space-y-2 rounded-md border border-border p-3 text-left text-sm text-muted-foreground">
                <p className="font-medium text-foreground">YouTube isn&apos;t configured yet.</p>
                <p>
                  Add a Google OAuth client (<code>GOOGLE_CLIENT_ID</code> /{" "}
                  <code>GOOGLE_CLIENT_SECRET</code>) and register this redirect URI, then restart the
                  backend:
                </p>
                <code className="block break-all rounded bg-muted px-2 py-1 text-xs">
                  {yt.redirect_uri}
                </code>
              </div>
            ) : (
              <Button onClick={connect} disabled={connecting}>
                {connecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Youtube className="h-4 w-4" />
                )}
                Connect a YouTube channel
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <ChannelCard
                key={c.connector_id}
                channel={c}
                active={c.connector_id === selectedId}
                onSelect={() => setSelectedId(c.connector_id)}
              />
            ))}
          </div>

          {selected && (
            <Tabs defaultValue="review" key={selected.connector_id}>
              <TabsList>
                <TabsTrigger value="review">
                  <CheckCircle2 className="mr-1 h-4 w-4" /> Review
                </TabsTrigger>
                <TabsTrigger value="campaigns">
                  <Megaphone className="mr-1 h-4 w-4" /> Campaigns
                </TabsTrigger>
              </TabsList>
              <TabsContent value="review" className="pt-4">
                <ChannelReview channel={selected} />
              </TabsContent>
              <TabsContent value="campaigns" className="pt-4">
                <ChannelCampaigns channel={selected} />
              </TabsContent>
            </Tabs>
          )}
        </>
      )}
    </div>
  );
}
