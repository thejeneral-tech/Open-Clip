"use client";

import { Download, Loader2, PackageOpen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSvDeleteExport, useSvExports } from "@/hooks/use-api";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function StoryVaultExportsPage() {
  const { data: exports = [], isLoading } = useSvExports(true);
  const deleteExport = useSvDeleteExport();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Exports</h1>
        <p className="text-muted-foreground">Finished 1080×1920 renders, ready to post.</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : exports.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <PackageOpen className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No exports yet — approve a video in the Review Queue.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exports.map((e) => (
            <Card key={e.id}>
              <CardContent className="space-y-3 pt-6">
                <video
                  src={e.media_url ?? undefined}
                  controls
                  preload="metadata"
                  className="aspect-[9/16] w-full rounded-md bg-black object-contain max-h-72"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="line-clamp-1 text-sm font-medium">
                    {e.title ?? `Export #${e.id}`}
                  </p>
                  <Badge variant="secondary">{e.platform}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatSize(e.size_bytes)}
                  {e.duration_seconds != null && <> · {Math.round(e.duration_seconds)}s</>}
                  {" · "}
                  {formatRelativeTime(e.created_at)}
                </p>
                <div className="flex items-center gap-2">
                  <Button asChild size="sm" className="flex-1">
                    <a href={api.svExportDownloadUrl(e.id)}>
                      <Download className="h-4 w-4" /> Download
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    disabled={deleteExport.isPending}
                    onClick={async () => {
                      if (confirm("Delete this export? The rendered file will be removed.")) {
                        try {
                          await deleteExport.mutateAsync(e.id);
                          toast.success("Export deleted");
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed to delete export");
                        }
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
