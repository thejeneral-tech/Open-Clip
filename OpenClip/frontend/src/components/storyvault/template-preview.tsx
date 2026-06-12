import type { SvTemplateData } from "@/lib/types";

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

// Caption vertical placement, as % of frame height: centerY when set, else
// (canvasHeight − marginV).
export function posInfo(t: SvTemplateData) {
  const cap = t.captions || {};
  const CH = (t.canvas || {}).height || 1920;
  const y = cap.centerY || (CH - (cap.marginV || 520));
  const pct = Math.round((y / CH) * 100);
  return { y, pct, label: pct <= 52 ? `centered (${pct}%)` : `lower (${pct}%)` };
}

export const px = (n: number) => `${n}px`;

// 8-direction solid stroke approximating the ASS \bord outline.
export function outline(width: number, col = "#000"): string {
  const o = Math.max(1, Math.round(width));
  const s: string[] = [];
  for (const dx of [-o, 0, o]) for (const dy of [-o, 0, o]) if (dx || dy) s.push(`${dx}px ${dy}px 0 ${col}`);
  return s.join(",");
}

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
          position: "absolute", left: "50%", top: px(cy), transform: "translate(-50%,-50%)",
          width: px(cardW), boxSizing: "border-box", background: "#fff", color: "#141414",
          borderRadius: px((tc.radius || 46) * k), padding: `${px(30 * k)} ${px(40 * k)}`,
          boxShadow: "0 6px 18px rgba(0,0,0,.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: px(10 * k), marginBottom: px(10 * k) }}>
          {showAvatar && (
            <div style={{ width: px(avR * 2), height: px(avR * 2), borderRadius: "50%", background: "#3a95b3", color: "#fff", fontWeight: 800, fontSize: px(nameSize), display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>
              S
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: px(6 * k) }}>
              <span style={{ fontWeight: 800, color: "#141414", fontSize: px(nameSize), whiteSpace: "nowrap" }}>Salty-Yeti-4489</span>
              <span style={{ width: px(20 * k), height: px(20 * k), borderRadius: "50%", background: "#1d96e8", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: px(13 * k), flex: "0 0 auto" }}>✓</span>
            </div>
            <div style={{ color: "#777", fontSize: px(metaSize), marginTop: px(2 * k) }}>u/Salty-Yeti-4489</div>
          </div>
        </div>
        <div style={{ fontWeight: 800, color: "#141414", fontSize: px(titleSize), lineHeight: 1.16, marginBottom: px(10 * k) }}>
          AITA for charging my family rent after they moved in?
        </div>
        <div style={{ fontSize: px(metaSize), color: "#777" }}>
          <span style={{ color: "#e02430", fontWeight: 700 }}>♥ </span>99+
          <span style={{ display: "inline-block", width: px(18 * k) }} />🗨 99+
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
          position: "absolute", left: "50%", top: px(capY), transform: "translate(-50%,-50%)",
          width: px(maxW), textAlign: "center", color: primary, fontWeight: 800,
          fontFamily: fontStack, fontSize: px(fs), lineHeight: 1.1, textShadow: outline(ow, "#000"),
        }}
      >
        {children}
      </div>,
    );
  }

  return (
    <div
      style={{ position: "relative", width: px(PW), height: px(PH), margin: "0 auto", borderRadius: "14px", overflow: "hidden", background: "#0c121c" }}
    >
      {layers}
    </div>
  );
}
