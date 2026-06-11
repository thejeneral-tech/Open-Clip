"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Sparkles, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import {
  ADV_KEYS,
  computeAdvancedDefaults,
  generateHarmonyColors,
  type AdvKey,
  type HarmonyType,
  type Palette,
} from "@/lib/theme/colorUtils";
import {
  BG_PATTERNS,
  type BgPattern,
  THEME_ORDER,
  THEMES,
  themeLabel,
} from "@/lib/theme/themes";
import { useTheme } from "./ThemeProvider";
import { cn } from "@/lib/utils";

const FONTS = [
  { value: "mono", label: "Mono (Fira Code)" },
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
];
const DENSITIES = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
];
const BASE_KEYS: { key: keyof Palette; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "fg", label: "Foreground" },
  { key: "panel", label: "Panel" },
  { key: "border", label: "Border" },
  { key: "red", label: "Accent" },
];

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition hover:bg-[var(--hover-bg)]">
      <span className="text-xs text-fg">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-muted">{value}</span>
        <input
          type="color"
          className="oc-color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

function Swatch({
  name,
  palette,
  active,
  label,
  onClick,
  onDelete,
}: {
  name: string;
  palette: Palette;
  active: boolean;
  label: string;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      type="button"
      data-theme={name}
      className={cn("theme-swatch text-left", active && "active")}
      onClick={onClick}
    >
      <div className="theme-swatch-colors">
        <span style={{ background: palette.bg }} />
        <span style={{ background: palette.panel }} />
        <span style={{ background: palette.fg }} />
        <span style={{ background: palette.red }} />
      </div>
      <span className="truncate">{label}</span>
      {onDelete && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded text-muted opacity-0 transition hover:bg-[var(--hover-bg)] hover:text-[var(--red)] group-hover:opacity-100 [.theme-swatch:hover_&]:opacity-100"
        >
          <X size={11} />
        </span>
      )}
    </button>
  );
}

