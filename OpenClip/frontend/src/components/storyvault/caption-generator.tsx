"use client";

import { Loader2, Palette, RotateCcw, Save, Sparkles, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { assToCss, cssToAss, PhonePreview, posInfo } from "@/components/storyvault/template-preview";
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
import { useSvUpdateTemplate } from "@/hooks/use-api";
import type { SvTemplate, SvTemplateData } from "@/lib/types";
import { cn } from "@/lib/utils";

// Swatches offered in the caption colour pickers (plus a free-form picker).
const CAPTION_SWATCHES = ["#ffffff", "#ffd400", "#000000", "#ff3b30", "#34c759", "#0a84ff", "#ff2d92"];

// Reusable swatch row + native colour picker + hex readout.
export function ColorField({
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

// Caption-generation editor — style (karaoke/pop) + vertical position + text and
// highlight colours, with a live phone preview. Edits are local until saved, at
// which point they persist onto the preset's caption config. Shared by the
// Presets page and the Video Studio so both drive captions the same way.
//
// `presetSelect` is an optional control (e.g. a preset dropdown) rendered atop
// the editor; pages that already pick the preset elsewhere can omit it.
export function CaptionGenerator({
  selected,
  presetSelect,
  className,
}: {
  selected: SvTemplate;
  presetSelect?: React.ReactNode;
  className?: string;
}) {
  const update = useSvUpdateTemplate();

  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  const [capPos, setCapPos] = useState(60); // vertical placement, % from top
  const [capPrimary, setCapPrimary] = useState("#ffffff");
  const [capHighlight, setCapHighlight] = useState("#ffd400");

  // Seed the editor from the selected preset (and re-seed after a save).
  useEffect(() => {
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  }, [selected]);

  // The selected preset with the in-progress caption edits applied, for preview.
  const editedData: SvTemplateData = useMemo(() => {
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
    const cap = selected.data.captions || {};
    return (
      capStyle !== (cap.style === "pop" ? "pop" : "karaoke") ||
      capPos !== posInfo(selected.data).pct ||
      capPrimary.toLowerCase() !== assToCss(cap.primary, "#ffffff").toLowerCase() ||
      capHighlight.toLowerCase() !== assToCss(cap.highlight, "#ffd400").toLowerCase()
    );
  }, [selected, capStyle, capPos, capPrimary, capHighlight]);

  const resetCaptions = () => {
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  };

  const onSaveCaptions = async () => {
    try {
      await update.mutateAsync({ id: selected.id, data: { data: { captions: editedData.captions } } });
      toast.success("Caption style saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save caption style");
    }
  };

  return (
    <div className={cn("grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]", className)}>
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
          {presetSelect}

          {/* Caption style */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Caption style
            </Label>
            <Select value={capStyle} onValueChange={(v) => setCapStyle(v as "karaoke" | "pop")}>
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
            <Slider min={20} max={90} step={1} value={[capPos]} onValueChange={([v]) => setCapPos(v)} />
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
          <ColorField label="Text colour" icon={Palette} value={capPrimary} onChange={(c) => setCapPrimary(c)} />
          <ColorField label="Highlight colour" hint="karaoke" value={capHighlight} onChange={(c) => setCapHighlight(c)} />

          <div className="flex gap-2 pt-1">
            <Button onClick={onSaveCaptions} disabled={!capDirty || update.isPending}>
              {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
            <Button variant="outline" onClick={resetCaptions} disabled={!capDirty}>
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
