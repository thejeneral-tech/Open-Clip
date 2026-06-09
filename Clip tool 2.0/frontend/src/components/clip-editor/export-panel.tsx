"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useExports } from "@/hooks/use-api";
import { useProgress } from "@/hooks/use-progress";
import { api } from "@/lib/api";
import type { AspectRatio, Export, ExportFormat, ExportResolution } from "@/lib/types";
import { formatBytes, formatRelativeTime } from "@/lib/utils";

function ExportRow({ exp }: { exp: Export }) {
  const busy = exp.status === "processing" || exp.status === "queued";
  const live = useProgress("export", busy ? exp.id : null, busy);
  const pct = Math.round((live?.progress ?? exp.progress ?? 0) * 100);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {exp.resolution} · {exp.format.toUpperCase()} · {exp.aspect_ratio}
          <StatusBadge status={exp.status} />
        </div>
        {busy ? (
          <div className="mt-1 space-y-1">
            <Progress value={pct} />
            <span className="text-xs text-muted-foreground">{live?.message || "Rendering"} · {pct}%</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {formatBytes(exp.size_bytes)} · {formatRelativeTime(exp.created_at)}
          </span>
        )}
      </div>
      {exp.status === "completed" && (
        <Button asChild size="sm" variant="secondary">
          <a href={api.exportDownloadUrl(exp.id)} download>
            <Download className="h-4 w-4" /> Download
          </a>
        </Button>
      )}
    </div>
  );
}

export function ExportPanel({ clipId, defaultAspect }: { clipId: number; defaultAspect: AspectRatio }) {
  const qc = useQueryClient();
  const { data: exports = [] } = useExports(clipId, true);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [aspect, setAspect] = useState<AspectRatio>(defaultAspect);
  const [burn, setBurn] = useState(true);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      await api.createExport(clipId, { format, resolution, aspect_ratio: aspect, burn_captions: burn });
      qc.invalidateQueries({ queryKey: ["exports", clipId] });
      toast.success("Export queued");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Resolution</Label>
          <Select value={resolution} onValueChange={(v) => setResolution(v as ExportResolution)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["720p", "1080p", "1440p", "4k"] as ExportResolution[]).map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mp4">MP4 (H.264)</SelectItem>
              <SelectItem value="mov">MOV</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Aspect ratio</Label>
          <Select value={aspect} onValueChange={(v) => setAspect(v as AspectRatio)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["9:16", "1:1", "4:5", "16:9"] as AspectRatio[]).map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end justify-between rounded-md border px-3 py-2">
          <Label htmlFor="burn" className="font-normal">Burn captions</Label>
          <Switch id="burn" checked={burn} onCheckedChange={setBurn} />
        </div>
      </div>

      <Button className="w-full" onClick={create} disabled={creating}>
        {creating && <Loader2 className="h-4 w-4 animate-spin" />}
        <Download className="h-4 w-4" /> Export clip
      </Button>

      <div className="space-y-2">
        {exports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exports yet.</p>
        ) : (
          exports.map((e) => <ExportRow key={e.id} exp={e} />)
        )}
      </div>
    </div>
  );
}
