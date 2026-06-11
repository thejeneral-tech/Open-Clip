"use client";

import { Clapperboard, Film, Scissors, Sparkles } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProjects } from "@/hooks/use-api";
import { useAuth } from "@/lib/auth";
import { formatRelativeTime } from "@/lib/utils";

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: projects = [], isLoading } = useProjects();

  const totalVideos = projects.reduce((s, p) => s + p.video_count, 0);
  const totalClips = projects.reduce((s, p) => s + p.clip_count, 0);

  const stats = [
    { label: "Projects", value: projects.length, icon: Clapperboard },
    { label: "Videos", value: totalVideos, icon: Film },
    { label: "Clips generated", value: totalClips, icon: Scissors },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome back{user?.full_name ? `, ${user.full_name.split(" ")[0]}` : ""} 👋
        </h1>
        <p className="text-muted-foreground">Turn long videos into viral shorts — all running on your own hardware.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 p-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold">{isLoading ? "—" : value}</div>
                <div className="text-sm text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent projects</CardTitle>
          <Link href="/projects" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
              <p className="text-muted-foreground">No projects yet. Create one to get started.</p>
              <Link href="/projects" className="text-sm font-medium text-primary hover:underline">
                Create a project →
              </Link>
            </div>
          ) : (
            <div className="divide-y">
              {projects.slice(0, 6).map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center justify-between py-3 transition-colors hover:bg-accent/40"
                >
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.video_count} videos · {p.clip_count} clips · updated {formatRelativeTime(p.updated_at)}
                    </div>
                  </div>
                  <span className="text-sm text-muted-foreground">→</span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
