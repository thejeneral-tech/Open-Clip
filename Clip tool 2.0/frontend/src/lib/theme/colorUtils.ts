/**
 * Color math ported from Odysseus' theme.js — HSL conversion, syntax-color
 * derivation, advanced per-zone defaults, and the color-harmony generator.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Palette {
  bg: string;
  fg: string;
  panel: string;
  border: string;
  red: string;
  advanced?: Partial<Record<AdvKey, string>>;
}

export function hexToRgb(hex: string): RGB | null {
  let h = (hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function hexToHSL(hex: string): [number, number, number] {
  const rgb = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

export interface SyntaxColors {
  bg: string;
  fg: string;
  keyword: string;
  string: string;
  comment: string;
  function: string;
  number: string;
  builtin: string;
  variable: string;
  params: string;
}

export function deriveSyntaxColors(colors: Palette): SyntaxColors {
  const [fgH, fgS, fgL] = hexToHSL(colors.fg);
  const [bgH, bgS, bgL] = hexToHSL(colors.bg);
  const [redH, redS] = hexToHSL(colors.red || "#e06c75");
  const isDark = bgL < 50;
  const codeBgL = isDark ? Math.max(bgL - 4, 0) : Math.min(bgL + 4, 100);
  return {
    bg: hslToHex(bgH, bgS, codeBgL),
    fg: colors.fg,
    keyword: hslToHex((redH + 280) % 360, Math.min(redS + 10, 80), isDark ? 70 : 45),
    string: hslToHex(40, Math.min(fgS + 20, 70), isDark ? 72 : 42),
    comment: hslToHex(fgH, Math.max(fgS - 20, 5), fgL * 0.5 + bgL * 0.5),
    function: hslToHex(210, Math.min(fgS + 20, 75), isDark ? 70 : 45),
    number: hslToHex(20, Math.min(fgS + 15, 65), isDark ? 68 : 48),
    builtin: hslToHex(180, Math.min(fgS + 15, 60), isDark ? 65 : 40),
    variable: hslToHex((fgH + 30) % 360, Math.min(fgS + 5, 60), fgL),
    params: hslToHex(fgH, Math.max(fgS - 5, 10), isDark ? Math.min(fgL + 8, 85) : Math.max(fgL - 8, 25)),
  };
}

export type AdvKey =
  | "userBubbleBg"
  | "aiBubbleBg"
  | "bubbleBorder"
  | "sidebarBg"
  | "brandColor"
  | "hamburgerColor"
  | "inputBg"
  | "inputBorder"
  | "sendBtnBg"
  | "sendBtnHover"
  | "codeBg"
  | "codeFg"
  | "toggleActive";

export const ADV_KEYS: { key: AdvKey; css: string; label: string; group: string }[] = [
  { key: "userBubbleBg", css: "--user-bubble-bg", label: "Card / Tile", group: "Surfaces" },
  { key: "aiBubbleBg", css: "--ai-bubble-bg", label: "Raised Surface", group: "Surfaces" },
  { key: "bubbleBorder", css: "--bubble-border", label: "Card Border", group: "Surfaces" },
  { key: "sidebarBg", css: "--sidebar-bg", label: "Sidebar Bg", group: "Sidebar" },
  { key: "brandColor", css: "--brand-color", label: "Brand / Logo", group: "Sidebar" },
  { key: "hamburgerColor", css: "--hamburger-color", label: "Icon Color", group: "Sidebar" },
  { key: "inputBg", css: "--input-bg", label: "Input Bg", group: "Inputs" },
  { key: "inputBorder", css: "--input-border", label: "Input Border", group: "Inputs" },
  { key: "sendBtnBg", css: "--send-btn-bg", label: "Primary Button", group: "Controls" },
  { key: "sendBtnHover", css: "--send-btn-hover", label: "Button Hover", group: "Controls" },
  { key: "codeBg", css: "--code-bg", label: "Code Bg", group: "Code" },
  { key: "codeFg", css: "--code-fg", label: "Code Text", group: "Code" },
  { key: "toggleActive", css: "--toggle-active", label: "Toggle On", group: "Controls" },
];

export function computeAdvancedDefaults(colors: Palette): Record<AdvKey, string> {
  const syn = deriveSyntaxColors(colors);
  const red = colors.red || "#e06c75";
  return {
    userBubbleBg: colors.bg,
    aiBubbleBg: colors.panel,
    bubbleBorder: colors.border,
    sidebarBg: colors.panel,
    brandColor: red,
    hamburgerColor: colors.fg,
    inputBg: colors.panel,
    inputBorder: colors.border,
    sendBtnBg: red,
    sendBtnHover: red,
    codeBg: syn.bg,
    codeFg: syn.fg,
    toggleActive: red,
  };
}

export type HarmonyType = "complementary" | "analogous" | "triadic" | "monochromatic";

export function generateHarmonyColors(
  accentHex: string,
  harmonyType: HarmonyType,
  mode: "dark" | "light",
): Palette {
  const [h, s] = hexToHSL(accentHex);
  const isDark = mode === "dark";

  let bgH: number, bgS: number, bgL: number, fgS: number, fgL: number;
  let panelL: number, borderH: number, borderS: number, borderL: number;

  if (harmonyType === "complementary") {
    bgH = h; bgS = Math.max(s * 0.15, 3);
    bgL = isDark ? 13 : 95; fgL = isDark ? 85 : 15; fgS = Math.max(s * 0.2, 5);
    panelL = isDark ? 8 : 98;
    borderH = h; borderS = Math.max(s * 0.25, 8); borderL = isDark ? 28 : 75;
  } else if (harmonyType === "analogous") {
    bgH = (h - 30 + 360) % 360; bgS = Math.max(s * 0.12, 3);
    bgL = isDark ? 14 : 95; fgL = isDark ? 84 : 18; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 9 : 97;
    borderH = (h + 30) % 360; borderS = Math.max(s * 0.3, 10); borderL = isDark ? 30 : 72;
  } else if (harmonyType === "triadic") {
    bgH = (h + 240) % 360; bgS = Math.max(s * 0.1, 2);
    bgL = isDark ? 13 : 96; fgL = isDark ? 86 : 14; fgS = Math.max(s * 0.18, 5);
    panelL = isDark ? 8 : 99;
    borderH = (h + 120) % 360; borderS = Math.max(s * 0.2, 8); borderL = isDark ? 28 : 74;
  } else {
    bgH = h; bgS = Math.max(s * 0.08, 2);
    bgL = isDark ? 12 : 96; fgL = isDark ? 87 : 13; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 7 : 99;
    borderH = h; borderS = Math.max(s * 0.2, 6); borderL = isDark ? 26 : 76;
  }

  return {
    bg: hslToHex(bgH, bgS, bgL),
    fg: hslToHex(h, fgS, fgL),
    panel: hslToHex(bgH, bgS * 0.6, panelL),
    border: hslToHex(borderH, borderS, borderL),
    red: accentHex,
  };
}

/** Pick a readable foreground (black/white) for a given background hex. */
export function contrastColor(hex: string): string {
  const rgb = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}
