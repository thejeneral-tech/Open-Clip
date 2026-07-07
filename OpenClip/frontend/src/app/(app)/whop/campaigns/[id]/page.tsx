"use client";

import {
  ArrowLeft,
  Check,
  Clapperboard,
  DollarSign,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  Megaphone,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  PlatformIcons,
  platformLabel,
  RatePill,
  WHOP_CATEGORIES,
  WHOP_PLATFORMS,
  WHOP_TYPES,
} from "@/components/whop/platform-meta";
import {
  useWhopApproveSubmission,
  useWhopCampaign,
  useWhopClawbackSubmission,
  useWhopCreateSubmission,
  useWhopDeleteSubmission,
  useWhopPaySubmission,
  useWhopRejectSubmission,
  useWhopSubmissions,
  useWhopUpdateCampaign,
  useWhopUpdateSubmission,
} from "@/hooks/use-api";
import type {
  WhopCampaign,
  WhopCampaignStatus,
  WhopPlatform,
  WhopSubmission,
  WhopSubmissionStatus,
} from "@/lib/types";
import { formatMoney, formatRelativeTime } from "@/lib/utils";

function campaignBadgeVariant(status: WhopCampaignStatus): "success" | "warning" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    default:
      return "outline";
  }
}

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

// How much of the campaign's created_at → ends_at window has elapsed (0–100).
function elapsedPct(campaign: WhopCampaign): number {
  if (!campaign.ends_at) return 0;
  const start = new Date(campaign.created_at).getTime();
  const end = new Date(campaign.ends_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end <= start) return 100;
  return Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
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
      <span className="text-xs text-muted-foreground">views</span>
    </div>
  );
}

