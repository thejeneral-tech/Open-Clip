import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "OpenClip",
  description: "Self-hosted, local-AI clip studio.",
};

export const viewport: Viewport = {
  themeColor: "#1f231f",
};

/**
 * No-flash theme bootstrap — applies the saved palette (or the open-code
 * default theme) to <html> before first paint, so there's no flash of the
 * wrong theme. The full ThemeProvider then takes over on hydration.
 */
const BOOTSTRAP = `(function(){try{
  var raw = localStorage.getItem('openclip-theme');
  var DEFAULT = {bg:'#1f231f',fg:'#d5dcd6',panel:'#141514',border:'#404f41',red:'#65c26c'};
  var saved = raw ? JSON.parse(raw) : null;
  var c = (saved && saved.colors) ? saved.colors : DEFAULT;
  var s = document.documentElement.style;
  s.setProperty('--bg', c.bg); s.setProperty('--fg', c.fg);
  s.setProperty('--panel', c.panel); s.setProperty('--border', c.border);
  if (c.red) s.setProperty('--red', c.red);
  s.setProperty('--muted-fg', 'color-mix(in srgb, '+c.fg+' 58%, '+c.bg+')');
  s.setProperty('--hover-bg', 'color-mix(in srgb, '+c.fg+' 8%, '+c.bg+')');
  var FONTS = {mono:"'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace", sans:"system-ui, -apple-system, 'Segoe UI', sans-serif", serif:"Georgia, 'Times New Roman', serif"};
  if (saved && saved.font && FONTS[saved.font]) s.setProperty('--font-family', FONTS[saved.font]);
  var DEFP = {'open-code-default':'perlin-flow',light:'dots',midnight:'rain',paper:'dots',cyberpunk:'synapse',retrowave:'embers',forest:'petals',ocean:'constellations',terminal:'perlin-flow',organs:'rain',ume:'petals',cute:'sparkles'};
  var de = document.documentElement;
  if (saved && saved.density && saved.density !== 'comfortable') de.classList.add('density-' + saved.density);
  if (saved && saved.bgEffectColor) s.setProperty('--bg-effect-color', saved.bgEffectColor);
  if (saved && saved.bgEffectIntensity != null) s.setProperty('--bg-effect-intensity', String(saved.bgEffectIntensity));
  document.addEventListener('DOMContentLoaded', function(){
    var pat = (saved && saved.bgPattern) ? saved.bgPattern : (saved ? (DEFP[saved.name]||'none') : 'perlin-flow');
    if (pat && pat !== 'none') document.body.classList.add('bg-pattern-' + pat);
    if (!saved || saved.frosted !== false) document.body.classList.add('theme-frosted');
  });
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />
      </head>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
