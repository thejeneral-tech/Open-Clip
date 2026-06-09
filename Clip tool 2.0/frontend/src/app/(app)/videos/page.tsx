"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Loader2, Plus, Trash2, Youtube } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { JobStatus, Video } from "@/lib/types";
import { PageHeader } from "@/components/layout/PageHeader";
import { Modal } from "@/components/ui/Modal";
import { cn, formatBytes, formatDuration, timeAgo } from "@/lib/utils";

const STATUS_STYLES: Record<JobStatus, { label: string; mix: number }> = {
  pending: { label: "Pending", mix: 30 },
  queued: { label: "Queued", mix: 40 },
  processing: { label: "Processing", mix: 60 },
  completed: { label: "Completed", mix: 70 },
  failed: { label: "Failed", mix: 70 },
  cancelled: { label: "Cancelled", mix: 40 },
};

function StatusBadge({ status }: { status: JobStatus }) {
  const accent = status === "failed" ? "var(--red)" : status === "completed" ? "#3fb950" : "var(--fg)";
  const s = STATUS_STYLES[status] ?? { label: status, mix: 40 };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{
        color: accent,
        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} ${s.mix}%, transparent)`,
      }}
    >
      {status === "processing" && <Loader2 size={10} className="animate-spin" />}
      {s.label}
    </span>
  );
}

function VideosInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const projectParam = params.get("project");

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });

  const projectId = useMemo(() => {
    if (projectParam) return Number(projectParam);
    return projects?.[0]?.id ?? null;
  }, [projectParam, projects]);

  // Keep the URL in sync once we resolve a default project.
  useEffect(() => {
    if (!projectParam && projectId != null) {
      router.replace(`/videos?project=${projectId}`);
    }
  }, [projectParam, projectId, router]);

  const { data: videos, isLoading } = useQuery({
    queryKey: ["videos", projectId],
    queryFn: () => api.listVideos(projectId!),
    enabled: projectId != null,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((v: Video) => v.status === "processing" || v.status === "queued")
        ? 4000
        : false,
  });

  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");

  const importYt = useMutation({
    mutationFn: () => api.importYouTube(projectId!, url.trim(), title.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["videos", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Import queued");
      setImportOpen(false);
      setUrl("");
      setTitle("");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Import failed"),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteVideo(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["videos", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Video deleted");
    },
    onError: () => toast.error("Delete failed"),
  });

  const noProjects = projects && projects.length === 0;

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-8">
      <PageHeader
        title="Videos"
        subtitle="Ingest long-form video, then turn the best moments into clips"
        actions={
          <div className="flex items-center gap-2">
            {projects && projects.length > 0 && (
              <select
                className="oc-input"
                value={projectId ?? ""}
                onChange={(e) => router.replace(`/videos?project=${e.target.value}`)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <button
              className="oc-btn oc-btn-primary"
              onClick={() => setImportOpen(true)}
              disabled={projectId == null}
            >
              <Plus size={16} /> Import
            </button>
          </div>
        }
      />

      {noProjects ? (
        <div className="oc-card px-6 py-14 text-center text-muted">
          Create a project first — head to the{" "}
          <a href="/" className="text-[var(--red)] underline">Dashboard</a>.
        </div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading videos…
        </div>
      ) : (videos?.length ?? 0) === 0 ? (
        <div className="oc-card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: "var(--hover-bg)" }}>
            <Film size={26} className="text-muted" />
          </span>
          <p className="font-medium text-fg">No videos in this project yet</p>
          <button className="oc-btn oc-btn-primary" onClick={() => setImportOpen(true)} disabled={projectId == null}>
            <Youtube size={16} /> Import from YouTube
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {videos!.map((v) => (
            <VideoRow key={v.id} video={v} onDelete={() => del.mutate(v.id)} deleting={del.isPending} />
          ))}
        </div>
      )}

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import from YouTube"
        footer={
          <>
            <button className="oc-btn" onClick={() => setImportOpen(false)}>Cancel</button>
            <button
              className="oc-btn oc-btn-primary"
              disabled={!url.trim() || importYt.isPending}
              onClick={() => importYt.mutate()}
            >
              {importYt.isPending ? <Loader2 size={15} className="animate-spin" /> : <Youtube size={15} />}
              Import
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">YouTube URL</span>
            <input
              className="oc-input w-full"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=…"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Title (optional)</span>
            <input
              className="oc-input w-full"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Override the video title"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function VideoRow({
  video,
  onDelete,
  deleting,
}: {
  video: Video;
  onDelete: () => void;
  deleting: boolean;
}) {
  const processing = video.status === "processing" || video.status === "queued";
  return (
    <div className="oc-card flex items-center gap-4 p-3">
      <div className="relative grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: "var(--hover-bg)" }}>
        {video.thumbnail_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumbnail_path} alt="" className="h-full w-full object-cover" />
        ) : (
          <Film size={20} className="text-muted" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-fg">{video.title || video.original_filename || "Untitled"}</span>
          <StatusBadge status={video.status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span className="capitalize">{video.source}</span>
          <span>{formatDuration(video.duration_seconds)}</span>
          <span>{formatBytes(video.size_bytes)}</span>
          <span>{video.clip_count} clips</span>
          <span>{timeAgo(video.created_at)}</span>
        </div>
        {processing && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
            <div
              className={cn("h-full rounded-full transition-all", video.status === "queued" && "animate-pulse")}
              style={{ width: `${Math.max(6, Math.round(video.progress * 100))}%`, background: "var(--red)" }}
            />
          </div>
        )}
        {video.status === "failed" && video.error && (
          <p className="mt-1 truncate text-[11px] text-[var(--red)]" title={video.error}>{video.error}</p>
        )}
      </div>

      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        title="Delete video"
        className="shrink-0 rounded-md p-2 text-muted transition hover:bg-[var(--hover-bg)] hover:text-[var(--red)]"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

export default function VideosPage() {
  return (
    <Suspense fallback={<div className="p-8 text-muted">Loading…</div>}>
      <VideosInner />
    </Suspense>
  );
}
