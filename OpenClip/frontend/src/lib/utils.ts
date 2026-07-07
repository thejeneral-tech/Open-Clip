import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Compact, human duration label for the duration picker and badges:
// "30s", "5m", "12m 50s", "1h 5m". Distinct from formatDuration's clock format.
export function formatDurationLabel(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

// Natural TTS narration pace at 1.0 speed (mirrors the backend's
// scripts.WORDS_PER_SECOND) — used to estimate how long a story narrates.
export const WORDS_PER_SECOND = 2.45;

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Rough spoken length of a story body, in seconds, at normal narration pace. */
export function estimateNarrationSeconds(text: string | null | undefined): number {
  return Math.round(countWords(text) / WORDS_PER_SECOND);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

// Words that should stay fully uppercase when prettifying a category slug.
const CATEGORY_ACRONYMS = new Set(["gta", "asmr", "pov", "fpv", "nba", "fifa"]);

/** Turn a category slug ("gta-ramps") into a display label ("GTA Ramps"). */
export function categoryLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => (CATEGORY_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function scoreColor(score: number): string {
  if (score >= 80) return "text-emerald-500";
  if (score >= 60) return "text-amber-500";
  if (score >= 40) return "text-orange-500";
  return "text-rose-500";
}

/** Format a dollar amount: "$1,234.56" (always two decimals). */
export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Compact count for stats: "1.2M", "87.8K", "950" (one decimal, ".0" trimmed). */
export function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  const compact = (value: number, suffix: string) =>
    `${value.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (abs >= 1_000_000_000) return compact(n / 1_000_000_000, "B");
  if (abs >= 1_000_000) return compact(n / 1_000_000, "M");
  if (abs >= 1_000) return compact(n / 1_000, "K");
  return `${Math.round(n)}`;
}
