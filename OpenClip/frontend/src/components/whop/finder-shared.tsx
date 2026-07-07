"use client";

import { Check, ExternalLink, Film } from "lucide-react";
import { ScoreRing } from "@/components/score-ring";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AspectRatio, OllamaModel, ProcessOptions, WhopVideoMatch } from "@/lib/types";
import { formatDurationLabel } from "@/lib/utils";

// Editing look/features the user can toggle before generating — the labels mirror
// the main Generate-clips dialog so the vocabulary is consistent across the app.
type BoolKey =
  | "enable_captions"
  | "enable_reframe"
  | "generate_titles"
  | "generate_descriptions"
  | "generate_broll";
const TOGGLES: { key: BoolKey; label: string }[] = [
  { key: "enable_captions", label: "Animated captions" },
  { key: "enable_reframe", label: "Smart reframing & zoom (face tracking)" },
  { key: "generate_titles", label: "Title variations" },
  { key: "generate_descriptions", label: "SEO description & hashtags" },
  { key: "generate_broll", label: "B-roll suggestions" },
];

const ASPECTS: { value: AspectRatio; label: string }[] = [
  { value: "9:16", label: "9:16 · Vertical" },
  { value: "1:1", label: "1:1 · Square" },
  { value: "4:5", label: "4:5 · Portrait" },
  { value: "16:9", label: "16:9 · Wide" },
];

function formatViews(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ------------------------------------------------------------- match card
export function MatchCard({
  match,
  selected,
  onToggle,
}: {
  match: WhopVideoMatch;
  selected: boolean;
  onToggle: (m: WhopVideoMatch) => void;
}) {
  const views = formatViews(match.view_count);
  return (
    <div
      onClick={() => onToggle(match)}
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition ${
        selected ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40"
      }`}
    >
      <div className="relative aspect-video bg-black">
        {match.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={match.thumbnail} alt={match.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <span
          className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border ${
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/70 bg-black/40 text-transparent"
          }`}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
        <div className="absolute right-2 top-2">
          <ScoreRing score={match.score} size={36} />
        </div>
        {match.duration ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
            {formatDurationLabel(match.duration)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-medium" title={match.title}>
          {match.title}
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {match.uploader}
          {views ? ` · ${views} views` : ""}
        </p>
        <p className="mt-auto line-clamp-1 text-xs text-muted-foreground" title={match.reason}>
          {match.reason}
        </p>
        <a
          href={match.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" /> Watch on YouTube
        </a>
      </div>
    </div>
  );
}

// ------------------------------------------------- editing features panel
export function EditingOptionsPanel({
  opts,
  setOpts,
  capStyle,
  setCapStyle,
  models,
}: {
  opts: Partial<ProcessOptions>;
  setOpts: (o: Partial<ProcessOptions>) => void;
  capStyle: "karaoke" | "pop";
  setCapStyle: (s: "karaoke" | "pop") => void;
  models: OllamaModel[];
}) {
  const set = (patch: Partial<ProcessOptions>) => setOpts({ ...opts, ...patch });
  const aspect = opts.aspect_ratios?.[0] ?? "9:16";

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm font-semibold">Editing features</p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="find-count" className="text-xs">
            Clips / video
          </Label>
          <Input
            id="find-count"
            type="number"
            min={1}
            max={30}
            value={opts.target_clip_count ?? 10}
            onChange={(e) => set({ target_clip_count: Math.max(1, Math.min(30, Number(e.target.value) || 10)) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Aspect</Label>
          <Select value={aspect} onValueChange={(v) => set({ aspect_ratios: [v as AspectRatio] })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECTS.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Caption animation</Label>
          <Select
            value={capStyle}
            onValueChange={(v) => setCapStyle(v as "karaoke" | "pop")}
            disabled={!opts.enable_captions}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="karaoke">Karaoke — highlight</SelectItem>
              <SelectItem value="pop">Pop — one word</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Model</Label>
          <Select
            value={opts.model ?? ""}
            onValueChange={(v) => set({ model: v })}
            disabled={models.length === 0}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder={models.length === 0 ? "Default" : "Model"} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.name} value={m.name}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {TOGGLES.map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor={`find-${key}`} className="text-sm font-normal">
              {label}
            </Label>
            <Switch
              id={`find-${key}`}
              checked={Boolean(opts[key])}
              onCheckedChange={(v) => set({ [key]: v })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
