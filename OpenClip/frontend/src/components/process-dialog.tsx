"use client";

import { Loader2, Palette, Sparkles, Type } from "lucide-react";
import { useEffect, useState } from "react";
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
import { assToCss } from "@/components/storyvault/template-preview";
import { useModels, useProcessVideo, useSettings, useSvTemplates } from "@/hooks/use-api";
import type { AspectRatio, ProcessOptions, SvTemplateData } from "@/lib/types";
import { cn } from "@/lib/utils";

const ASPECTS: { value: AspectRatio; label: string }[] = [
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:5", label: "4:5" },
  { value: "16:9", label: "16:9" },
];

// Swatches offered in the caption colour pickers (plus a free-form picker),
// mirroring the Presets caption editor.
const CAPTION_SWATCHES = ["#ffffff", "#ffd400", "#000000", "#ff3b30", "#34c759", "#0a84ff", "#ff2d92"];

// Compact swatch row + native colour picker + hex readout.
function ColorRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        <Palette className="h-3.5 w-3.5" /> {label}
        {hint && <span className="font-normal text-muted-foreground">· {hint}</span>}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        {CAPTION_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={c}
            className={cn(
              "h-7 w-7 rounded-full border border-input ring-offset-2 ring-offset-background transition",
              value.toLowerCase() === c.toLowerCase() && "ring-2 ring-primary",
            )}
            style={{ background: c }}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} custom colour`}
          className="h-7 w-7 cursor-pointer rounded-full border border-dashed border-input bg-transparent p-0"
        />
        <span className="ml-1 font-mono text-xs uppercase text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}

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
  const { data: templates = [] } = useSvTemplates();
  const processVideo = useProcessVideo();

  const [opts, setOpts] = useState<Partial<ProcessOptions>>({
    target_clip_count: 12,
    min_clip_seconds: 15,
    max_clip_seconds: 60,
    aspect_ratios: ["9:16"],
    // Hidden base named style — font / outline / layout. The visible controls
    // below refine it (karaoke/pop + colours) and an optional preset.
    caption_style: "hormozi",
    generate_titles: true,
    generate_descriptions: true,
    generate_broll: true,
    enable_reframe: true,
    enable_captions: true,
  });

  // New caption look: animation style + text/highlight colours, optionally seeded
  // from a preset. Sent to the backend as `caption_config` (+ `template_id`).
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  const [primary, setPrimary] = useState("#ffffff");
  const [highlight, setHighlight] = useState("#ffd400");
  // Whether the user has touched the preset picker — until then we pre-select the
  // default preset so the dialog starts from the "Set default" the whole stack uses.
  const [presetTouched, setPresetTouched] = useState(false);

  // Seed the caption style + colours from a preset's caption config.
  const seedFromCaptions = (caps: SvTemplateData["captions"]) => {
    if (!caps) return;
    setCapStyle(caps.style === "pop" ? "pop" : "karaoke");
    setPrimary(assToCss(caps.primary, "#ffffff").toLowerCase());
    setHighlight(assToCss(caps.highlight, "#ffd400").toLowerCase());
  };

  // Pre-select the user's default preset (the whole-stack default) on first load,
  // until they pick one themselves.
  useEffect(() => {
    if (presetTouched || templateId !== null || templates.length === 0) return;
    const def = templates.find((t) => t.is_default);
    if (!def) return;
    setTemplateId(def.id);
    seedFromCaptions(def.data?.captions);
  }, [templates, templateId, presetTouched]);

  // Picking a preset seeds the caption style + colours from its caption config.
  const onPreset = (v: string) => {
    setPresetTouched(true);
    if (v === "none") {
      setTemplateId(null);
      return;
    }
    const id = Number(v);
    setTemplateId(id);
    seedFromCaptions(templates.find((t) => t.id === id)?.data?.captions);
  };

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
      await processVideo.mutateAsync({
        id: videoId,
        options: {
          ...opts,
          model: opts.model ?? settings?.default_model,
          caption_config: { style: capStyle, primary, highlight },
          template_id: templateId,
        },
      });
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

          {/* Preset — seeds the caption style + colours below */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Preset
            </Label>
            <Select value={templateId != null ? String(templateId) : "none"} onValueChange={onPreset}>
              <SelectTrigger>
                <SelectValue placeholder="No preset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No preset</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Type className="h-3.5 w-3.5" /> Caption style
              </Label>
              <Select value={capStyle} onValueChange={(v) => setCapStyle(v as "karaoke" | "pop")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="karaoke">Karaoke — last word highlighted</SelectItem>
                  <SelectItem value="pop">Pop word — one word at a time</SelectItem>
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

          {/* Caption colours */}
          <div className="grid grid-cols-2 gap-4">
            <ColorRow label="Text colour" value={primary} onChange={setPrimary} />
            <ColorRow
              label="Highlight colour"
              hint={capStyle === "pop" ? "karaoke only" : undefined}
              value={highlight}
              onChange={setHighlight}
            />
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
