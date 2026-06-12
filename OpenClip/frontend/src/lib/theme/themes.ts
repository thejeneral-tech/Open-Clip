/**
 * Theme presets + persistence — ported from Odysseus' theme.js.
 * 16 built-in palettes, custom themes, fonts, density, animated background
 * patterns, frosted glass, and advanced per-zone color overrides.
 */
import type { Palette } from "./colorUtils";

export const THEMES: Record<string, Palette> = {
  "open-code-default": { bg: "#1f231f", fg: "#d5dcd6", panel: "#141514", border: "#404f41", red: "#65c26c" },
  dark: { bg: "#282c34", fg: "#9cdef2", panel: "#111111", border: "#355a66", red: "#e06c75" },
  light: { bg: "#f0ebe3", fg: "#5a5248", panel: "#faf6f0", border: "#d4cdc2", red: "#c47d5a" },
  midnight: { bg: "#0d1117", fg: "#c9d1d9", panel: "#161b22", border: "#30363d", red: "#f85149" },
  paper: { bg: "#faf8f5", fg: "#3b3836", panel: "#ffffff", border: "#d5d0c8", red: "#c5ac4a" },
  cyberpunk: { bg: "#0a0a0f", fg: "#0ff0fc", panel: "#12101a", border: "#9b30ff", red: "#e040fb" },
  retrowave: { bg: "#1a1a2e", fg: "#e94560", panel: "#16213e", border: "#533483", red: "#e94560" },
  forest: { bg: "#1b2a1b", fg: "#a8d5a2", panel: "#142414", border: "#3d6b3d", red: "#7cb871" },
  ocean: { bg: "#0b1a2c", fg: "#64d2ff", panel: "#091422", border: "#1e5074", red: "#4facfe" },
  ume: { bg: "#2b1b2e", fg: "#f5c2e7", panel: "#1e1420", border: "#6c4675", red: "#f5a0c0" },
  copper: { bg: "#1c1410", fg: "#e8c39e", panel: "#140f0a", border: "#7a5533", red: "#d4764e" },
  terminal: { bg: "#000000", fg: "#00ff41", panel: "#0a0a0a", border: "#003b00", red: "#00ff41" },
  organs: { bg: "#0a0406", fg: "#efe1c8", panel: "#15080a", border: "#3a1519", red: "#c83240" },
  lavender: { bg: "#f3eef8", fg: "#3d3551", panel: "#faf7ff", border: "#cec3de", red: "#9b6dcc" },
  gpt: {
    bg: "#212121", fg: "#ececec", panel: "#171717", border: "#424242", red: "#949494",
    advanced: { sendBtnBg: "#949494", sendBtnHover: "#7f7f7f", aiBubbleBg: "#171717", inputBg: "#2f2f2f" },
  },
  claude: { bg: "#262624", fg: "#f5f4f0", panel: "#30302e", border: "#4a4a47", red: "#c6613f" },
  cute: { bg: "#fff0f5", fg: "#d4608a", panel: "#fff8fa", border: "#f0c0d0", red: "#ff6b9d" },
};

export const THEME_ORDER = Object.keys(THEMES);

export function themeLabel(name: string): string {
  if (name === "open-code-default") return "open code";
  if (name === "dark") return "original";
  if (name === "gpt") return "GPT";
  return name;
}

export const DEFAULT_THEME = "open-code-default";
export const LS_KEY = "openclip-theme";
export const CUSTOM_THEMES_KEY = "openclip-custom-themes";
export const MAX_CUSTOM_THEMES = 8;

export const FONT_MAP: Record<string, string> = {
  mono: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};
export const DEFAULT_FONT = "mono";
export const DEFAULT_DENSITY = "comfortable";

export type BgPattern =
  | "none"
  | "dots"
  | "synapse"
  | "rain"
  | "constellations"
  | "perlin-flow"
  | "petals"
  | "sparkles"
  | "embers";

