import type { Config } from "tailwindcss";

/**
 * OpenClip uses the Odysseus theme model: a small set of CSS custom properties
 * (`--bg`, `--fg`, `--panel`, `--border`, `--red`) that the theme engine swaps
 * at runtime. Tailwind color utilities map straight onto those vars so the
 * whole UI re-themes instantly, including custom + animated-background themes.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        // ── Odysseus core palette (runtime-swapped CSS vars) ──
        bg: "var(--bg)",
        fg: "var(--fg)",
        panel: "var(--panel)",
        sidebar: "var(--sidebar-bg)",
        brand: "var(--brand-color)",
        "input-border": "var(--input-border)",
        code: {
          bg: "var(--code-bg)",
          fg: "var(--code-fg)",
        },

        // ── shadcn-compatible aliases, mapped onto the Odysseus palette ──
        // The restored dashboard components use these tokens (bg-card, bg-primary,
        // text-muted-foreground …); pointing them at the Odysseus vars lets the
        // whole old UI re-theme at runtime with the theme engine.
        border: "var(--border)",
        input: "var(--input-border)",
        ring: "var(--red)",
        background: "var(--bg)",
        foreground: "var(--fg)",
        primary: { DEFAULT: "var(--red)", foreground: "var(--accent-contrast)" },
        secondary: { DEFAULT: "var(--hover-bg)", foreground: "var(--fg)" },
        destructive: { DEFAULT: "var(--red)", foreground: "var(--accent-contrast)" },
        // `muted` keeps the Odysseus meaning for `text-muted` (DEFAULT) while also
        // serving shadcn's `text-muted-foreground`.
        muted: { DEFAULT: "var(--muted-fg)", foreground: "var(--muted-fg)" },
        // shadcn `accent` is a subtle hover surface (not the Odysseus red action).
        accent: { DEFAULT: "var(--hover-bg)", foreground: "var(--fg)" },
        popover: { DEFAULT: "var(--panel)", foreground: "var(--fg)" },
        card: { DEFAULT: "var(--panel)", foreground: "var(--fg)" },
      },
      fontFamily: {
        theme: "var(--font-family)",
        mono: "var(--font-family)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "translateY(6px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.18s ease-out",
        "pop-in": "pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
