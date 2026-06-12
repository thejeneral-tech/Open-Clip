"use client";

import { FolderKanban, Loader2, MoreVertical, Plus, Play, Trash2, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ProjectForm } from "@/components/storyvault/project-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSvCreateProject,
  useSvDeleteProject,
  useSvProjects,
  useSvRunProject,
} from "@/hooks/use-api";
import { formatRelativeTime } from "@/lib/utils";
import type { SvProject } from "@/lib/types";

// The five stages a story moves through, surfaced as a compact flow bar.
function FlowBar({ p }: { p: SvProject }) {
  const stages: { label: string; value: number }[] = [
    { label: "Ready", value: p.stories_ready },
    { label: "Building", value: p.videos_in_pipeline },
    { label: "Review", value: p.videos_in_review },
    { label: "Done", value: p.videos_completed },
    { label: "Published", value: p.videos_published },
  ];
  return (
    <div className="flex items-stretch gap-1">
      {stages.map((s, i) => (
        <div key={s.label} className="flex flex-1 items-center gap-1">
          <div className="flex-1 rounded-md bg-muted/60 px-2 py-1.5 text-center">
            <div className="text-sm font-semibold leading-none">{s.value}</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
          </div>
          {i < stages.length - 1 && <span className="text-muted-foreground">→</span>}
        </div>
      ))}
    </div>
  );
}

function ProjectCard({ p }: { p: SvProject }) {
  const runProject = useSvRunProject();
  const deleteProject = useSvDeleteProject();

  const onRun = async () => {
    try {
      const res = await runProject.mutateAsync(p.id);
      toast.success(res.detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to run project");
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="line-clamp-1">
            <Link href={`/storyvault/projects/${p.id}`} className="hover:text-primary">
              {p.name}
            </Link>
          </CardTitle>
          <div className="flex items-center gap-1">
            {p.settings.auto_publish && (
              <Badge variant="success" className="gap-1">
                <Zap className="h-3 w-3" /> Auto
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={async () => {
                    if (confirm(`Delete "${p.name}"? Its stories and videos are kept, just unfiled.`)) {
                      await deleteProject.mutateAsync(p.id);
                      toast.success("Project deleted");
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {p.description && (
          <p className="line-clamp-1 text-sm text-muted-foreground">{p.description}</p>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <FlowBar p={p} />
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            Updated {formatRelativeTime(p.updated_at)}
          </span>
          <Button size="sm" onClick={onRun} disabled={runProject.isPending}>
            {runProject.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function StoryVaultProjectsPage() {
  const { data: projects = [], isLoading } = useSvProjects();
  const createProject = useSvCreateProject();
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground">
            Save a content series as a reusable recipe — source, voice, captions, footage and
            publishing — then run the whole pipeline in one click.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" /> New project
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                Set the recipe once. Every video this project makes inherits it.
              </DialogDescription>
            </DialogHeader>
            <ProjectForm
              submitLabel="Create project"
              submitting={createProject.isPending}
              onSubmit={async (value) => {
                try {
                  await createProject.mutateAsync({
                    name: value.name,
                    description: value.description || undefined,
                    settings: value.settings,
                  });
                  toast.success("Project created");
                  setOpen(false);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to create project");
                }
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <FolderKanban className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No projects yet. Create one to turn a stream of stories into a steady feed of videos.
            </p>
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Create your first project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