function SubmissionRow({
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
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-3">
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
            {submission.creator_handle ? `${submission.creator_handle} · ` : ""}
            {formatRelativeTime(submission.created_at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant={submissionBadgeVariant(submission.status)} className="capitalize">
            {submission.status}
          </Badge>
          {submission.clawback_requested && <Badge variant="warning">Clawback</Badge>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ViewsEditor submission={submission} />
          <span className="text-sm font-medium">
            {submission.status === "paid"
              ? formatMoney(submission.paid_amount)
              : formatMoney(submission.earnings_estimate)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {submission.status === "paid" ? "paid" : "est."}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1">
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
      </div>

      {submission.status === "rejected" && submission.rejection_reason && (
        <p className="text-xs text-destructive">Rejected: {submission.rejection_reason}</p>
      )}
      {submission.clawback_requested && submission.clawback_reason && (
        <p className="text-xs text-amber-500">Clawback: {submission.clawback_reason}</p>
      )}
    </div>
  );
}

function NewSubmissionDialog({
  campaignId,
  open,
  onOpenChange,
}: {
  campaignId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const createSubmission = useWhopCreateSubmission();
  const [platform, setPlatform] = useState<WhopPlatform>("tiktok");
  const [postUrl, setPostUrl] = useState("");
  const [title, setTitle] = useState("");
  const [creatorHandle, setCreatorHandle] = useState("");
  const [viewsText, setViewsText] = useState("");
  const [likesText, setLikesText] = useState("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setPlatform("tiktok");
    setPostUrl("");
    setTitle("");
    setCreatorHandle("");
    setViewsText("");
    setLikesText("");
    setNotes("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createSubmission.mutateAsync({
        campaignId,
        data: {
          platform,
          post_url: postUrl.trim(),
          title: title.trim() || undefined,
          creator_handle: creatorHandle.trim() || undefined,
          views: Math.max(0, Math.round(Number(viewsText) || 0)),
          likes: Math.max(0, Math.round(Number(likesText) || 0)),
          notes: notes.trim() || undefined,
        },
      });
      toast.success("Submission added");
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add submission");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New submission</DialogTitle>
          <DialogDescription>Log a clip a creator posted for this campaign.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as WhopPlatform)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WHOP_PLATFORMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-url">Post URL</Label>
            <Input
              id="ws-url"
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              placeholder="https://www.tiktok.com/@creator/video/..."
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-title">Title</Label>
            <Input
              id="ws-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-handle">Creator handle</Label>
            <Input
              id="ws-handle"
              value={creatorHandle}
              onChange={(e) => setCreatorHandle(e.target.value)}
              placeholder="@creator (optional)"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ws-views">Initial views</Label>
              <Input
                id="ws-views"
                type="number"
                min={0}
                value={viewsText}
                onChange={(e) => setViewsText(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-likes">Initial likes</Label>
              <Input
                id="ws-likes"
                type="number"
                min={0}
                value={likesText}
                onChange={(e) => setLikesText(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-notes">Notes</Label>
            <Textarea
              id="ws-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <Button type="submit" className="w-full" disabled={createSubmission.isPending}>
            {createSubmission.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Add submission
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function WhopCampaignDetailPage() {
  const params = useParams();
  const campaignId = Number(params.id);

  const { data: campaign, isLoading } = useWhopCampaign(campaignId, true);
  const { data: submissions = [] } = useWhopSubmissions({ campaign_id: campaignId }, true);
  const updateCampaign = useWhopUpdateCampaign();
  const rejectSubmission = useWhopRejectSubmission();
  const clawbackSubmission = useWhopClawbackSubmission();

  const [submissionOpen, setSubmissionOpen] = useState(false);
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

  const onToggleStatus = async () => {
    if (!campaign) return;
    const next: WhopCampaignStatus = campaign.status === "active" ? "paused" : "active";
    try {
      await updateCampaign.mutateAsync({ id: campaignId, data: { status: next } });
      toast.success(next === "active" ? "Campaign resumed" : "Campaign paused");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update campaign");
    }
  };

  if (isLoading || !campaign) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const typeLabel =
    WHOP_TYPES.find((t) => t.value === campaign.campaign_type)?.label ?? campaign.campaign_type;
  const categoryName =
    WHOP_CATEGORIES.find((c) => c.value === campaign.category)?.label ?? campaign.category;
  const budgetPct = Math.min(100, Math.max(0, campaign.budget_used_pct ?? 0));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link
          href="/whop/campaigns"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {campaign.thumbnail_url ? (
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
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight">{campaign.name}</h1>
                <Badge variant={campaignBadgeVariant(campaign.status)} className="capitalize">
                  {campaign.status}
                </Badge>
              </div>
              {campaign.description && (
                <p className="text-muted-foreground">{campaign.description}</p>
              )}
              {campaign.whop_url && (
                <a
                  href={campaign.whop_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> View on Whop
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href={`/whop/campaigns/${campaignId}/workspace`}>
                <Pencil className="h-4 w-4" /> Edit
              </Link>
            </Button>
            <Button variant="outline" onClick={onToggleStatus} disabled={updateCampaign.isPending}>
              {updateCampaign.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : campaign.status === "active" ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {campaign.status === "active" ? "Pause" : "Resume"}
            </Button>
            <Button onClick={() => setSubmissionOpen(true)}>
              <Plus className="h-4 w-4" /> New submission
            </Button>
          </div>
        </div>
      </div>

      {/* Payout progress, time left, and campaign meta */}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Paid out
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">
                {formatMoney(campaign.paid_out)} of{" "}
                {campaign.budget != null ? formatMoney(campaign.budget) : "Unlimited"}
              </p>
              {campaign.budget_used_pct != null && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {Math.round(campaign.budget_used_pct)}%
                </span>
              )}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-amber-500"
                style={{ width: `${budgetPct}%` }}
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Time left
            </p>
            <p className="mt-1 text-sm font-medium">
              {campaign.days_left != null ? `${campaign.days_left} days left` : "No end date"}
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-amber-500"
                style={{ width: `${elapsedPct(campaign)}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-3 lg:grid-cols-6">
            <MetaItem label="Reward">
              <RatePill rate={campaign.rate_per_1k} />
            </MetaItem>
            <MetaItem label="Type">{typeLabel}</MetaItem>
            <MetaItem label="Min payout">
              {campaign.min_payout != null ? formatMoney(campaign.min_payout) : "—"}
            </MetaItem>
            <MetaItem label="Max payout">
              {campaign.max_payout != null ? formatMoney(campaign.max_payout) : "—"}
            </MetaItem>
            <MetaItem label="Category">{categoryName}</MetaItem>
            <MetaItem label="Platforms">
              <PlatformIcons platforms={campaign.platforms} />
            </MetaItem>
          </div>
        </CardContent>
      </Card>

      {campaign.requirements.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Requirements</CardTitle>
            <CardDescription>What every submission must follow.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {campaign.requirements.map((req) => (
              <span key={req} className="rounded-full border px-3 py-1 text-xs">
                {req}
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      {campaign.asset_links.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assets</CardTitle>
            <CardDescription>Content sources for clippers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {campaign.asset_links.map((link, i) => (
              <a
                key={`${link.url}-${i}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
              >
                <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">{link.label}</span>
                <span className="truncate text-muted-foreground">{link.url}</span>
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Submissions ({submissions.length})</CardTitle>
            <CardDescription>Clips submitted to this campaign.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setSubmissionOpen(true)}>
            <Plus className="h-4 w-4" /> New submission
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {submissions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Clapperboard className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">
                No submissions yet. Add the first clip submitted to this campaign.
              </p>
              <Button onClick={() => setSubmissionOpen(true)}>
                <Plus className="h-4 w-4" /> New submission
              </Button>
            </div>
          ) : (
            submissions.map((submission) => (
              <SubmissionRow key={submission.id} submission={submission} onReason={openReason} />
            ))
          )}
        </CardContent>
      </Card>


      <NewSubmissionDialog
        campaignId={campaignId}
        open={submissionOpen}
        onOpenChange={setSubmissionOpen}
      />

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
                Reject
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
