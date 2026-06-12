"use client";

import { Loader2, Star } from "lucide-react";
import { useState } from "react";
import { CaptionControls, useCaptionEditor } from "@/components/storyvault/caption-generator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useConnectors,
  useSvBackgrounds,
  useSvMeta,
  useSvTemplates,
  useSvVoicePresets,
  useSvVoices,
} from "@/hooks/use-api";
import { categoryLabel } from "@/lib/utils";
import type {
  SvProject,
  SvProjectSettings,
  SvTemplate,
  SvTemplateData,
  SvVoicePreset,
} from "@/lib/types";

// Mirrors backend SvProjectSettings defaults so a fresh form is already valid.
export const DEFAULT_SETTINGS: SvProjectSettings = {
  story_source: "reddit",
  communities: [],
  discovery_sort: "top",
  discovery_time_window: "week",
  min_upvotes: 500,
  min_length: 600,
  duration_target: 60,
  hook_style: "conflict",
  narration_style: "dramatic",
  drama_level: 3,
  voice: null,
  speed: 1.0,
  caption_style: "modern_tiktok",
  background_category: null,
  background_id: null,
  template_id: null,
  script_engine: "auto",
  publish_connector_ids: [],
  privacy: "public",
  videos_per_run: 3,
  auto_publish: false,
};

function isClonedVoice(preset: SvVoicePreset): boolean {
  if (preset.engine) return preset.engine !== "sapi";
  return /clone|fish/i.test(preset.voice);
}

function truncate(text: string, max = 32): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// One-line descriptor for a preset, mirroring the Video Studio + Presets page.
function templateTagline(t: SvTemplateData): string {
  const cap = t.captions || {};
  const style = cap.style === "pop" ? "Pop" : "Karaoke";
  const split = t.gameplay?.mode === "split_bottom" ? " · split" : "";
  return `${style} · ${cap.size || 80}px${split}`;
}

function TemplateBadge({ t }: { t: SvTemplate }) {
  if (t.is_default) {
    return (
      <Badge variant="success" className="gap-1">
        <Star className="h-3 w-3 fill-current" /> Default
      </Badge>
    );
  }
  if (t.builtin) return <Badge variant="secondary">Built-in</Badge>;
  return (
    <Badge variant="outline" className="border-primary/40 text-primary">
      Custom
    </Badge>
  );
}

// settings.voice <-> the Select value ("auto" | "preset:<id>" | "<sapi name>").
function voiceToValue(voice: string | null): string {
  return voice == null ? "auto" : voice;
}
function valueToVoice(value: string): string | null {
  return value === "auto" ? null : value;
}

export interface ProjectFormValue {
  name: string;
  description: string;
  settings: SvProjectSettings;
}

