"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useModels, useProcessVideo, useSettings } from "@/hooks/use-api";
import type { AspectRatio, CaptionStyle, ProcessOptions } from "@/lib/types";
import { cn } from "@/lib/utils";

const ASPECTS: { value: AspectRatio; label: string }[] = [
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:5", label: "4:5" },
  { value: "16:9", label: "16:9" },
];

const STYLES: { value: CaptionStyle; label: string }[] = [
  { value: "hormozi", label: "Alex Hormozi" },
  { value: "modern_tiktok", label: "Modern TikTok" },
  { value: "minimal", label: "Minimal" },
  { value: "gaming", label: "Gaming" },
  { value: "podcast", label: "Podcast" },
];

export function ProcessDialog({
  videoId,
  open,
  onOpenChange,
}: {
  videoId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: settings } = useSettings();
  const { data: models = [] } = useModels();
  const processVideo = useProcessVideo();

  const [opts, setOpts] = useState<Partial<ProcessOptions>>({
    target_clip_count: 12,
    min_clip_seconds: 15,
    max_clip_seconds: 60,
    aspect_ratios: ["9:16"],
    caption_style: "hormozi",
    generate_titles: true,
    generate_descriptions: true,
    generate_broll: true,
    enable_reframe: true,
    enable_captions: true,
  });

  const toggleAspect = (a: AspectRatio) => {
    const current = opts.aspect_ratios || [];
    setOpts({
      ...opts,
      aspect_ratios: current.includes(a) ? current.filter((x) => x !== a) : [...current, a],
    });
  };

  const start = async () => {
    if (!opts.aspect_ratios?.length) {
      toast.error("Pick at least one aspect ratio");
      return;
    }
    try {
      await processVideo.mutateAsync({ id: videoId, options: { ...opts, model: opts.model ?? settings?.default_model } });
      toast.success("Processing started");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start");
    }
  };

  type BoolKey =
    | "enable_captions"
    | "enable_reframe"
    | "generate_titles"
    | "generate_descriptions"
    | "generate_broll";
  const toggles: { key: BoolKey; label: string }[] = [
    { key: "enable_captions", label: "Animated captions" },
    { key: "enable_reframe", label: "Smart reframing (face tracking)" },
    { key: "generate_titles", label: "Title variations" },
    { key: "generate_descriptions", label: "SEO descriptions & hashtags" },
    { key: "generate_broll", label: "B-roll suggestions" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> Generate clips
          </DialogTitle>
          <DialogDescription>Configure how the AI finds and produces clips.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label>Number of clips: {opts.target_clip_count}</Label>
            <Slider
              min={1}
              max={50}
              step={1}
              value={[opts.target_clip_count ?? 12]}
              onValueChange={([v]) => setOpts({ ...opts, target_clip_count: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Min length: {opts.min_clip_seconds}s</Label>
              <Slider min={5} max={90} step={1} value={[opts.min_clip_seconds ?? 15]} onValueChange={([v]) => setOpts({ ...opts, min_clip_seconds: v })} />
            </div>
            <div className="space-y-2">
              <Label>Max length: {opts.max_clip_seconds}s</Label>
              <Slider min={10} max={120} step={1} value={[opts.max_clip_seconds ?? 60]} onValueChange={([v]) => setOpts({ ...opts, max_clip_seconds: v })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Aspect ratios</Label>
            <div className="flex gap-2">
              {ASPECTS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => toggleAspect(a.value)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    opts.aspect_ratios?.includes(a.value)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input hover:bg-accent",
                  )}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Caption style</Label>
              <Select value={opts.caption_style} onValueChange={(v) => setOpts({ ...opts, caption_style: v as CaptionStyle })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STYLES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={opts.model ?? settings?.default_model} onValueChange={(v) => setOpts({ ...opts, model: v })}>
                <SelectTrigger>
                  <SelectValue placeholder={settings?.default_model ?? "Default"} />
                </SelectTrigger>
                <SelectContent>
                  {models.length === 0 && settings?.default_model && (
                    <SelectItem value={settings.default_model}>{settings.default_model}</SelectItem>
                  )}
                  {models.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-4">
            {toggles.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between">
                <Label htmlFor={key} className="font-normal">
                  {label}
                </Label>
                <Switch
                  id={key}
                  checked={Boolean(opts[key])}
                  onCheckedChange={(v) => setOpts({ ...opts, [key]: v })}
                />
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={start} disabled={processVideo.isPending}>
            {processVideo.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Sparkles className="h-4 w-4" /> Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
