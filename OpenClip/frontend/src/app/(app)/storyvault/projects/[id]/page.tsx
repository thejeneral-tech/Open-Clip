"use client";

import {
  ArrowLeft,
  Clapperboard,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ProjectForm } from "@/components/storyvault/project-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  useSvProject,
  useSvRunProject,
  useSvStories,
  useSvUpdateProject,
  useSvVideos,
} from "@/hooks/use-api";
import type { SvProject, SvStory, SvVideo } from "@/lib/types";

const STAGE_STEPS = [
  { key: "stories_ready", label: "Stories ready" },
  { key: "videos_in_pipeline", label: "Building" },
  { key: "videos_in_review", label: "In review" },
  { key: "videos_completed", label: "Done" },
  { key: "videos_published", label: "Published" },
] as const;

function FlowOverview({ p }: { p: SvProject }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {STAGE_STEPS.map((step) => (
        <div key={step.key} className="rounded-lg border bg-card p-4 text-center">
          <div className="text-2xl font-bold">{p[step.key]}</div>
          <div className="mt-1 text-xs text-muted-foreground">{step.label}</div>
        </div>
      ))}
    </div>
  );
}

function StoryRow({ story }: { story: SvStory }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <p className="line-clamp-1 text-sm">{story.title}</p>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{Math.round(story.score)}</span>
        <Badge variant="secondary">{story.status}</Badge>
      </div>
    </div>
  );
}

function VideoRow({ video }: { video: SvVideo }) {
  const active =
    video.status === "queued" || video.status === "processing" || video.status === "rendering";
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-1 text-sm font-medium">
          {video.title || video.story_title || `Video #${video.id}`}
        </p>
        <Badge variant={video.status === "failed" ? "destructive" : "secondary"}>
          {video.status.replace(/_/g, " ")}
        </Badge>
      </div>
      {active && (
        <div className="space-y-1">
          {video.stage && <p className="text-xs text-muted-foreground">{video.stage}</p>}
          <Progress value={video.progress * 100} />
        </div>
      )}
      {video.preview_url && (
        <Link
          href="/storyvault/publishing"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Preview ready · go to publishing →
        </Link>
      )}
    </div>
  );
}

export default function StoryVaultProjectDetailPage() {
  const params = useParams();
  const projectId = Number(params.id);

  const { data: project, isLoading } = useSvProject(projectId, true);
  const { data: stories = [] } = useSvStories({ project_id: projectId });
  const { data: videos = [] } = useSvVideos(undefined, true, projectId);
  const runProject = useSvRunProject();
  const updateProject = useSvUpdateProject();
  const [editing, setEditing] = useState(false);

  const onRun = async () => {
    try {
      const res = await runProject.mutateAsync(projectId);
      toast.success(res.detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to run project");
    }
  };

  if (isLoading || !project) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const s = project.settings;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link
          href="/storyvault/projects"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Projects
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
              {s.auto_publish && (
                <Badge variant="success" className="gap-1">
                  <Zap className="h-3 w-3" /> Auto-publish
                </Badge>
              )}
            </div>
            {project.description && <p className="text-muted-foreground">{project.description}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit recipe
            </Button>
            <Button onClick={onRun} disabled={runProject.isPending}>
              {runProject.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Run workflow
            </Button>
          </div>
        </div>
      </div>

      <FlowOverview p={project} />

      {/* Recipe summary */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">The recipe</CardTitle>
            <CardDescription>What every video in this project uses.</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={`/storyvault/studio?project=${projectId}`}>
              <Plus className="h-4 w-4" /> New video here
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">Source: {s.story_source}</Badge>
          {s.story_source === "reddit" && s.communities.length > 0 && (
            <Badge variant="outline">r/{s.communities.join(", r/")}</Badge>
          )}
          <Badge variant="outline">{s.duration_target}s</Badge>
          <Badge variant="outline">Voice: {s.voice ?? "auto"}</Badge>
          <Badge variant="outline">Captions: {s.caption_style}</Badge>
          <Badge variant="outline">Gameplay: {s.background_category ?? "any"}</Badge>
          <Badge variant="outline">{s.videos_per_run} per run</Badge>
          {s.publish_connector_ids.length > 0 && (
            <Badge variant="outline">{s.publish_connector_ids.length} channel(s)</Badge>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" /> Stories ({stories.length})
            </CardTitle>
            <CardDescription>Collected for this series.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {stories.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No stories yet. Run the workflow to collect some, or add them from the Library.
              </p>
            ) : (
              stories.slice(0, 20).map((story) => <StoryRow key={story.id} story={story} />)
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clapperboard className="h-4 w-4" /> Videos ({videos.length})
            </CardTitle>
            <CardDescription>Everything this project has produced.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {videos.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No videos yet. Hit “Run workflow” to start the pipeline.
              </p>
            ) : (
              videos.map((video) => <VideoRow key={video.id} video={video} />)
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit recipe</DialogTitle>
            <DialogDescription>Changes apply to the next videos this project makes.</DialogDescription>
          </DialogHeader>
          <ProjectForm
            initial={project}
            submitLabel="Save changes"
            submitting={updateProject.isPending}
            onSubmit={async (value) => {
              try {
                await updateProject.mutateAsync({
                  id: projectId,
                  data: {
                    name: value.name,
                    description: value.description,
                    settings: value.settings,
                  },
                });
                toast.success("Project updated");
                setEditing(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to update project");
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
