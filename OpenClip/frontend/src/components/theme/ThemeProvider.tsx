"use client";

import {
  createContext,
  useCallback as _useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ADV_KEYS,
  computeAdvancedDefaults,
  contrastColor,
  deriveSyntaxColors,
  type Palette,
} from "@/lib/theme/colorUtils";
import {
  type BgPattern,
  type CustomThemeEntry,
  DEFAULT_DENSITY,
  DEFAULT_FONT,
  DEFAULT_THEME,
  FONT_MAP,
  getSaved,
  loadCustomThemes,
  type SavedTheme,
  saveTheme,
  saveCustomTheme as persistCustomTheme,
  deleteCustomTheme as removeCustomTheme,
  THEME_DEFAULT_EFFECT_COLOR,
  THEME_DEFAULT_FROSTED,
  THEME_DEFAULT_INTENSITY,
  THEME_DEFAULT_PATTERN,
  THEMES,
  type ThemeOpts,
} from "@/lib/theme/themes";

interface ThemeState {
  name: string;
  colors: Palette;
  font: string;
  density: string;
  bgPattern: BgPattern;
  bgEffectColor: string; // "" → fall back to --fg
  bgEffectIntensity: number; // 0..1
  bgEffectSize: number; // 0.2..3
  frosted: boolean;
}

