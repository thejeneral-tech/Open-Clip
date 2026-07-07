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
import { InfoTip } from "@/components/ui/tooltip";
import type { AspectRatio, OllamaModel, ProcessOptions, WhopVideoMatch } from "@/lib/types";
import { formatDurationLabel } from "@/lib/utils";

// Editing look/features the user can toggle before generating — the labels mirror
// the main Generate-clips dialog so the vocabulary is consistent across the app.
// `help` is the plain-English hover explanation shown next to each label.
type BoolKey =
  | "enable_captions"
  | "enable_reframe"
  | "generate_titles"
  | "generate_descriptions"
  | "generate_broll";
const TOGGLES: { key: BoolKey; label: string; help: string }[] = [
  {
    key: "enable_captions",
    label: "Animated captions",
    help: "Burns word-by-word animated subtitles onto each clip (karaoke highlight or single-word pop). Lifts watch-time and keeps clips readable on mute.",
  },
  {
    key: "enable_reframe",
    label: "Smart reframing & zoom (face tracking)",
    help: "Auto-crops wide video to your chosen aspect by tracking the speaker's face, with subtle punch-in zooms so the subject always stays centered.",
  },
  {
    key: "generate_titles",
    label: "Title variations",
    help: "Writes a few scroll-stopping title options for every clip so you can pick the strongest hook when you post.",
  },
  {
    key: "generate_descriptions",
    label: "SEO description & hashtags",
    help: "Drafts a ready-to-paste caption with relevant hashtags for each clip, tuned for discovery on the target platforms.",
  },
  {
    key: "generate_broll",
    label: "B-roll suggestions",
    help: "Suggests supporting b-roll shots and keywords to overlay at specific moments so the clip stays visually engaging.",
  },
];

const ASPECTS: { value: AspectRatio; label: string }[] = [
  { value: "9:16", label: "9:16 · Vertical" },
  { value: "1:1", label: "1:1 · Square" },
  { value: "4:5", label: "4:5 · Portrait" },
  { value: "16:9", label: "16:9 · Wide" },
];

// ------------------------------------------------------------- clip length
// Quick presets; the user can also type exact seconds. Longer = fewer, meatier
// cuts; shorter = more, punchier ones.
const LENGTH_PRESETS: { label: string; min: number; max: number }[] = [
  { label: "15–30s", min: 15, max: 30 },
  { label: "30–60s", min: 30, max: 60 },
  { label: "1–2 min", min: 60, max: 120 },
  { label: "2–4 min", min: 120, max: 240 },
];

// Parse a campaign's requirement lines for a clip-length rule ("30-60 seconds",
// "under 90s", "at least 20 sec") — mirrors the backend `_length_rule`. Returns
// null when the requirements say nothing about length.
export function parseClipLengthRule(
  requirements?: string[] | null,
): { min: number; max: number } | null {
  const text = (requirements ?? []).join(" ");
  const range = text.match(/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s|sec|second)/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const maxM = text.match(/(?:under|max|up to|below|<=?)\s*(\d{1,3})\s*(?:s|sec|second)/i);
  const minM = text.match(/(?:over|min|at least|>=?)\s*(\d{1,3})\s*(?:s|sec|second)/i);
  if (maxM || minM) {
    const mn = minM ? Number(minM[1]) : 15;
    const mx = maxM ? Number(maxM[1]) : Math.max(mn + 30, 60);
    return { min: Math.min(mn, mx), max: Math.max(mn, mx) };
  }
  return null;
}

export function ClipLengthControl({
  min,
  max,
  onChange,
  hint,
}: {
  min: number;
  max: number;
  onChange: (v: { min: number; max: number }) => void;
  hint?: string | null;
}) {
  const setMin = (n: number) => {
    const v = Math.max(3, Math.min(300, n || 0));
    onChange({ min: v, max: Math.max(max, v) });
  };
  const setMax = (n: number) => {
    const v = Math.max(5, Math.min(600, n || 0));
    onChange({ min: Math.min(min, v), max: v });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {LENGTH_PRESETS.map((p) => {
          const active = p.min === min && p.max === max;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange({ min: p.min, max: p.max })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={3}
          max={300}
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
          className="h-9 w-20"
          aria-label="Minimum clip length in seconds"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="number"
          min={5}
          max={600}
          value={max}
          onChange={(e) => setMax(Number(e.target.value))}
          className="h-9 w-20"
          aria-label="Maximum clip length in seconds"
        />
        <span className="text-xs text-muted-foreground">seconds each</span>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

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
  lengthHint,
}: {
  opts: Partial<ProcessOptions>;
  setOpts: (o: Partial<ProcessOptions>) => void;
  capStyle: "karaoke" | "pop";
  setCapStyle: (s: "karaoke" | "pop") => void;
  models: OllamaModel[];
  lengthHint?: string | null;
}) {
  const set = (patch: Partial<ProcessOptions>) => setOpts({ ...opts, ...patch });
  const aspect = opts.aspect_ratios?.[0] ?? "9:16";
  const minLen = opts.min_clip_seconds ?? 30;
  const maxLen = opts.max_clip_seconds ?? 60;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm font-semibold">Editing features</p>

      {/* Clip length — presets + manual, applies to every clip we cut. */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Label className="text-xs">Clip length</Label>
          <InfoTip label="The min–max length of each clip we cut from your source videos. Pick a preset or type exact seconds (up to 10 min). Longer = fewer, meatier clips; shorter = more, punchier ones." />
        </div>
        <ClipLengthControl
          min={minLen}
          max={maxLen}
          onChange={({ min, max }) => set({ min_clip_seconds: min, max_clip_seconds: max })}
          hint={lengthHint}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="find-count" className="text-xs">
              Clips / video
            </Label>
            <InfoTip label="How many clips to cut from each source video. The AI ranks the strongest moments and returns up to this many." />
          </div>
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
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Aspect</Label>
            <InfoTip label="Output shape — 9:16 vertical for TikTok / Reels / Shorts, 1:1 square, 4:5 portrait, or 16:9 wide." />
          </div>
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
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Caption animation</Label>
            <InfoTip label="Karaoke highlights each word as it's spoken; Pop shows one punchy word at a time. Needs Animated captions on." />
          </div>
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
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Model</Label>
            <InfoTip label="The local AI model that reads the transcript to find clip-worthy moments and write titles/descriptions." />
          </div>
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
        {TOGGLES.map(({ key, label, help }) => (
          <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`find-${key}`} className="text-sm font-normal">
                {label}
              </Label>
              <InfoTip label={help} />
            </div>
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