export const BG_PATTERNS: { value: BgPattern; label: string }[] = [
  { value: "none", label: "None" },
  { value: "dots", label: "Dots" },
  { value: "synapse", label: "Synapse" },
  { value: "rain", label: "Rain" },
  { value: "constellations", label: "Constellations" },
  { value: "perlin-flow", label: "Perlin Flow" },
  { value: "petals", label: "Petals" },
  { value: "sparkles", label: "Sparkles" },
  { value: "embers", label: "Embers" },
];

/** Default background pattern per built-in theme. */
export const THEME_DEFAULT_PATTERN: Record<string, BgPattern> = {
  "open-code-default": "perlin-flow",
  dark: "none",
  light: "dots",
  midnight: "rain",
  paper: "dots",
  cyberpunk: "synapse",
  retrowave: "embers",
  forest: "petals",
  ocean: "constellations",
  terminal: "perlin-flow",
  organs: "rain",
  ume: "petals",
  cute: "sparkles",
};

export const THEME_DEFAULT_EFFECT_COLOR: Record<string, string> = {
  midnight: "#ffffff",
  organs: "#451616",
  cute: "#ff8cb8",
  ume: "#f5a0c0",
};

export const THEME_DEFAULT_INTENSITY: Record<string, number> = {
  midnight: 0.5,
  terminal: 0.8,
  organs: 0.65,
};

export const THEME_DEFAULT_FROSTED: Record<string, boolean> = {
  lavender: true,
};

/** Options that ride alongside a saved palette. */
export interface ThemeOpts {
  font?: string;
  density?: string;
  bgPattern?: BgPattern;
  bgEffectColor?: string;
  bgEffectIntensity?: number;
  bgEffectSize?: number;
  frosted?: boolean;
}

export interface SavedTheme extends ThemeOpts {
  name: string;
  colors: Palette;
}

export type CustomThemeEntry = Palette & ThemeOpts;

// ── localStorage persistence ──
function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function getSaved(): SavedTheme | null {
  const obj = readJSON<SavedTheme | null>(LS_KEY, null);
  if (obj && (obj.name as string) === "chatgpt") obj.name = "gpt";
  if (obj && (obj.name as string) === "sakura") obj.name = "ume";
  return obj;
}

export function saveTheme(name: string, colors: Palette, opts?: ThemeOpts) {
  const obj: SavedTheme = { name, colors };
  if (opts) {
    if (opts.font && opts.font !== DEFAULT_FONT) obj.font = opts.font;
    if (opts.density && opts.density !== DEFAULT_DENSITY) obj.density = opts.density;
    if (opts.bgPattern && opts.bgPattern !== "none") obj.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) obj.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined && opts.bgEffectIntensity !== 1)
      obj.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined && opts.bgEffectSize !== 1)
      obj.bgEffectSize = opts.bgEffectSize;
    if (opts.frosted) obj.frosted = true;
  }
  writeJSON(LS_KEY, obj);
}

export function loadCustomThemes(): Record<string, CustomThemeEntry> {
  return readJSON<Record<string, CustomThemeEntry>>(CUSTOM_THEMES_KEY, {});
}

export function saveCustomTheme(
  name: string,
  colors: Palette,
  opts?: ThemeOpts,
): "ok" | "limit" {
  const ct = loadCustomThemes();
  if (!ct[name] && Object.keys(ct).length >= MAX_CUSTOM_THEMES) return "limit";
  const entry: CustomThemeEntry = { ...colors };
  if (opts) {
    if (opts.font) entry.font = opts.font;
    if (opts.density) entry.density = opts.density;
    if (opts.bgPattern) entry.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) entry.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined) entry.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined) entry.bgEffectSize = opts.bgEffectSize;
    if (opts.frosted !== undefined) entry.frosted = !!opts.frosted;
  }
  ct[name] = entry;
  writeJSON(CUSTOM_THEMES_KEY, ct);
  return "ok";
}

export function deleteCustomTheme(name: string) {
  const ct = loadCustomThemes();
  delete ct[name];
  writeJSON(CUSTOM_THEMES_KEY, ct);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