export function ThemeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const [tab, setTab] = useState<"themes" | "customize">("themes");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [harmonyAccent, setHarmonyAccent] = useState("#e06c75");
  const [harmonyType, setHarmonyType] = useState<HarmonyType>("complementary");
  const [harmonyMode, setHarmonyMode] = useState<"dark" | "light">("dark");
  const fileRef = useRef<HTMLInputElement>(null);

  // The palette currently being edited.
  const palette = t.colors;
  const advDefaults = useMemo(() => computeAdvancedDefaults(palette), [palette]);

  useEffect(() => {
    setHarmonyAccent(palette.red);
  }, [palette.red]);

  const setBase = (key: keyof Palette, val: string) => {
    t.updateColors({ ...palette, [key]: val });
  };
  const setAdv = (key: AdvKey, val: string) => {
    const advanced = { ...(palette.advanced || {}) };
    if (val.toLowerCase() === (advDefaults[key] || "").toLowerCase()) {
      delete advanced[key];
    } else {
      advanced[key] = val;
    }
    t.updateColors({
      ...palette,
      advanced: Object.keys(advanced).length ? advanced : undefined,
    });
  };

  const doSaveCustom = () => {
    const res = t.saveAsCustom(saveName.trim());
    if (res === "invalid") return toast.error("Enter a valid name.");
    if (res === "exists") return toast.error("That name is a built-in theme.");
    if (res === "limit") return toast.error("Max 8 custom themes — delete one first.");
    toast.success(`Saved theme "${saveName.trim()}"`);
    setSaveName("");
  };

  const doExport = () => {
    const obj = {
      name: t.name,
      colors: palette,
      font: t.font,
      density: t.density,
      bgPattern: t.bgPattern,
      bgEffectColor: t.bgEffectColor,
    };
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclip_${t.name || "theme"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Theme exported");
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const c = parsed.colors || parsed;
        const required = ["bg", "fg", "panel", "border", "red"];
        const missing = required.filter((k) => !c[k]);
        if (missing.length) return toast.error(`Missing: ${missing.join(", ")}`);
        t.updateColors({
          bg: c.bg, fg: c.fg, panel: c.panel, border: c.border, red: c.red,
          ...(c.advanced ? { advanced: c.advanced } : {}),
        });
        if (parsed.bgPattern) t.setBgPattern(parsed.bgPattern);
        toast.success("Theme imported");
        setTab("customize");
      } catch {
        toast.error("Invalid theme file");
      }
    };
    reader.readAsText(file);
  };

  const applyHarmony = () => {
    const colors = generateHarmonyColors(harmonyAccent, harmonyType, harmonyMode);
    t.updateColors(colors);
  };

  const customEntries = Object.entries(t.customThemes);

  return (
    <Modal open={open} onClose={onClose} title="Appearance & Themes" className="max-w-2xl">
      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border border-border p-1">
        {(["themes", "customize"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition",
              tab === id ? "bg-[var(--red)] text-[var(--accent-contrast)]" : "text-muted hover:bg-[var(--hover-bg)]",
            )}
          >
            {id}
          </button>
        ))}
      </div>

      {tab === "themes" && (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Presets
            </h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {THEME_ORDER.map((name) => (
                <Swatch
                  key={name}
                  name={name}
                  palette={THEMES[name]}
                  label={themeLabel(name)}
                  active={t.name === name}
                  onClick={() => t.selectPreset(name)}
                />
              ))}
            </div>
          </section>

          {customEntries.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Your Themes
              </h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {customEntries.map(([name, c]) => (
                  <Swatch
                    key={name}
                    name={name}
                    palette={c}
                    label={name}
                    active={t.name === name}
                    onClick={() => t.selectCustom(name)}
                    onDelete={() => {
                      t.deleteCustom(name);
                      toast.success(`Deleted "${name}"`);
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="grid grid-cols-2 gap-3">
            <Field label="Font">
              <select className="oc-input w-full" value={t.font} onChange={(e) => t.setFont(e.target.value)}>
                {FONTS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Density">
              <select className="oc-input w-full" value={t.density} onChange={(e) => t.setDensity(e.target.value)}>
                {DENSITIES.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </Field>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Background
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Pattern">
                <select
                  className="oc-input w-full"
                  value={t.bgPattern}
                  onChange={(e) => t.setBgPattern(e.target.value as BgPattern)}
                >
                  {BG_PATTERNS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Effect Color">
                <input
                  type="color"
                  className="oc-color h-[38px] w-full"
                  value={t.bgEffectColor || palette.fg}
                  onChange={(e) => t.setEffectColor(e.target.value)}
                />
              </Field>
            </div>
            {t.bgPattern !== "none" && t.bgPattern !== "dots" && (
              <div className="grid grid-cols-2 gap-4">
                <Field label={`Intensity · ${Math.round(t.bgEffectIntensity * 100)}%`}>
                  <input
                    type="range" className="oc-range w-full" min={0} max={100}
                    value={Math.round(t.bgEffectIntensity * 100)}
                    onChange={(e) => t.setIntensity(Number(e.target.value) / 100)}
                  />
                </Field>
                <Field label={`Size · ${Math.round(t.bgEffectSize * 100)}%`}>
                  <input
                    type="range" className="oc-range w-full" min={30} max={250}
                    value={Math.round(t.bgEffectSize * 100)}
                    onChange={(e) => t.setSize(Number(e.target.value) / 100)}
                  />
                </Field>
              </div>
            )}
            <label className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 hover:bg-[var(--hover-bg)]">
              <span className="text-xs text-fg">Frosted glass</span>
              <Toggle on={t.frosted} onChange={t.setFrosted} />
            </label>
          </section>
        </div>
      )}

      {tab === "customize" && (
        <div className="space-y-5">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Base Colors
            </h3>
            <div className="rounded-lg border border-border p-1.5">
              {BASE_KEYS.map(({ key, label }) => (
                <ColorRow
                  key={key}
                  label={label}
                  value={(palette[key] as string) || "#000000"}
                  onChange={(v) => setBase(key, v)}
                />
              ))}
            </div>
          </section>

          <section>
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              <span>Advanced — per-zone colors</span>
              <span>{showAdvanced ? "–" : "+"}</span>
            </button>
            {showAdvanced && (
              <div className="mt-2 rounded-lg border border-border p-1.5">
                {ADV_KEYS.map(({ key, label }) => (
                  <ColorRow
                    key={key}
                    label={label}
                    value={palette.advanced?.[key] || advDefaults[key]}
                    onChange={(v) => setAdv(key, v)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Sparkles size={13} /> Harmony Generator
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Accent">
                <input type="color" className="oc-color h-[34px] w-12" value={harmonyAccent} onChange={(e) => setHarmonyAccent(e.target.value)} />
              </Field>
              <Field label="Type">
                <select className="oc-input" value={harmonyType} onChange={(e) => setHarmonyType(e.target.value as HarmonyType)}>
                  <option value="complementary">Complementary</option>
                  <option value="analogous">Analogous</option>
                  <option value="triadic">Triadic</option>
                  <option value="monochromatic">Monochromatic</option>
                </select>
              </Field>
              <Field label="Mode">
                <select className="oc-input" value={harmonyMode} onChange={(e) => setHarmonyMode(e.target.value as "dark" | "light")}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Field>
              <button type="button" className="oc-btn oc-btn-primary" onClick={applyHarmony}>
                Generate
              </button>
            </div>
          </section>

          <section className="flex flex-wrap items-end gap-2">
            <Field label="Save current as">
              <input
                className="oc-input w-44"
                placeholder="theme name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSaveCustom()}
              />
            </Field>
            <button type="button" className="oc-btn oc-btn-primary" onClick={doSaveCustom}>
              <Check size={14} /> Save
            </button>
            <div className="ml-auto flex gap-2">
              <button type="button" className="oc-btn" onClick={doExport}>
                <Download size={14} /> Export
              </button>
              <button type="button" className="oc-btn" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> Import
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doImport(f);
                  e.target.value = "";
                }}
              />
            </div>
          </section>

          <button type="button" className="oc-btn oc-btn-ghost flex items-center gap-1.5 text-[var(--red)]" onClick={t.reset}>
            <Trash2 size={14} /> Reset to defaults
          </button>
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 rounded-full transition",
        on ? "bg-[var(--toggle-active)]" : "bg-[var(--border)]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
          on ? "left-[1.125rem]" : "left-0.5",
        )}
      />
    </button>
  );
}
