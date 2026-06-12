"use client";

import { Palette, Sparkles, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { assToCss, cssToAss, posInfo } from "@/components/storyvault/template-preview";
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
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5" />} {label}
        {hint && <span className="font-normal text-muted-foreground">· {hint}</span>}
      </Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {CAPTION_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={c}
            className={cn(
              "h-6 w-6 rounded-full border border-border ring-offset-2 ring-offset-background transition",
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
          className="h-6 w-6 cursor-pointer rounded-full border border-dashed border-border bg-transparent p-0"
        />
        <span className="ml-1 font-mono text-xs uppercase text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}

// The caption-editing state for a selected preset, shared between the controls and
// a live preview that may render in different places on the page. Edits are local
// until saved, then they persist onto the preset's caption config.
export interface CaptionEditor {
  selected: SvTemplate | null;
  capStyle: "karaoke" | "pop";
  setCapStyle: (v: "karaoke" | "pop") => void;
  capPos: number;
  setCapPos: (n: number) => void;
  capPrimary: string;
  setCapPrimary: (hex: string) => void;
  capHighlight: string;
  setCapHighlight: (hex: string) => void;
  editedData: SvTemplateData | null; // the preset with in-progress edits applied
  dirty: boolean;
  saving: boolean;
  reset: () => void;
  save: () => Promise<void>;
}

export function useCaptionEditor(selected: SvTemplate | null): CaptionEditor {
  const update = useSvUpdateTemplate();

  const [capStyle, setCapStyle] = useState<"karaoke" | "pop">("karaoke");
  const [capPos, setCapPos] = useState(60); // vertical placement, % from top
  const [capPrimary, setCapPrimary] = useState("#ffffff");
  const [capHighlight, setCapHighlight] = useState("#ffd400");

  // Seed the editor from the selected preset (and re-seed after a save).
  useEffect(() => {
    if (!selected) return;
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  }, [selected]);

  const editedData = useMemo<SvTemplateData | null>(() => {
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

  const dirty = useMemo(() => {
    if (!selected) return false;
    const cap = selected.data.captions || {};
    return (
      capStyle !== (cap.style === "pop" ? "pop" : "karaoke") ||
      capPos !== posInfo(selected.data).pct ||
      capPrimary.toLowerCase() !== assToCss(cap.primary, "#ffffff").toLowerCase() ||
      capHighlight.toLowerCase() !== assToCss(cap.highlight, "#ffd400").toLowerCase()
    );
  }, [selected, capStyle, capPos, capPrimary, capHighlight]);

  const reset = () => {
    if (!selected) return;
    const cap = selected.data.captions || {};
    setCapStyle(cap.style === "pop" ? "pop" : "karaoke");
    setCapPos(posInfo(selected.data).pct);
    setCapPrimary(assToCss(cap.primary, "#ffffff").toLowerCase());
    setCapHighlight(assToCss(cap.highlight, "#ffd400").toLowerCase());
  };

  const save = async () => {
    if (!selected || !editedData) return;
    try {
      await update.mutateAsync({ id: selected.id, data: { data: { captions: editedData.captions } } });
      toast.success("Caption style saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save caption style");
    }
  };

  return {
    selected,
    capStyle, setCapStyle,
    capPos, setCapPos,
    capPrimary, setCapPrimary,
    capHighlight, setCapHighlight,
    editedData,
    dirty,
    saving: update.isPending,
    reset,
    save,
  };
}

// The caption controls (style · vertical position · text/highlight colours · save
// / reset), driven by a CaptionEditor. Laid out as a compact 2-column grid so it
// sits neatly beneath the create-video form.
export function CaptionControls({ editor, className }: { editor: CaptionEditor; className?: string }) {
  const {
    capStyle, setCapStyle,
    capPos, setCapPos,
    capPrimary, setCapPrimary,
    capHighlight, setCapHighlight,
  } = editor;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Caption style */}
        <div className="space-y-1.5">
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
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5" /> Text position
            </Label>
            <span className="text-xs text-muted-foreground">
              {capPos}% {capPos <= 52 ? "(centered)" : "(lower)"}
            </span>
          </div>
          <Slider min={20} max={90} step={1} value={[capPos]} onValueChange={([v]) => setCapPos(v)} />
          <div className="flex flex-wrap gap-1.5">
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
                  "rounded-full border px-2.5 py-0.5 text-xs transition",
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
      </div>
    </div>
  );
}
