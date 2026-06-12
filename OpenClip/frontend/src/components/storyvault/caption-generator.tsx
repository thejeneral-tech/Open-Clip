"use client";

import { Loader2, Palette, RotateCcw, Save, Sparkles, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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

// ASS colour (&HAABBGGRR) → CSS #RRGGBB. Mirrors the render so the preview shows
// the exact caption/highlight hues the burned video will use.
export function assToCss(ass: string | undefined, fallback: string): string {
  if (!ass || typeof ass !== "string") return fallback;
  let hex = ass.replace(/[&Hh]/g, "").trim();
  if (hex.length === 8) hex = hex.slice(2); // drop alpha → BBGGRR
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return "#" + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2); // BBGGRR → RRGGBB
}

// CSS #RRGGBB → ASS colour (&H00BBGGRR). Inverse of assToCss; alpha 00 = opaque.
export function cssToAss(css: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(css.trim());
  if (!m) return "&H00FFFFFF";
  const h = m[1];
  return ("&H00" + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase();
}

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

// 8-direction solid stroke approximating the ASS \bord outline.
function outline(px: number, col = "#000"): string {
  const o = Math.max(1, Math.round(px));
  const s: string[] = [];
  for (const dx of [-o, 0, o]) for (const dy of [-o, 0, o]) if (dx || dy) s.push(`${dx}px ${dy}px 0 ${col}`);
  return s.join(",");
}

// Caption vertical placement, as % of frame height: centerY when set, else
// (canvasHeight − marginV).
export function posInfo(t: SvTemplateData) {
  const cap = t.captions || {};
  const CH = (t.canvas || {}).height || 1920;
  const y = cap.centerY || (CH - (cap.marginV || 520));
  const pct = Math.round((y / CH) * 100);
  return { y, pct, label: pct <= 52 ? `centered (${pct}%)` : `lower (${pct}%)` };
}

const pxv = (n: number) => `${n}px`;

// A to-scale 9:16 mock of what THIS template renders: gameplay layer + topic
// card + body caption, every size/position/colour scaled from canvas px by
// k = previewWidth / canvasWidth.
export function PhonePreview({ t }: { t: SvTemplateData }) {
  const cv = t.canvas || {};
  const tc = t.topicCard || {};
  const cap = t.captions || {};
  const gp = t.gameplay || {};
  const safe = t.safe || {};
  const CW = cv.width || 1080;
  const CH = cv.height || 1920;
  const PW = 252;
  const k = PW / CW;
  const PH = CH * k;
  const split = gp.mode === "split_bottom";

  const gameGrad = "linear-gradient(150deg,#28374f 0%,#16202f 55%,#0c121c 100%)";
  const layers: React.ReactNode[] = [];

  if (split) {
    layers.push(
      <div key="g-top" style={{ position: "absolute", left: 0, right: 0, top: 0, height: "50%", background: "#0a0f17" }} />,
      <div key="g-bot" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "50%", background: gameGrad }} />,
      <div key="g-div" style={{ position: "absolute", left: 0, right: 0, top: "50%", height: "2px", background: "rgba(255,255,255,.22)" }} />,
    );
  } else {
    layers.push(<div key="g" style={{ position: "absolute", inset: 0, background: gameGrad }} />);
  }
  layers.push(
    <div key="gp-label" style={{ position: "absolute", right: "6px", bottom: "5px", fontSize: "7px", letterSpacing: ".5px", fontWeight: 700, color: "rgba(255,255,255,.3)" }}>
      ▶ GAMEPLAY
    </div>,
  );

  // ---- Stage 1: topic card ----
  if (tc.enabled !== false) {
    const cardW = (tc.width || 820) * k;
    const titleSize = (tc.titleSize || 50) * k;
    const metaSize = (tc.metaSize || 34) * k;
    const nameSize = 42 * k;
    const avR = 30 * k;
    const showAvatar = tc.avatar !== false;
    const cy = (tc.centerY || 760) * k;
    layers.push(
      <div
        key="card"
        style={{
          position: "absolute", left: "50%", top: pxv(cy), transform: "translate(-50%,-50%)",
          width: pxv(cardW), boxSizing: "border-box", background: "#fff", color: "#141414",
          borderRadius: pxv((tc.radius || 46) * k), padding: `${pxv(30 * k)} ${pxv(40 * k)}`,
          boxShadow: "0 6px 18px rgba(0,0,0,.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: pxv(10 * k), marginBottom: pxv(10 * k) }}>
          {showAvatar && (
            <div style={{ width: pxv(avR * 2), height: pxv(avR * 2), borderRadius: "50%", background: "#3a95b3", color: "#fff", fontWeight: 800, fontSize: pxv(nameSize), display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>
              S
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: pxv(6 * k) }}>
              <span style={{ fontWeight: 800, color: "#141414", fontSize: pxv(nameSize), whiteSpace: "nowrap" }}>Salty-Yeti-4489</span>
              <span style={{ width: pxv(20 * k), height: pxv(20 * k), borderRadius: "50%", background: "#1d96e8", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: pxv(13 * k), flex: "0 0 auto" }}>✓</span>
            </div>
            <div style={{ color: "#777", fontSize: pxv(metaSize), marginTop: pxv(2 * k) }}>u/Salty-Yeti-4489</div>
          </div>
        </div>
        <div style={{ fontWeight: 800, color: "#141414", fontSize: pxv(titleSize), lineHeight: 1.16, marginBottom: pxv(10 * k) }}>
          AITA for charging my family rent after they moved in?
        </div>
        <div style={{ fontSize: pxv(metaSize), color: "#777" }}>
          <span style={{ color: "#e02430", fontWeight: 700 }}>♥ </span>99+
          <span style={{ display: "inline-block", width: pxv(18 * k) }} />🗨 99+
        </div>
      </div>,
    );
  }

  // ---- Stage 3: body captions ----
  if (cap.enabled !== false) {
    const capY = posInfo(t).y * k;
    const fs = (cap.size || 80) * k;
    const pop = cap.style === "pop";
    const primary = assToCss(cap.primary, "#fff");
    const highlight = assToCss(cap.highlight, "#ffd400");
    const ow = (cap.outline || 7) * k;
    const fontStack = pop
      ? '"Arial Rounded MT Bold","Arial Rounded MT",Arial,sans-serif'
      : cap.font
        ? `"${cap.font}",Arial,sans-serif`
        : "Arial,sans-serif";
    const maxW = (CW - 2 * (safe.side || 60)) * k;
    const base = ["then", "I", "discovered"];
    const n = Math.max(1, Math.min(base.length, cap.maxWords || (pop ? 2 : 4)));
    const words = base.slice(base.length - n);
    const children = pop
      ? words.join(" ")
      : words.map((w, i) => (
          <span key={i} style={{ color: i === words.length - 1 ? highlight : primary }}>
            {w + (i < words.length - 1 ? " " : "")}
          </span>
        ));
    layers.push(
      <div
        key="caps"
        style={{
          position: "absolute", left: "50%", top: pxv(capY), transform: "translate(-50%,-50%)",
          width: pxv(maxW), textAlign: "center", color: primary, fontWeight: 800,
          fontFamily: fontStack, fontSize: pxv(fs), lineHeight: 1.1, textShadow: outline(ow, "#000"),
        }}
      >
        {children}
      </div>,
    );
  }

  return (
    <div
      style={{ position: "relative", width: pxv(PW), height: pxv(PH), margin: "0 auto", borderRadius: "14px", overflow: "hidden", background: "#0c121c" }}
    >
      {layers}
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
