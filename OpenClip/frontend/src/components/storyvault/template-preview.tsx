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

// One beat of the intro sequence. Omitting `phase` renders gameplay + captions
// only (the static mock used by the Presets pages); a `phase` shows exactly one
// intro beat so the Studio can cycle topic card → author intro → captions.
export type PreviewPhase = "topic" | "author" | "caption";

// The real story fields the Studio preview draws so the card / author intro
// match what the burned video shows (vs. the hardcoded sample below).
export interface PreviewStory {
  title: string;
  body?: string | null;
  author?: string | null;
  community?: string | null;
  upvotes?: number;
  num_comments?: number;
}

// Reddit handle on the card / author intro — mirrors overlays._handle_from:
// the post author, else a community-derived name, else a stable generic.
function deriveHandle(story?: PreviewStory | null): string {
  const a = (story?.author || "").trim().replace(/^u\//i, "").replace(/\//g, "").trim();
  if (a && !["deleted", "removed", "automoderator"].includes(a.toLowerCase())) return a;
  const c = (story?.community || "").trim().replace(/^r\//i, "").replace(/\//g, "").trim();
  if (c) return `${c.charAt(0).toUpperCase()}${c.slice(1).replace(/\s+/g, "")}Stories`;
  return "RedditStories";
}

// How many "UPDATE"/"EDIT" beats the body has — drives the red card line
// (mirrors overlays._count_updates).
function countUpdates(body?: string | null): number {
  if (!body) return 0;
  const m = body.match(/^\s*(?:edit|update)\s*(?:#?\s*\d+)?\s*[:-]/gim);
  return m ? m.length : 0;
}

// Compact engagement count (mirrors overlays._fmt_count).
function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n > 99) return "99+";
  return String(Math.max(0, n));
}

const AWARD_COLORS = ["#ffb428", "#ff8a4c", "#b478e8", "#5ac478", "#ec5c78"];

// A to-scale 9:16 mock of what THIS template renders: gameplay layer + (in the
// Studio) the Reddit topic card / author intro / body caption, every size,
// position and colour scaled from canvas px by k = previewWidth / canvasWidth.
// When a `story` is supplied the card/author intro use its real data; a `phase`
// isolates one intro beat. With neither prop only gameplay + captions render, so
// the Presets pages are unaffected.
export function PhonePreview({
  t,
  width = 252,
  story,
  phase,
}: {
  t: SvTemplateData;
  width?: number;
  story?: PreviewStory | null;
  phase?: PreviewPhase;
}) {
  const cv = t.canvas || {};
  const tc = t.topicCard || {};
  const cap = t.captions || {};
  const ai = t.authorIntro || {};
  const gp = t.gameplay || {};
  const safe = t.safe || {};
  const CW = cv.width || 1080;
  const CH = cv.height || 1920;
  const PW = width;
  const k = PW / CW;
  const PH = CH * k;
  const split = gp.mode === "split_bottom";

  // The card and author intro only appear in phase mode (the Studio cycle), so
  // callers that pass no `phase` (the Presets pages) keep rendering captions
  // only — exactly as before.
  const showTopic = phase === "topic" && tc.enabled !== false;
  const showAuthor = phase === "author" && ai.enabled !== false;
  const showCaption = (phase === undefined || phase === "caption") && cap.enabled !== false;

  // Card content: real story when given, else a representative sample.
  const handle = deriveHandle(story);
  const displayName = story ? (handle.length <= 22 ? handle : `${handle.slice(0, 21)}…`) : "Salty-Yeti-4489";
  const metaHandle = story ? `u/${handle}` : "u/Salty-Yeti-4489";
  const cardTitle = story?.title || "AITA for charging my family rent after they moved in?";
  const updates = story ? countUpdates(story.body) : 0;
  const likes = story ? fmtCount((story.upvotes ?? 0) || 990) : "99+";
  const comments = story ? fmtCount((story.num_comments ?? 0) || 99) : "99+";

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

  // ---- Stage 1: Reddit topic card ----
  if (showTopic) {
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
              {(displayName[0] || "R").toUpperCase()}
            </div>
          )}
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: px(6 * k) }}>
              <span style={{ fontWeight: 800, color: "#141414", fontSize: px(nameSize), whiteSpace: "nowrap" }}>{displayName}</span>
              <span style={{ width: px(20 * k), height: px(20 * k), borderRadius: "50%", background: "#1d96e8", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: px(13 * k), flex: "0 0 auto" }}>✓</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: px(4 * k), marginLeft: px(4 * k) }}>
                {AWARD_COLORS.map((c) => (
                  <span key={c} style={{ width: px(13 * k), height: px(13 * k), borderRadius: "50%", background: c, flex: "0 0 auto" }} />
                ))}
              </span>
            </div>
            <div style={{ color: "#777", fontSize: px(metaSize), marginTop: px(2 * k) }}>{metaHandle}</div>
          </div>
        </div>
        <div style={{ fontWeight: 800, color: "#141414", fontSize: px(titleSize), lineHeight: 1.16, marginBottom: px(updates > 0 ? 6 * k : 10 * k) }}>
          {cardTitle}
        </div>
        {updates > 0 && (
          <div style={{ fontWeight: 800, color: "#e0241b", fontSize: px(titleSize * 0.82), marginBottom: px(10 * k) }}>
            Plus {updates} {updates === 1 ? "update" : "updates"}.
          </div>
        )}
        <div style={{ fontSize: px(metaSize), color: "#777" }}>
          <span style={{ color: "#e02430", fontWeight: 700 }}>♥ </span>{likes}
          <span style={{ display: "inline-block", width: px(18 * k) }} />🗨 {comments}
        </div>
      </div>,
    );
  }

  // ---- Stage 2: author intro ("Posted by u/…") ----
  if (showAuthor) {
    const longest = Math.max("Posted by".length, metaHandle.length);
    const maxW = CW - 2 * 70;
    const aSize = Math.max(60, Math.min(Number(ai.maxSize) || 138, Math.round(maxW / (0.56 * longest)))) * k;
    layers.push(
      <div
        key="author"
        style={{
          position: "absolute", left: "50%", top: "46%", transform: "translate(-50%,-50%)",
          width: px((CW - 2 * (safe.side || 60)) * k), textAlign: "center",
          color: "#fff000", fontWeight: 800, fontFamily: "Arial,sans-serif",
          fontSize: px(aSize), lineHeight: 1.12, textShadow: outline((Number(ai.outline) || 9) * k, "#000"),
        }}
      >
        <div>Posted by</div>
        <div>{metaHandle}</div>
      </div>,
    );
  }

  // ---- Stage 3: body captions ----
  if (showCaption) {
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