interface ThemeContextValue extends ThemeState {
  customThemes: Record<string, CustomThemeEntry>;
  selectPreset: (name: string) => void;
  selectCustom: (name: string) => void;
  updateColors: (colors: Palette) => void;
  setFont: (font: string) => void;
  setDensity: (density: string) => void;
  setBgPattern: (p: BgPattern) => void;
  setEffectColor: (c: string) => void;
  setIntensity: (v: number) => void;
  setSize: (v: number) => void;
  setFrosted: (on: boolean) => void;
  saveAsCustom: (name: string) => "ok" | "limit" | "invalid" | "exists";
  deleteCustom: (name: string) => void;
  reset: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function defaultState(): ThemeState {
  return {
    name: DEFAULT_THEME,
    colors: THEMES[DEFAULT_THEME],
    font: DEFAULT_FONT,
    density: DEFAULT_DENSITY,
    bgPattern: THEME_DEFAULT_PATTERN[DEFAULT_THEME] || "none",
    bgEffectColor: THEME_DEFAULT_EFFECT_COLOR[DEFAULT_THEME] || "",
    bgEffectIntensity: THEME_DEFAULT_INTENSITY[DEFAULT_THEME] ?? 1,
    bgEffectSize: 1,
    frosted: THEME_DEFAULT_FROSTED[DEFAULT_THEME] ?? false,
  };
}

function stateFromSaved(saved: SavedTheme): ThemeState {
  return {
    name: saved.name,
    colors: saved.colors,
    font: saved.font || DEFAULT_FONT,
    density: saved.density || DEFAULT_DENSITY,
    bgPattern: saved.bgPattern || THEME_DEFAULT_PATTERN[saved.name] || "none",
    bgEffectColor: saved.bgEffectColor || THEME_DEFAULT_EFFECT_COLOR[saved.name] || "",
    bgEffectIntensity:
      saved.bgEffectIntensity !== undefined
        ? saved.bgEffectIntensity
        : THEME_DEFAULT_INTENSITY[saved.name] ?? 1,
    bgEffectSize: saved.bgEffectSize ?? 1,
    frosted: saved.frosted ?? THEME_DEFAULT_FROSTED[saved.name] ?? false,
  };
}

/** Apply a palette (+ derived syntax + advanced overrides) to <html>. */
function applyColors(colors: Palette) {
  const s = document.documentElement.style;
  s.setProperty("--bg", colors.bg);
  s.setProperty("--fg", colors.fg);
  s.setProperty("--panel", colors.panel);
  s.setProperty("--border", colors.border);
  if (colors.red) s.setProperty("--red", colors.red);
  s.setProperty("--accent-contrast", contrastColor(colors.red || "#e06c75"));
  s.setProperty("--muted-fg", `color-mix(in srgb, ${colors.fg} 58%, ${colors.bg})`);
  s.setProperty("--hover-bg", `color-mix(in srgb, ${colors.fg} 8%, ${colors.bg})`);

  const syn = deriveSyntaxColors(colors);
  s.setProperty("--hl-bg", syn.bg);
  s.setProperty("--hl-fg", syn.fg);
  s.setProperty("--hl-keyword", syn.keyword);
  s.setProperty("--hl-string", syn.string);
  s.setProperty("--hl-comment", syn.comment);
  s.setProperty("--hl-function", syn.function);
  s.setProperty("--hl-number", syn.number);
  s.setProperty("--hl-builtin", syn.builtin);
  s.setProperty("--hl-variable", syn.variable);
  s.setProperty("--hl-params", syn.params);

  const adv = colors.advanced || {};
  const defaults = computeAdvancedDefaults(colors);
  for (const { key, css } of ADV_KEYS) {
    s.setProperty(css, adv[key] || defaults[key]);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && colors.bg) meta.setAttribute("content", colors.bg);
}

function applyFontDensity(font: string, density: string) {
  const family = FONT_MAP[font] || FONT_MAP[DEFAULT_FONT];
  document.documentElement.style.setProperty("--font-family", family);
  document.documentElement.classList.remove("density-compact", "density-spacious");
  if (density !== "comfortable") document.documentElement.classList.add("density-" + density);
}

const PATTERN_CLASSES = [
  "bg-pattern-dots",
  "bg-pattern-synapse",
  "bg-pattern-rain",
  "bg-pattern-constellations",
  "bg-pattern-perlin-flow",
  "bg-pattern-petals",
  "bg-pattern-sparkles",
  "bg-pattern-embers",
];

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ThemeState>(defaultState);
  const [customThemes, setCustomThemes] = useState<Record<string, CustomThemeEntry>>({});
  const hydrated = useRef(false);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    const saved = getSaved();
    if (saved && saved.colors) setState(stateFromSaved(saved));
    setCustomThemes(loadCustomThemes());
    hydrated.current = true;
  }, []);

  // Apply the full state to the DOM whenever it changes.
  useEffect(() => {
    applyColors(state.colors);
    applyFontDensity(state.font, state.density);
    document.documentElement.style.setProperty(
      "--bg-effect-color",
      state.bgEffectColor || "",
    );
    document.documentElement.style.setProperty(
      "--bg-effect-intensity",
      String(state.bgEffectIntensity),
    );
    document.documentElement.style.setProperty(
      "--bg-effect-size",
      String(state.bgEffectSize),
    );
    const body = document.body;
    PATTERN_CLASSES.forEach((c) => body.classList.remove(c));
    if (state.bgPattern !== "none") body.classList.add("bg-pattern-" + state.bgPattern);
    body.classList.toggle("theme-frosted", state.frosted);
  }, [state]);

  const opts = _useCallback(
    (s: ThemeState): ThemeOpts => ({
      font: s.font,
      density: s.density,
      bgPattern: s.bgPattern,
      bgEffectColor: s.bgEffectColor,
      bgEffectIntensity: s.bgEffectIntensity,
      bgEffectSize: s.bgEffectSize,
      frosted: s.frosted,
    }),
    [],
  );

  // Persist current state; if active theme is a user custom theme, write back into it.
  const persist = _useCallback(
    (next: ThemeState) => {
      saveTheme(next.name, next.colors, opts(next));
      if (customThemes[next.name]) {
        persistCustomTheme(next.name, next.colors, opts(next));
        setCustomThemes(loadCustomThemes());
      }
    },
    [customThemes, opts],
  );

  const update = _useCallback(
    (patch: Partial<ThemeState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const selectPreset = _useCallback((name: string) => {
    const colors = THEMES[name];
    if (!colors) return;
    setState(() => {
      const next: ThemeState = {
        name,
        colors,
        font: DEFAULT_FONT,
        density: DEFAULT_DENSITY,
        bgPattern: THEME_DEFAULT_PATTERN[name] || "none",
        bgEffectColor: THEME_DEFAULT_EFFECT_COLOR[name] || "",
        bgEffectIntensity: THEME_DEFAULT_INTENSITY[name] ?? 1,
        bgEffectSize: 1,
        frosted: THEME_DEFAULT_FROSTED[name] ?? false,
      };
      saveTheme(next.name, next.colors, opts(next));
      return next;
    });
  }, [opts]);

  const selectCustom = _useCallback(
    (name: string) => {
      const c = customThemes[name];
      if (!c) return;
      const { font, density, bgPattern, bgEffectColor, bgEffectIntensity, bgEffectSize, frosted, advanced, ...rest } = c;
      const colors: Palette = {
        bg: rest.bg,
        fg: rest.fg,
        panel: rest.panel,
        border: rest.border,
        red: rest.red,
        ...(advanced ? { advanced } : {}),
      };
      setState(() => {
        const next: ThemeState = {
          name,
          colors,
          font: font || DEFAULT_FONT,
          density: density || DEFAULT_DENSITY,
          bgPattern: bgPattern || "none",
          bgEffectColor: bgEffectColor || "",
          bgEffectIntensity: bgEffectIntensity ?? 1,
          bgEffectSize: bgEffectSize ?? 1,
          frosted: frosted ?? false,
        };
        saveTheme(next.name, next.colors, opts(next));
        return next;
      });
    },
    [customThemes, opts],
  );

  const updateColors = _useCallback(
    (colors: Palette) => {
      setState((prev) => {
        // Live edits land on the active custom theme, else a transient "custom" slot.
        const name = customThemes[prev.name] ? prev.name : "custom";
        const next = { ...prev, name, colors };
        saveTheme(name, colors, opts(next));
        if (customThemes[name]) {
          persistCustomTheme(name, colors, opts(next));
        }
        return next;
      });
    },
    [customThemes, opts],
  );

  const saveAsCustom = _useCallback(
    (rawName: string): "ok" | "limit" | "invalid" | "exists" => {
      const slug = rawName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (!slug) return "invalid";
      if (THEMES[slug]) return "exists";
      const res = persistCustomTheme(slug, state.colors, opts(state));
      if (res === "limit") return "limit";
      setCustomThemes(loadCustomThemes());
      setState((prev) => {
        const next = { ...prev, name: slug };
        saveTheme(slug, prev.colors, opts(prev));
        return next;
      });
      return "ok";
    },
    [state, opts],
  );

  const deleteCustom = _useCallback(
    (name: string) => {
      removeCustomTheme(name);
      setCustomThemes(loadCustomThemes());
      setState((prev) => (prev.name === name ? defaultState() : prev));
    },
    [],
  );

  const reset = _useCallback(() => {
    setState(defaultState());
    saveTheme(DEFAULT_THEME, THEMES[DEFAULT_THEME], {});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...state,
      customThemes,
      selectPreset,
      selectCustom,
      updateColors,
      setFont: (font) => update({ font }),
      setDensity: (density) => update({ density }),
      setBgPattern: (bgPattern) => update({ bgPattern }),
      setEffectColor: (bgEffectColor) => update({ bgEffectColor }),
      setIntensity: (bgEffectIntensity) => update({ bgEffectIntensity }),
      setSize: (bgEffectSize) => update({ bgEffectSize }),
      setFrosted: (frosted) => update({ frosted }),
      saveAsCustom,
      deleteCustom,
      reset,
    }),
    [state, customThemes, selectPreset, selectCustom, updateColors, update, saveAsCustom, deleteCustom, reset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
