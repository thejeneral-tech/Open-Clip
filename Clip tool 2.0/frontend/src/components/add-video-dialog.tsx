"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload, Youtube } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

export function AddVideoDialog({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const done = () => {
    qc.invalidateQueries({ queryKey: ["videos", projectId] });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    setOpen(false);
    setUrl("");
    setBusy(false);
  };

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a file first");
      return;
    }
    setBusy(true);
    try {
      await api.uploadVideo(projectId, file);
      toast.success("Upload started — ingesting…");
      done();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setBusy(false);
    }
  };

  const onImport = async () => {
    if (!url.trim()) {
      toast.error("Enter a URL");
      return;
    }
    setBusy(true);
    try {
      await api.importYouTube(projectId, url.trim());
      toast.success("Download queued");
      done();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Upload className="h-4 w-4" /> Add video
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a video</DialogTitle>
          <DialogDescription>Upload a file or import from a URL (YouTube, Vimeo, …).</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="upload" className="pt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload">
              <Upload className="mr-1 h-4 w-4" /> Upload
            </TabsTrigger>
            <TabsTrigger value="youtube">
              <Youtube className="mr-1 h-4 w-4" /> URL import
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="file">Video file</Label>
              <Input id="file" ref={fileRef} type="file" accept="video/*" />
              <p className="text-xs text-muted-foreground">MP4, MOV, MKV, WEBM, AVI.</p>
            </div>
            <Button className="w-full" onClick={onUpload} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Upload
            </Button>
          </TabsContent>
          <TabsContent value="youtube" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="url">Video URL</Label>
              <Input
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=…"
              />
            </div>
            <Button className="w-full" onClick={onImport} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Import
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
