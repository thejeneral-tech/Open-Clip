"use client";

import { Film, Link2, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
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
  DialogTrigger,
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
import {
  useSvBackgrounds,
  useSvDeleteBackground,
  useSvImportBackground,
  useSvMeta,
  useSvUpdateBackground,
  useSvUploadBackground,
} from "@/hooks/use-api";
import { categoryLabel } from "@/lib/utils";
import type { SvBackground } from "@/lib/types";

const NONE_VALUE = "__none__";

function statusVariant(status: string): "default" | "destructive" | "secondary" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export function FootageLibrary() {
  const { data: backgrounds = [], isLoading } = useSvBackgrounds(true);
  const { data: meta } = useSvMeta();
  const uploadBackground = useSvUploadBackground();
  const importBackground = useSvImportBackground();
  const updateBackground = useSvUpdateBackground();
  const deleteBackground = useSvDeleteBackground();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] = useState<string>(NONE_VALUE);
  const [uploading, setUploading] = useState(false);

  // Import-from-URL dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importCategory, setImportCategory] = useState<string>(NONE_VALUE);

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

  const onImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = importUrl.trim();
    if (!url) return;
    try {
      await importBackground.mutateAsync({
        url,
        category: importCategory === NONE_VALUE ? undefined : importCategory,
      });
      toast.success("Importing footage — it will appear here once downloaded");
      setImportOpen(false);
      setImportUrl("");
      setImportCategory(NONE_VALUE);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import footage");
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
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Background gameplay that fills your videos — uploads are auto-cut into reusable segments.
      </p>

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
                    {categoryLabel(c)}
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
            <Dialog open={importOpen} onOpenChange={setImportOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Link2 className="h-4 w-4" /> Import from URL
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={onImport}>
                  <DialogHeader>
                    <DialogTitle>Import footage from a URL</DialogTitle>
                    <DialogDescription>
                      Paste a YouTube (or other supported) video link — we&apos;ll download it and
                      cut it into background segments automatically.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="footage-url">Video URL</Label>
                      <Input
                        id="footage-url"
                        value={importUrl}
                        onChange={(e) => setImportUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=..."
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Category (optional)</Label>
                      <Select value={importCategory} onValueChange={setImportCategory}>
                        <SelectTrigger>
                          <SelectValue placeholder="Category (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>None</SelectItem>
                          {categories.map((c) => (
                            <SelectItem key={c} value={c}>
                              {categoryLabel(c)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={importBackground.isPending}>
                      {importBackground.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Link2 className="h-4 w-4" />
                      )}
                      Import
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          <p className="text-xs text-muted-foreground">
            Upload a file or import from a URL — footage is segmented automatically into ~12s clips
            for background rotation.
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
                      {/* Keep showing a footage item's existing category even if it's
                          an older slug no longer in the standard list. */}
                      {(bg.category && !categories.includes(bg.category)
                        ? [bg.category, ...categories]
                        : categories
                      ).map((c) => (
                        <SelectItem key={c} value={c}>
                          {categoryLabel(c)}
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