export function ProjectForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
}: {
  initial?: SvProject | null;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (value: ProjectFormValue) => void;
}) {
  const { data: meta } = useSvMeta();
  const { data: voices = [] } = useSvVoices();
  const { data: voicePresets = [] } = useSvVoicePresets();
  const { data: templates = [] } = useSvTemplates();
  const { data: backgrounds = [] } = useSvBackgrounds();
  const { data: connectors = [] } = useConnectors();

  const clonedPresets = voicePresets.filter(isClonedVoice);
  // Footage the user can pin to the gameplay layer — only ready clips with segments.
  const readyFootage = backgrounds.filter((b) => b.status === "completed" && b.segment_count > 0);
  const base = initial?.settings ?? DEFAULT_SETTINGS;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [s, setS] = useState<SvProjectSettings>({ ...DEFAULT_SETTINGS, ...base });
  const [communitiesText, setCommunitiesText] = useState((base.communities ?? []).join(", "));

  const set = <K extends keyof SvProjectSettings>(key: K, value: SvProjectSettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const selectedTemplate = templates.find((t) => t.id === s.template_id) ?? null;
  // Footage selection only applies to split-screen presets (gameplay fills the
  // bottom half); full-screen presets use the whole frame.
  const isSplitScreen = selectedTemplate?.data?.gameplay?.mode === "split_bottom";

  // Caption look (style · position · text/highlight colours) is stored on the
  // preset, so the editor binds to the selected preset and persists onto it —
  // mirroring the Video Studio's Captions section.
  const captionEditor = useCaptionEditor(selectedTemplate);

  const toggleConnector = (id: number) =>
    setS((prev) => ({
      ...prev,
      publish_connector_ids: prev.publish_connector_ids.includes(id)
        ? prev.publish_connector_ids.filter((c) => c !== id)
        : [...prev.publish_connector_ids, id],
    }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const communities = communitiesText
      .split(/[\s,]+/)
      .map((c) => c.replace(/^r\//i, "").trim())
      .filter(Boolean);
    onSubmit({ name, description, settings: { ...s, communities } });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Identity */}
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="pname">Project name</Label>
          <Input
            id="pname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Scary stories — season 1"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pdesc">Description</Label>
          <Textarea
            id="pdesc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what this series is about"
          />
        </div>
      </div>

      {/* 1. Story source */}
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">1 · Where stories come from</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Source</Label>
            <Select value={s.story_source} onValueChange={(v) => set("story_source", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reddit">Reddit (auto-collect)</SelectItem>
                <SelectItem value="manual">Manual (I add stories myself)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Sort</Label>
            <Select value={s.discovery_sort} onValueChange={(v) => set("discovery_sort", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["top", "hot", "new", "rising"].map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {s.story_source === "reddit" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="communities">Subreddits</Label>
              <Input
                id="communities"
                value={communitiesText}
                onChange={(e) => setCommunitiesText(e.target.value)}
                placeholder="AmItheAsshole, tifu, relationship_advice"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. The “r/” prefix is optional.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Time window</Label>
                <Select
                  value={s.discovery_time_window}
                  onValueChange={(v) => set("discovery_time_window", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["day", "week", "month", "year", "all"].map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="minup">Min upvotes</Label>
                <Input
                  id="minup"
                  type="number"
                  min={0}
                  value={s.min_upvotes}
                  onChange={(e) => set("min_upvotes", Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="minlen">Min length</Label>
                <Input
                  id="minlen"
                  type="number"
                  min={0}
                  value={s.min_length}
                  onChange={(e) => set("min_length", Number(e.target.value) || 0)}
                />
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* 2. Look & sound */}
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">2 · How every video looks &amp; sounds</legend>
        <div className="space-y-2">
          <Label>Preset</Label>
          <Select
            value={s.template_id != null ? String(s.template_id) : "none"}
            onValueChange={(v) => set("template_id", v === "none" ? null : Number(v))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Default preset" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Use my default preset</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/60 bg-primary/5 px-4 py-3 ring-1 ring-primary/30">
              <div className="min-w-0">
                <div className="truncate font-semibold text-primary">{selectedTemplate.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {templateTagline(selectedTemplate.data)}
                </div>
              </div>
              <TemplateBadge t={selectedTemplate} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Using your default preset. Pick one above to lock its look for every video.
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Voice</Label>
            <Select value={voiceToValue(s.voice)} onValueChange={(v) => set("voice", valueToVoice(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (my default voice)</SelectItem>
                {clonedPresets.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Cloned voices</SelectLabel>
                    {clonedPresets.map((p) => (
                      <SelectItem key={`preset-${p.id}`} value={`preset:${p.id}`}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectLabel>System voices</SelectLabel>
                  {voices.map((v) => (
                    <SelectItem key={v.name} value={v.name}>
                      {v.name}
                      {v.gender ? ` (${v.gender})` : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Background gameplay</Label>
            <Select
              value={s.background_category ?? "any"}
              onValueChange={(v) => set("background_category", v === "any" ? null : v)}
              disabled={isSplitScreen && s.background_id != null}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {(meta?.background_categories ?? []).map((b) => (
                  <SelectItem key={b} value={b}>
                    {categoryLabel(b)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isSplitScreen && (
            <div className="space-y-2">
              <Label>Footage</Label>
              <Select
                value={s.background_id != null ? String(s.background_id) : "auto"}
                onValueChange={(v) => set("background_id", v === "auto" ? null : Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (from category)</SelectItem>
                  {readyFootage.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {truncate(b.original_filename || `Footage #${b.id}`)} · {b.segment_count} seg
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {s.background_id != null && (
                <p className="text-xs text-muted-foreground">
                  Gameplay segments come from this clip only.
                </p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label>Duration</Label>
            <Select value={String(s.duration_target)} onValueChange={(v) => set("duration_target", Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(meta?.durations ?? [60]).map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Script engine</Label>
            <Select value={s.script_engine} onValueChange={(v) => set("script_engine", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">AI with fallback</SelectItem>
                <SelectItem value="ai">AI only</SelectItem>
                <SelectItem value="heuristic">Instant, no AI</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Captions — style, position and colours, saved onto the selected preset */}
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Captions</p>
              <p className="text-xs text-muted-foreground">
                {selectedTemplate ? (
                  <>
                    Style the captions for{" "}
                    <span className="font-medium text-foreground">{selectedTemplate.name}</span>.
                    Saved changes apply to this preset.
                  </>
                ) : (
                  "Pick a preset above to style its captions and colours."
                )}
              </p>
            </div>
            {selectedTemplate && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!captionEditor.dirty || captionEditor.saving}
                  onClick={() => captionEditor.reset()}
                >
                  Reset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!captionEditor.dirty || captionEditor.saving}
                  onClick={() => captionEditor.save()}
                >
                  {captionEditor.saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save captions
                </Button>
              </div>
            )}
          </div>
          {selectedTemplate && <CaptionControls editor={captionEditor} />}
        </div>
      </fieldset>

      {/* 3. Publishing & automation */}
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">3 · Publishing &amp; automation</legend>
        <div className="space-y-2">
          <Label>Publish to</Label>
          {connectors.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No channels connected yet. Connect one in Publishing to enable auto-publishing.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {connectors.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--red)]"
                    checked={s.publish_connector_ids.includes(c.id)}
                    onChange={() => toggleConnector(c.id)}
                  />
                  <span className="truncate">
                    {c.name} <span className="text-muted-foreground">· {c.platform}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Privacy</Label>
            <Select value={s.privacy} onValueChange={(v) => set("privacy", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["public", "unlisted", "private"].map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vpr">Videos per run</Label>
            <Input
              id="vpr"
              type="number"
              min={1}
              max={25}
              value={s.videos_per_run}
              onChange={(e) => set("videos_per_run", Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md border border-primary/40 bg-primary/5 p-3">
          <div>
            <p className="text-sm font-medium">One-click auto-publish</p>
            <p className="text-xs text-muted-foreground">
              When on, a run carries each video all the way through — render and queue to your
              channels — with no manual review.
            </p>
          </div>
          <Switch checked={s.auto_publish} onCheckedChange={(v) => set("auto_publish", v)} />
        </div>
      </fieldset>

      <Button type="submit" disabled={submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
