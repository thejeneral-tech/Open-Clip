"use client";

import { ArrowLeft, Film, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AddVideoDialog } from "@/components/add-video-dialog";
import { VideoCard } from "@/components/video-card";
import { Card, CardContent } from "@/components/ui/card";
import { useProject, useVideos } from "@/hooks/use-api";

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = Number(params.id);
  const { data: project } = useProject(projectId);
  const { data: videos = [], isLoading } = useVideos(projectId, true);

  const anyBusy = videos.some((v) => v.status === "processing" || v.status === "queued");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Projects
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{project?.name ?? "Project"}</h1>
            {project?.description && <p className="text-muted-foreground">{project.description}</p>}
          </div>
          <AddVideoDialog projectId={projectId} />
        </div>
      </div>

      {anyBusy && (
        <p className="text-xs text-muted-foreground">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Live updates active
        </p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : videos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Film className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No videos yet. Upload or import one to begin.</p>
            <AddVideoDialog projectId={projectId} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {videos.map((v) => (
            <VideoCard key={v.id} video={v} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
