"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Loader2, Plus, Scissors, Video as VideoIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { PageHeader } from "@/components/layout/PageHeader";
import { Modal } from "@/components/ui/Modal";
import { timeAgo } from "@/lib/utils";

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="oc-card flex items-center gap-4 p-4">
      <span className="grid h-11 w-11 place-items-center rounded-lg" style={{ background: "color-mix(in srgb, var(--red) 16%, transparent)" }}>
        <Icon size={20} className="text-[var(--red)]" />
      </span>
      <div>
        <div className="text-2xl font-semibold text-fg">{value}</div>
        <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });

  const create = useMutation({
    mutationFn: () => api.createProject(name.trim(), description.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project created");
      setCreateOpen(false);
      setName("");
      setDescription("");
    },
    onError: () => toast.error("Could not create project"),
  });

  const totals = (projects ?? []).reduce(
    (acc, p) => {
      acc.videos += p.video_count;
      acc.clips += p.clip_count;
      return acc;
    },
    { videos: 0, clips: 0 },
  );

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-8">
      <PageHeader
        title="Dashboard"
        subtitle="Your local AI clip studio at a glance"
        actions={
          <button className="oc-btn oc-btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New Project
          </button>
        }
      />

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Projects" value={projects?.length ?? 0} icon={FolderPlus} />
        <StatCard label="Videos" value={totals.videos} icon={VideoIcon} />
        <StatCard label="Clips" value={totals.clips} icon={Scissors} />
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Projects</h2>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading projects…
        </div>
      ) : (projects?.length ?? 0) === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects!.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Project"
        footer={
          <>
            <button className="oc-btn" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button
              className="oc-btn oc-btn-primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Name</span>
            <input
              className="oc-input w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My podcast clips"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Description (optional)</span>
            <textarea
              className="oc-input min-h-[72px] w-full resize-y"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this project is for…"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link
      href={`/videos?project=${project.id}`}
      className="oc-card group flex flex-col gap-3 p-4 transition hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--fg)_30%,var(--border))]"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-fg group-hover:text-[var(--red)]">{project.name}</h3>
        <span className="text-[10px] text-muted">{timeAgo(project.created_at)}</span>
      </div>
      {project.description && (
        <p className="line-clamp-2 text-xs text-muted">{project.description}</p>
      )}
      <div className="mt-auto flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><VideoIcon size={13} /> {project.video_count}</span>
        <span className="flex items-center gap-1.5"><Scissors size={13} /> {project.clip_count}</span>
      </div>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="oc-card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: "var(--hover-bg)" }}>
        <FolderPlus size={26} className="text-muted" />
      </span>
      <div>
        <p className="font-medium text-fg">No projects yet</p>
        <p className="mt-1 text-sm text-muted">Create a project to start turning long videos into clips.</p>
      </div>
      <button className="oc-btn oc-btn-primary" onClick={onCreate}>
        <Plus size={16} /> New Project
      </button>
    </div>
  );
}
