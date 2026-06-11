"use client";

import { Check, ChevronDown, ChevronUp, ListChecks, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useSvApproveVideo,
  useSvDeleteVideo,
  useSvMeta,
  useSvRejectVideo,
  useSvRetryVideo,
  useSvVideo,
  useSvVideos,
} from "@/hooks/use-api";
import type { SvVideo } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

function ScriptBlock({ id }: { id: number }) {
  const { data: video, isLoading } = useSvVideo(id);
  if (isLoading) {
    return (
      <div className="flex justify-center rounded-md bg-muted/50 p-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!video?.script_text) {
    return <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">No script available.</p>;
  }
  return (
    <p className="max-h-40 overflow-y-auto whitespace-pre-line rounded-md bg-muted/50 p-3 text-sm">
      {video.script_text}
    </p>
  );
}

function outcomeVariant(status: SvVideo["status"]): "default" | "outline" | "destructive" {
  if (status === "rejected") return "outline";
  if (status === "failed") return "destructive";
  return "default";
}

export default function ReviewPage() {
  const { data: queue = [], isLoading } = useSvVideos("ready_for_review", true);
  const { data: allVideos = [] } = useSvVideos(undefined, true);
  const { data: meta } = useSvMeta();
  const approveVideo = useSvApproveVideo();
  const rejectVideo = useSvRejectVideo();
  const retryVideo = useSvRetryVideo();
  const deleteVideo = useSvDeleteVideo();

  const [platformById, setPlatformById] = useState<Record<number, string>>({});
  const [expandedScripts, setExpandedScripts] = useState<Record<number, boolean>>({});
  const [rejectTarget, setRejectTarget] = useState<SvVideo | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const platforms = meta?.platforms ?? ["tiktok"];
  const outcomes = allVideos
    .filter((v) => v.status === "completed" || v.status === "rejected" || v.status === "failed")
    .slice(0, 6);

  const onApprove = async (v: SvVideo) => {
    try {
      await approveVideo.mutateAsync({ id: v.id, platform: platformById[v.id] ?? "tiktok" });
      toast.success("Rendering — check Exports soon");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve video");
    }
  };

  const onReject = async () => {
    if (!rejectTarget) return;
    try {
      await rejectVideo.mutateAsync({
        id: rejectTarget.id,
        reason: rejectReason.trim() || undefined,
      });
      toast.success("Video rejected");
      setRejectTarget(null);
      setRejectReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject video");
    }
  };

  const onRetry = async (v: SvVideo) => {
    try {
      await retryVideo.mutateAsync(v.id);
      toast.success("Regenerating video");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate video");
    }
  };

  const onDelete = async (v: SvVideo) => {
    if (!confirm(`Delete "${v.story_title ?? v.title ?? "this video"}"?`)) return;
    try {
      await deleteVideo.mutateAsync(v.id);
      toast.success("Video deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete video");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Review Queue</h1>
        <p className="text-muted-foreground">
          Watch each preview, then approve it for the final 1080×1920 render.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : queue.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ListChecks className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">Nothing waiting for review.</p>
            <Button asChild>
              <Link href="/storyvault/studio">Create a video</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {queue.map((v) => (
            <Card key={v.id}>
              <CardContent className="pt-6">
                <div className="flex flex-col gap-4 sm:flex-row">
                  <video
                    src={v.preview_url ?? undefined}
                    controls
                    className="aspect-[9/16] w-full shrink-0 rounded-md bg-black object-contain sm:w-56"
                  />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div>
                      <p className="font-semibold">{v.story_title ?? v.title ?? "Untitled video"}</p>
                      <p className="text-sm text-muted-foreground">
                        {v.duration_target}s target · {v.hook_style} hook · {v.narration_style} ·{" "}
                        {v.caption_style} captions · {Math.round(v.narration_duration ?? 0)}s narration
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-muted-foreground"
                        onClick={() =>
                          setExpandedScripts((prev) => ({ ...prev, [v.id]: !prev[v.id] }))
                        }
                      >
                        {expandedScripts[v.id] ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                        {expandedScripts[v.id] ? "Hide script" : "Show script"}
                      </Button>
                      {expandedScripts[v.id] && <ScriptBlock id={v.id} />}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={platformById[v.id] ?? "tiktok"}
                        onValueChange={(value) =>
                          setPlatformById((prev) => ({ ...prev, [v.id]: value }))
                        }
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue placeholder="Platform" />
                        </SelectTrigger>
                        <SelectContent>
                          {platforms.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button onClick={() => onApprove(v)} disabled={approveVideo.isPending}>
                        {approveVideo.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        Approve &amp; render
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setRejectReason("");
                          setRejectTarget(v);
                        }}
                      >
                        <X className="h-4 w-4" /> Reject
                      </Button>
                      <Button variant="ghost" onClick={() => onRetry(v)} disabled={retryVideo.isPending}>
                        <RefreshCw className="h-4 w-4" /> Regenerate
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Recent outcomes</h2>
          <Card>
            <CardContent className="divide-y py-2">
              {outcomes.map((v) => (
                <div key={v.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="line-clamp-1 font-medium">
                        {v.story_title ?? v.title ?? "Untitled video"}
                      </p>
                      <Badge variant={outcomeVariant(v.status)}>{v.status}</Badge>
                    </div>
                    {v.status === "failed" && v.error && (
                      <p className="line-clamp-1 text-sm text-destructive">{v.error}</p>
                    )}
                    {v.status === "rejected" && v.reject_reason && (
                      <p className="line-clamp-1 text-sm text-muted-foreground">{v.reject_reason}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {formatRelativeTime(v.updated_at)}
                  </span>
                  {(v.status === "failed" || v.status === "rejected") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRetry(v)}
                      disabled={retryVideo.isPending}
                    >
                      <RefreshCw className="h-4 w-4" /> Regenerate
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => onDelete(v)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject video</DialogTitle>
            <DialogDescription>
              Optionally note why — it&apos;s saved on the video for later reference.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (optional)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onReject} disabled={rejectVideo.isPending}>
              {rejectVideo.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
