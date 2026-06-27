"use client";

import { Link2, Loader2, Music, Pencil, Trash2, Upload } from "lucide-react";
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
  useSvDeleteMusic,
  useSvDeleteMusicPreset,
  useSvImportMusic,
  useSvMusic,
  useSvMusicPresets,
  useSvRenameMusic,
  useSvUpdateMusicPreset,
  useSvUploadMusic,
} from "@/hooks/use-api";
import { formatBytes, formatDuration } from "@/lib/utils";
import type { SvMusic, SvMusicPreset } from "@/lib/types";

function statusVariant(status: string): "default" | "destructive" | "secondary" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export function MusicLibrary() {
  // Poll while anything is still converting so the player shows up when ready.
  const { data: tracks = [], isLoading } = useSvMusic(true);
  const { data: presets = [] } = useSvMusicPresets();
  const uploadMusic = useSvUploadMusic();
  const importMusic = useSvImportMusic();
  const renameMusic = useSvRenameMusic();
  const deleteMusic = useSvDeleteMusic();
  const updatePreset = useSvUpdateMusicPreset();
  const deletePreset = useSvDeleteMusicPreset();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Import-from-URL dialog state.
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        try {
          await uploadMusic.mutateAsync(file);
          toast.success(`Importing ${file.name} — converting to MP3`);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Failed to import ${file.name}`);
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
      await importMusic.mutateAsync(url);
      toast.success("Importing music — it will appear here once downloaded");
      setImportOpen(false);
      setImportUrl("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import music");
    }
  };

  const onRename = async (track: SvMusic) => {
    const next = prompt("Track name", track.original_filename ?? "")?.trim();
    if (!next || next === track.original_filename) return;
    try {
      await renameMusic.mutateAsync({ id: track.id, name: next });
      toast.success("Track renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename track");
    }
  };

  const onDelete = async (track: SvMusic) => {
    if (!confirm(`Delete "${track.original_filename ?? "this track"}"?`)) return;
    try {
      await deleteMusic.mutateAsync(track.id);
      toast.success("Track deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete track");
    }
  };

  const onRenamePreset = async (preset: SvMusicPreset) => {
    const next = prompt("Preset name", preset.name)?.trim();
    if (!next || next === preset.name) return;
    try {
      await updatePreset.mutateAsync({ id: preset.id, data: { name: next } });
      toast.success("Preset renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename preset");
    }
  };

  const onDeletePreset = async (preset: SvMusicPreset) => {
    if (!confirm(`Delete preset "${preset.name}"?`)) return;
    try {
      await deletePreset.mutateAsync(preset.id);
      toast.success("Preset deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete preset");
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Background music for your videos — import an MP4 (or any audio/video file) and it&apos;s
        converted to an MP3 you can mix under the narration in the Studio and Projects.
      </p>

      <Card>
        <CardContent className="space-y-3 py-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,audio/*,video/*"
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
              Upload file
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
                    <DialogTitle>Import music from a URL</DialogTitle>
                    <DialogDescription>
                      Paste a YouTube (or other supported) link — we&apos;ll download it and convert
                      the audio to an MP3 automatically.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="music-url">Video URL</Label>
                      <Input
                        id="music-url"
                        value={importUrl}
                        onChange={(e) => setImportUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=..."
                        required
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={importMusic.isPending}>
                      {importMusic.isPending ? (
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
            Upload a file or import from a URL — the audio is extracted and saved as an MP3. The
            track loops to fill the whole video and plays quietly under the voice.
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tracks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Music className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No music yet — import an MP4 or audio file to use as a background track.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {tracks.map((track) => (
            <Card key={track.id}>
              <CardContent className="space-y-3 pt-6">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Music className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <p className="line-clamp-1 font-medium">
                      {track.original_filename ?? "Untitled track"}
                    </p>
                  </div>
                  <Badge variant={statusVariant(track.status)}>
                    {track.status !== "completed" && track.status !== "failed" && (
                      <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                    )}
                    {track.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatDuration(track.duration_seconds)} · {formatBytes(track.size_bytes)}
                </p>
                {track.status === "failed" && track.error && (
                  <p className="line-clamp-2 text-sm text-destructive">{track.error}</p>
                )}
                {track.status === "completed" && track.media_url && (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <audio src={track.media_url} controls className="w-full" />
                )}
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => onRename(track)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => onDelete(track)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {presets.length > 0 && (
        <Card>
          <CardContent className="space-y-3 py-6">
            <div>
              <p className="font-medium">Music presets</p>
              <p className="text-xs text-muted-foreground">
                Saved track + volume combos — pick them in the Studio and Projects. Create one with
                “Save as preset” there.
              </p>
            </div>
            <div className="space-y-2">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2"
                >
                  <div className="min-w-0">
                    <p className="line-clamp-1 text-sm font-medium">{preset.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {preset.music_filename ?? "(track removed)"} · {Math.round(preset.volume * 100)}%
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => onRenamePreset(preset)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onDeletePreset(preset)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
