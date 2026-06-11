"use client";

import { Film, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useSvBackgrounds,
  useSvDeleteBackground,
  useSvMeta,
  useSvUpdateBackground,
  useSvUploadBackground,
} from "@/hooks/use-api";
import type { SvBackground } from "@/lib/types";

const NONE_VALUE = "__none__";

function statusVariant(status: string): "default" | "destructive" | "secondary" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export default function FootagePage() {
  const { data: backgrounds = [], isLoading } = useSvBackgrounds(true);
  const { data: meta } = useSvMeta();
  const uploadBackground = useSvUploadBackground();
  const updateBackground = useSvUpdateBackground();
  const deleteBackground = useSvDeleteBackground();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] = useState<string>(NONE_VALUE);
  const [uploading, setUploading] = useState(false);

  const categories = meta?.background_categories ?? [];

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        try {
          await uploadBackground.mutateAsync({
            file,
            category: uploadCategory === NONE_VALUE ? undefined : uploadCategory,
          });
          toast.success(`Uploaded ${file.name}`);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const onChangeCategory = async (bg: SvBackground, value: string) => {
    try {
      await updateBackground.mutateAsync({
        id: bg.id,
        data: { category: value === NONE_VALUE ? "" : value },
      });
      toast.success("Category updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update category");
    }
  };

  const onDelete = async (bg: SvBackground) => {
    if (!confirm(`Delete "${bg.original_filename ?? "this video"}" and all its segments?`)) return;
    try {
      await deleteBackground.mutateAsync(bg.id);
      toast.success("Footage deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete footage");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Footage Library</h1>
        <p className="text-muted-foreground">
          Background gameplay that fills your videos — uploads are auto-cut into reusable segments.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 py-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Select value={uploadCategory} onValueChange={setUploadCategory}>
              <SelectTrigger className="sm:w-56">
                <SelectValue placeholder="Category (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>None</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.m4v"
              multiple
              className="hidden"
              onChange={onFilesSelected}
            />
            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Upload video
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Uploads are segmented automatically into ~12s clips for background rotation.
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : backgrounds.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Film className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No footage yet — upload gameplay videos (Minecraft parkour, GTA, etc).
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {backgrounds.map((bg) => (
            <Card key={bg.id}>
              <CardContent className="space-y-3 pt-6">
                {bg.thumbnail_url ? (
                  <img
                    src={bg.thumbnail_url ?? undefined}
                    className="aspect-video w-full rounded-md bg-black object-cover"
                    alt=""
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md bg-black">
                    <Film className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-1 font-medium">
                    {bg.original_filename ?? "Untitled upload"}
                  </p>
                  <Badge variant={statusVariant(bg.status)}>
                    {bg.status !== "completed" && bg.status !== "failed" && (
                      <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                    )}
                    {bg.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {bg.duration_seconds != null ? `${Math.round(bg.duration_seconds)}s` : "—"} ·{" "}
                  {bg.width != null && bg.height != null ? `${bg.width}×${bg.height}` : "—"} ·{" "}
                  {bg.segment_count} segments
                </p>
                {bg.status === "failed" && bg.error && (
                  <p className="line-clamp-2 text-sm text-destructive">{bg.error}</p>
                )}
                <div className="flex items-center gap-2">
                  <Select
                    value={bg.category || NONE_VALUE}
                    onValueChange={(value) => onChangeCategory(bg, value)}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>None</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => onDelete(bg)}
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
