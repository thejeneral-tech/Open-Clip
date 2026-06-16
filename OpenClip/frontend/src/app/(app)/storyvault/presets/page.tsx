"use client";

import {
  Clapperboard,
  Copy,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Trash2,
  Type,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhonePreview, type PreviewPhase, assToCss, cssToAss, posInfo } from "@/components/storyvault/template-preview";
import {
  useSvCreateTemplate,
  useSvDeleteTemplate,
  useSvDuplicateTemplate,
  useSvSetDefaultTemplate,
  useSvTemplates,
  useSvUpdateTemplate,
} from "@/hooks/use-api";
import type { SvTemplate, SvTemplateData } from "@/lib/types";
import { cn } from "@/lib/utils";

// Swatches offered in the caption colour pickers (plus a free-form picker).
const CAPTION_SWATCHES = ["#ffffff", "#ffd400", "#000000", "#ff3b30", "#34c759", "#0a84ff", "#ff2d92"];

// Reusable swatch row + native colour picker + hex readout.
function ColorField({
  label,
  icon: Icon,
  hint,
  value,
  onChange,
}: {
  label: string;
  icon?: React.ElementType;
  hint?: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5" />} {label}
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
              "h-7 w-7 rounded-full border border-border ring-offset-2 ring-offset-background transition",
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
          className="h-7 w-7 cursor-pointer rounded-full border border-dashed border-border bg-transparent p-0"
        />
        <span className="ml-1 font-mono text-xs uppercase text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}

function summary(t: SvTemplateData): [string, string][] {
  const tc = t.topicCard || {};
  const cap = t.captions || {};
  const cv = t.canvas || {};
  const gp = t.gameplay || {};
  const au = t.audio || {};
  const style = cap.style === "pop" ? "Pop word" : "Karaoke";
  return [
    ["Layout", gp.mode === "split_bottom" ? "Split (gameplay ½)" : "Full-screen gameplay"],
    [
      "Topic card",
      tc.enabled === false
        ? "off"
        : `${tc.minSeconds ?? "–"}–${tc.maxSeconds ?? "–"}s · ${tc.avatar === false ? "no avatar" : "avatar"} · ${tc.width ?? 820}px`,
    ],
    ["Author intro", t.authorIntro && t.authorIntro.enabled !== false ? "on" : "off"],
    ["Captions", `${cap.size || 80}px · ${style}`],
    ["Position", posInfo(t).label],
    ["Canvas", `${cv.width || 1080}×${cv.height || 1920} @ ${cv.fps || 30}fps`],
    ["Music", (au.musicVolume ?? 0) > 0 ? "on" : "disabled"],
  ];
}

// One-line descriptor under each template name in the list.
function tagline(t: SvTemplateData): string {
  const cap = t.captions || {};
  const gp = t.gameplay || {};
  const style = cap.style === "pop" ? "Pop" : "Karaoke";
  return `${style} · ${cap.size || 80}px · ${posInfo(t).pct}%${gp.mode === "split_bottom" ? " · split" : ""}`;
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

// Labels for the preview beat chips (mirrors the Studio cycler).
const BEAT_LABEL: Record<PreviewPhase, string> = {
  topic: "Reddit card",
  author: "Author intro",
  caption: "Captions",
};

// Video-preset preview: shows the mock placard (Reddit topic card) the template
// burns in, plus the other intro beats, with chips to flip between them — the
// same beats the Studio previews, using sample data since no story is bound.
function PresetBeatPreview({ t }: { t: SvTemplateData }) {
  const phases: PreviewPhase[] = [];
  if (t.topicCard?.enabled !== false) phases.push("topic");
  if (t.authorIntro?.enabled !== false) phases.push("author");
  if (t.captions?.enabled !== false) phases.push("caption");
  if (phases.length === 0) phases.push("caption");

  // Default to the first beat (the placard); reset when the beat set changes.
  const [idx, setIdx] = useState(0);
  const phaseKey = phases.join(",");
  useEffect(() => {
    setIdx(0);
  }, [phaseKey]);
  const phase = phases[Math.min(idx, phases.length - 1)];

  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <div key={phase} className="animate-in fade-in duration-300">
          <PhonePreview t={t} phase={phase} />
        </div>
      </div>
      {phases.length > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {phases.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => setIdx(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                p === phase
                  ? "bg-primary/15 font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  p === phase ? "bg-primary" : "bg-muted-foreground/40",
                )}
              />
              {BEAT_LABEL[p]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PresetsPage() {
  const router = useRouter();
  const { data: templates = [], isLoading } = useSvTemplates();
  const setDefault = useSvSetDefaultTemplate();
  const duplicate = useSvDuplicateTemplate();
  const remove = useSvDeleteTemplate();
  const create = useSvCreateTemplate();
  const update = useSvUpdateTemplate();

  const [selectedId, setSelectedId] = useState<number | null>(null);

  // ---- Caption-generation editor (style + position + colours), local until saved ----
  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  const [capPos, setCapPos] = useState(60); // vertical placement, % from top
  const [capPrimary, setCapPrimary] = useState("#ffffff");
  const [capHighlight, setCapHighlight] = useState("#ffd400");

  // Default the selection to the active default (or the first template) once loaded.
  useEffect(() => {
    if (templates.length === 0) return;
    if (selectedId !== null && templates.some((t) => t.id === selectedId)) return;
    const def = templates.find((t) => t.is_default) ?? templates[0];
    setSelectedId(def.id);
  }, [templates, selectedId]);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  // Seed the caption editor from the selected preset (and re-seed after a save).
  useEffect(() => {
    if (!selected) return;
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  }, [selected]);

  // The selected preset with the in-progress caption edits applied, for live preview.
  const editedData: SvTemplateData | null = useMemo(() => {
    if (!selected) return null;
    const CH = (selected.data.canvas || {}).height || 1920;
    return {
      ...selected.data,
      captions: {
        ...(selected.data.captions || {}),
        style: capStyle,
        centerY: Math.round((capPos / 100) * CH),
        primary: cssToAss(capPrimary),
        highlight: cssToAss(capHighlight),
      },
    };
  }, [selected, capStyle, capPos, capPrimary, capHighlight]);

  // Have the caption edits diverged from what's saved?
  const capDirty = useMemo(() => {
    if (!selected) return false;
    const cap = selected.data.captions || {};
    return (
      capStyle !== (cap.style === "pop" ? "pop" : "karaoke") ||
      capPos !== posInfo(selected.data).pct ||
      capPrimary.toLowerCase() !== assToCss(cap.primary, "#ffffff").toLowerCase() ||
      capHighlight.toLowerCase() !== assToCss(cap.highlight, "#ffd400").toLowerCase()
    );
  }, [selected, capStyle, capPos, capPrimary, capHighlight]);

  const resetCaptions = () => {
    if (!selected) return;
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  };

  const onSaveCaptions = async () => {
    if (!selected || !editedData) return;
    try {
      await update.mutateAsync({ id: selected.id, data: { data: { captions: editedData.captions } } });
      toast.success("Caption style saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save caption style");
    }
  };

  const onNew = async () => {
    const name = window.prompt("Template name", "My Template");
    if (!name) return;
    try {
      const tpl = await create.mutateAsync({ name });
      setSelectedId(tpl.id);
      toast.success("Template created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create template");
    }
  };

  const onSetDefault = async () => {
    if (!selected) return;
    try {
      await setDefault.mutateAsync(selected.id);
      toast.success("Set as default template");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set default");
    }
  };

  const onDuplicate = async () => {
    if (!selected) return;
    try {
      const tpl = await duplicate.mutateAsync(selected.id);
      setSelectedId(tpl.id);
      toast.success("Duplicated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not duplicate");
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.name}"? This moves it out of your presets.`)) return;
    try {
      await remove.mutateAsync(selected.id);
      setSelectedId(null);
      toast.success("Template deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  };

  const onCreateVideo = () => {
    if (!selected) return;
    // Carry the chosen template into the Studio (StoryVault parity).
    try {
      sessionStorage.setItem("sv_template_id", String(selected.id));
    } catch {
      /* sessionStorage may be unavailable — navigation still works */
    }
    router.push(`/storyvault/studio?template=${selected.id}`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Presets</h1>
          <p className="text-muted-foreground">
            Pick the video template that drives every new video. The default is used automatically.
          </p>
        </div>
        <Button variant="outline" onClick={onNew} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          New template
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No templates yet.</p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="preset" className="space-y-4">
          <TabsList>
            <TabsTrigger value="preset">
              <Clapperboard className="mr-1 h-4 w-4" /> Video preset
            </TabsTrigger>
            <TabsTrigger value="captions">
              <Type className="mr-1 h-4 w-4" /> Caption generation
            </TabsTrigger>
          </TabsList>

          {/* ============ Tab 1: the video preset (picker · preview · settings) ============ */}
          <TabsContent value="preset" className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)_18rem]">
          {/* ---- Left: preset picker ---- */}
          <Card className="lg:sticky lg:top-6">
            <CardContent className="space-y-4 p-4">
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preset
                </p>
                <Select
                  value={selectedId !== null ? String(selectedId) : ""}
                  onValueChange={(v) => setSelectedId(Number(v))}
                >
                  <SelectTrigger className="h-auto min-h-9 items-start whitespace-normal py-2 text-left [&>span]:line-clamp-none">
                    <SelectValue placeholder="Pick a preset" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selected && (
                <div className="space-y-2 rounded-lg border border-primary/60 bg-primary/5 px-4 py-4 ring-1 ring-primary/30">
                  <TemplateBadge t={selected} />
                  <div className="text-base font-semibold leading-snug text-primary">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{tagline(selected.data)}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {selected && (
            <>
              {/* ---- Center: preview + actions beneath it ---- */}
              <div className="space-y-4">
                <Card>
                  <CardContent className="space-y-3 py-6">
                    <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Preview — {selected.name}
                    </p>
                    <PresetBeatPreview t={selected.data} />
                    <p className="text-center text-xs text-muted-foreground">
                      To-scale mock of the placard + caption styling. Flip between the beats below.
                      Gameplay footage is a placeholder.
                    </p>
                  </CardContent>
                </Card>

                {/* Actions sit directly under the preview */}
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    variant={selected.is_default ? "secondary" : "default"}
                    onClick={onSetDefault}
                    disabled={selected.is_default || setDefault.isPending}
                  >
                    <Star className={cn("h-4 w-4", selected.is_default && "fill-current")} />
                    {selected.is_default ? "Default" : "Use for next run"}
                  </Button>
                  <Button variant="outline" onClick={onCreateVideo}>
                    <Clapperboard className="h-4 w-4" /> Create video with this
                  </Button>
                  <Button variant="outline" onClick={onDuplicate} disabled={duplicate.isPending}>
                    <Copy className="h-4 w-4" /> Duplicate
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={onDelete}
                    disabled={remove.isPending}
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                </div>
              </div>

              {/* ---- Right: settings on the side ---- */}
              <Card className="lg:sticky lg:top-6">
                <CardContent className="space-y-4 py-6">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Settings
                  </p>
                  <table className="w-full text-sm">
                    <tbody>
                      {summary(selected.data).map(([key, value]) => (
                        <tr key={key} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-6 align-top text-muted-foreground">{key}</td>
                          <td className="py-1.5 text-right font-medium text-primary">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
          </TabsContent>

          {/* ============ Tab 2: caption generation (position + colours) ============ */}
          <TabsContent
            value="captions"
            className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]"
          >
            {selected && editedData && (
              <>
                {/* ---- Live preview ---- */}
                <Card>
                  <CardContent className="space-y-3 py-6">
                    <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Live preview — {selected.name}
                    </p>
                    <PhonePreview t={editedData} />
                    <p className="text-center text-xs text-muted-foreground">
                      Caption position and colours update as you change them. Save to keep.
                    </p>
                  </CardContent>
                </Card>

                {/* ---- Controls ---- */}
                <Card className="lg:sticky lg:top-6">
                  <CardContent className="space-y-6 py-6">
                    <div className="space-y-2">
                      <Label>Preset</Label>
                      <Select
                        value={selectedId !== null ? String(selectedId) : ""}
                        onValueChange={(v) => setSelectedId(Number(v))}
                      >
                        <SelectTrigger className="h-auto min-h-9 items-start whitespace-normal py-2 text-left [&>span]:line-clamp-none">
                          <SelectValue placeholder="Pick a preset" />
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Caption style */}
                    <div className="space-y-2">
                      <Label className="flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5" /> Caption style
                      </Label>
                      <Select
                        value={capStyle}
                        onValueChange={(v) => setCapStyle(v as "karaoke" | "pop")}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="karaoke">Karaoke — last word highlighted</SelectItem>
                          <SelectItem value="pop">Pop word — words appear one at a time</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Vertical position */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="flex items-center gap-1.5">
                          <Type className="h-3.5 w-3.5" /> Text position
                        </Label>
                        <span className="text-xs text-muted-foreground">
                          {capPos}% {capPos <= 52 ? "(centered)" : "(lower)"}
                        </span>
                      </div>
                      <Slider
                        min={20}
                        max={90}
                        step={1}
                        value={[capPos]}
                        onValueChange={([v]) => setCapPos(v)}
                      />
                      <div className="flex flex-wrap gap-2">
                        {[
                          ["Top", 30],
                          ["Center", 50],
                          ["Lower", 62],
                          ["Bottom", 80],
                        ].map(([label, pct]) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setCapPos(pct as number)}
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs transition",
                              capPos === pct
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Colours */}
                    <ColorField
                      label="Text colour"
                      icon={Palette}
                      value={capPrimary}
                      onChange={(c) => setCapPrimary(c)}
                    />
                    <ColorField
                      label="Highlight colour"
                      hint="karaoke"
                      value={capHighlight}
                      onChange={(c) => setCapHighlight(c)}
                    />

                    <div className="flex gap-2 pt-1">
                      <Button onClick={onSaveCaptions} disabled={!capDirty || update.isPending}>
                        {update.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        Save
                      </Button>
                      <Button variant="outline" onClick={resetCaptions} disabled={!capDirty}>
                        <RotateCcw className="h-4 w-4" /> Reset
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
