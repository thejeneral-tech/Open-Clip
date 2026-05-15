import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Loop,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
  interpolate,
  Easing,
} from 'remotion';

export interface WordTiming {
  word: string;
  startFrame: number;
  endFrame: number;
}

export interface ScriptLine {
  text: string;
  startFrame: number;
  endFrame: number;
  type: 'hook' | 'observation' | 'escalation' | 'truth' | 'twist' | 'ending';
  // Optional per-word frame timings produced by AssemblyAI forced alignment.
  // When present, captions reveal word-by-word in lockstep with the voice.
  words?: WordTiming[];
}

export interface ZodiacVideoProps {
  backgroundVideo: string;
  backgroundBlur: number;
  backgroundBrightness: number;
  grainIntensity: number;
  grainType: 'film' | 'digital' | 'vhs' | 'none';
  fogOverlay: boolean;
  rainOverlay: boolean;
  slowZoom: boolean;
  colorGrade: 'none' | 'dark' | 'blue' | 'warm' | 'purple' | 'teal' | 'crimson' | 'mono' | 'analog' | 'nightmare' | 'liminal' | 'bloom' | 'sepia' | 'invert' | 'cyber' | 'neon' | 'faded' | 'vintage' | 'dreamy' | 'sunset' | 'forest' | 'lavender' | 'cold' | 'heat' | 'toxic' | 'bleach' | 'frost' | 'cherry' | 'emerald' | 'obsidian' | 'peach' | 'ash' | 'dusk' | 'ember';
  colorGradeIntensity?: number; // 0-100, default 100 (full effect)
  // Tone adjustments (composed on top of the colorGrade filter)
  saturation?: number;  // 50-200, default 100  (100 = no change)
  contrast?: number;    // 50-200, default 100  (100 = no change)
  exposure?: number;    // -100..100, default 0 (maps to brightness 0.5..1.5)
  highlights?: number;  // -100..100, default 0 (overlay-based lift/crush)
  shadows?: number;     // -100..100, default 0 (overlay-based lift/crush)
  captionTopPct?: number | null; // 0-100, % from top; null = centered
  vignette: boolean;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  textAnimation: 'fade' | 'slide-up' | 'typewriter' | 'scale' | 'glow' | 'blur-in' | 'fade-typewriter' | 'word-drop' | 'rise' | 'bounce' | 'shimmer' | 'cascade' | 'dissolve' | 'flicker' | 'glitch-in';
  animSpeed: number; // 0.25 – 4.0, default 1.0
  zodiacSign: string;
  zodiacSymbol: string;
  scriptLines: ScriptLine[];
  durationInSeconds: number;
  audioFile?: string;
  musicFile?: string;
  musicVolume: number;
  captionBgStyle?: 'none' | 'white' | 'dark' | 'yellow';
  captionRotate?: number;
  // Voice volume (0..1) — defaults to 1.0. Surfaced as a prop so the UI's
  // "voice volume" control flows all the way into the render the same way
  // music volume does.
  voiceVolume?: number;
  // Background clip duration in frames, measured via ffprobe in
  // scripts/zodiac-render.ts. When > 0, the background OffthreadVideo is
  // wrapped in <Loop> so it repeats cleanly across the whole composition.
  // 0/undefined = play once and freeze on last frame.
  backgroundDurationFrames?: number;
}

// ─── Color grade filters ──────────────────────────────────────────────────────
// Each grade lists its FULLY-APPLIED filter values. The intensity slider lerps
// from the neutral default (1 for brightness/contrast/saturate, 0 for sepia/
// invert/hue-rotate) toward these targets — so intensity 0 = original video,
// intensity 100 = full effect.

type GradeFilter = {
  brightness?: number; contrast?: number; saturate?: number;
  sepia?: number;     invert?: number;   hueRotate?: number;
};

const GRADE_FILTERS: Record<ZodiacVideoProps['colorGrade'], GradeFilter> = {
  none:      {},
  dark:      { brightness:0.65, contrast:1.15, saturate:0.85 },
  blue:      { brightness:0.75, saturate:0.6,  hueRotate:200, contrast:1.1 },
  warm:      { brightness:0.85, sepia:0.35,    saturate:1.25 },
  purple:    { brightness:0.7,  hueRotate:270, saturate:0.7, contrast:1.1 },
  teal:      { brightness:0.8,  hueRotate:155, saturate:0.75, contrast:1.05 },
  crimson:   { brightness:0.72, hueRotate:345, saturate:1.4, contrast:1.15 },
  mono:      { brightness:0.7,  saturate:0,    contrast:1.2 },
  analog:    { saturate:0,      contrast:1.45, brightness:0.58 },
  nightmare: { saturate:0,      contrast:1.75, brightness:0.42 },
  liminal:   { saturate:0.22,   hueRotate:188, contrast:1.15, brightness:0.68 },
  bloom:     { brightness:1.08, saturate:1.18, contrast:0.92 },
  // New grades
  sepia:     { sepia:1,         saturate:1.3,  brightness:0.95 },
  invert:    { invert:1,        hueRotate:180 },
  cyber:     { saturate:2,      hueRotate:280, contrast:1.3,  brightness:0.9 },
  neon:      { saturate:2.2,    contrast:1.3,  brightness:1.05 },
  faded:     { saturate:0.55,   contrast:0.85, brightness:1.1 },
  vintage:   { sepia:0.55,      saturate:0.7,  contrast:0.92, brightness:0.95 },
  dreamy:    { brightness:1.15, saturate:0.85, contrast:0.88 },
  sunset:    { hueRotate:340,   saturate:1.4,  brightness:0.95, contrast:1.05 },
  forest:    { hueRotate:80,    saturate:0.85, brightness:0.75, contrast:1.05 },
  lavender:  { hueRotate:300,   saturate:0.7,  brightness:1.0,  contrast:0.95 },
  cold:      { hueRotate:200,   saturate:0.7,  brightness:0.85, contrast:1.05 },
  heat:      { hueRotate:5,     saturate:1.5,  brightness:0.95, contrast:1.1 },
  toxic:     { hueRotate:75,    saturate:1.6,  brightness:0.85, contrast:1.15 },
  bleach:    { saturate:0.3,    contrast:1.4,  brightness:1.0 },
  frost:     { hueRotate:185,   saturate:0.4,  brightness:1.05, contrast:1.0 },
  cherry:    { hueRotate:340,   saturate:1.6,  brightness:0.85, contrast:1.15 },
  emerald:   { hueRotate:120,   saturate:1.2,  brightness:0.7,  contrast:1.15 },
  obsidian:  { saturate:0.3,    brightness:0.45, contrast:1.5,  hueRotate:215 },
  peach:     { hueRotate:355,   saturate:0.85, brightness:1.05, sepia:0.2 },
  ash:       { saturate:0.15,   brightness:0.85, contrast:1.05 },
  dusk:      { hueRotate:215,   saturate:0.95, brightness:0.7,  contrast:1.15 },
  ember:     { hueRotate:15,    saturate:1.3,  brightness:0.55, contrast:1.25 },
};

// Compose extra tone adjustments (Saturation/Contrast/Exposure) into a CSS
// filter string that multiplies on top of the grade filter.
function buildAdjustmentFilter(adj: {
  saturation?: number; contrast?: number; exposure?: number;
}): string {
  const parts: string[] = [];
  const sat = adj.saturation ?? 100;
  const con = adj.contrast   ?? 100;
  const exp = adj.exposure   ?? 0;
  if (sat !== 100) parts.push(`saturate(${(sat / 100).toFixed(3)})`);
  if (con !== 100) parts.push(`contrast(${(con / 100).toFixed(3)})`);
  // Exposure -100..+100 → brightness 0.5..1.5
  if (exp !== 0)   parts.push(`brightness(${(1 + exp / 200).toFixed(3)})`);
  return parts.join(' ');
}

function getColorGradeFilter(
  grade: ZodiacVideoProps['colorGrade'],
  intensity: number = 100
): string {
  const t = Math.max(0, Math.min(100, intensity)) / 100;
  if (t === 0) return 'brightness(1)';
  const lerp = (def: number, target: number) => def + (target - def) * t;
  const f = GRADE_FILTERS[grade] || {};
  const parts: string[] = [];
  if (f.brightness !== undefined) parts.push(`brightness(${lerp(1, f.brightness).toFixed(3)})`);
  if (f.contrast   !== undefined) parts.push(`contrast(${lerp(1, f.contrast).toFixed(3)})`);
  if (f.saturate   !== undefined) parts.push(`saturate(${lerp(1, f.saturate).toFixed(3)})`);
  if (f.sepia      !== undefined) parts.push(`sepia(${lerp(0, f.sepia).toFixed(3)})`);
  if (f.invert     !== undefined) parts.push(`invert(${lerp(0, f.invert).toFixed(3)})`);
  if (f.hueRotate  !== undefined) parts.push(`hue-rotate(${lerp(0, f.hueRotate).toFixed(1)}deg)`);
  return parts.join(' ') || 'brightness(1)';
}

// ─── Grain overlay ────────────────────────────────────────────────────────────

const GrainOverlay: React.FC<{ intensity: number; type: ZodiacVideoProps['grainType'] }> = ({
  intensity,
  type,
}) => {
  const frame = useCurrentFrame();
  if (type === 'none' || intensity === 0) return null;

  // Unique SVG noise per frame (seed changes each frame for animated grain)
  const seed = (frame * 1337) % 9999;
  const freq = type === 'film' ? 0.65 : type === 'digital' ? 0.9 : 0.4;
  const numOctaves = type === 'vhs' ? 1 : 3;
  const opacity = (intensity / 100) * (type === 'film' ? 0.35 : type === 'vhs' ? 0.5 : 0.28);

  const svgString = `<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${numOctaves}' seed='${seed}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='1'/></svg>`;
  const url = `data:image/svg+xml,${svgString}`;

  const blendMode = type === 'vhs' ? 'screen' : 'overlay';

  return (
    <AbsoluteFill
      style={{
        backgroundImage: `url("${url}")`,
        backgroundSize: 'cover',
        opacity,
        mixBlendMode: blendMode as React.CSSProperties['mixBlendMode'],
        pointerEvents: 'none',
      }}
    />
  );
};

// ─── Fog overlay ──────────────────────────────────────────────────────────────

const FogOverlay: React.FC<{ frame: number }> = ({ frame }) => {
  const phase = (frame % 90) / 90;
  const opacity = 0.12 + Math.sin(phase * Math.PI * 2) * 0.06;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 110%, rgba(140,120,180,${opacity}) 0%, transparent 65%),
                     radial-gradient(ellipse at 20% 90%, rgba(100,100,160,${opacity * 0.7}) 0%, transparent 50%)`,
        pointerEvents: 'none',
      }}
    />
  );
};

// ─── Rain lines ───────────────────────────────────────────────────────────────

const RainOverlay: React.FC<{ frame: number }> = ({ frame }) => {
  const rainLines = Array.from({ length: 40 }, (_, i) => {
    const x = ((i * 73 + frame * 3) % 1100) - 10;
    const y = ((frame * 8 + i * 137) % 2200) - 200;
    return { x, y };
  });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', overflow: 'hidden' }}>
      <svg width="1080" height="1920" style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        {rainLines.map((line, i) => (
          <line
            key={i}
            x1={line.x}
            y1={line.y}
            x2={line.x - 4}
            y2={line.y + 24}
            stroke="rgba(180,200,255,0.9)"
            strokeWidth="1"
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};

// ─── VHS scanlines (for vhs grain type) ──────────────────────────────────────

const ScanLines: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.06) 2px, rgba(0,0,0,0.06) 4px)',
      pointerEvents: 'none',
    }}
  />
);

// ─── Vignette ─────────────────────────────────────────────────────────────────

const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background: 'radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(0,0,0,0.72) 100%)',
      pointerEvents: 'none',
    }}
  />
);

// ─── Highlights / Shadows overlay ────────────────────────────────────────────
// CSS filters can't do real luminance-targeted curves, so we approximate
// the lift/crush of highlights and shadows with blend-mode overlays.
//   highlights > 0 → lift bright areas via screen-blend white
//   highlights < 0 → crush bright areas via multiply-blend grey
//   shadows    > 0 → lift dark areas via screen-blend mid-grey
//   shadows    < 0 → crush dark areas via multiply-blend black

const ToneOverlay: React.FC<{ highlights: number; shadows: number }> = ({
  highlights, shadows,
}) => {
  const layers: React.ReactElement[] = [];

  if (highlights !== 0) {
    const a = Math.min(0.45, Math.abs(highlights) / 100 * 0.4);
    layers.push(
      <AbsoluteFill
        key="hl"
        style={{
          background: highlights > 0 ? 'rgba(255,255,255,1)' : 'rgba(40,40,40,1)',
          mixBlendMode: highlights > 0 ? 'screen' : 'multiply',
          opacity: a,
          pointerEvents: 'none',
        }}
      />
    );
  }

  if (shadows !== 0) {
    const a = Math.min(0.45, Math.abs(shadows) / 100 * 0.4);
    layers.push(
      <AbsoluteFill
        key="sh"
        style={{
          background: shadows > 0 ? 'rgba(120,120,120,1)' : 'rgba(0,0,0,1)',
          mixBlendMode: shadows > 0 ? 'screen' : 'multiply',
          opacity: a,
          pointerEvents: 'none',
        }}
      />
    );
  }

  return layers.length ? <>{layers}</> : null;
};


// ─── Single script line renderer ──────────────────────────────────────────────

const ScriptLineComp: React.FC<{
  line: ScriptLine;
  frame: number;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  textAnimation: ZodiacVideoProps['textAnimation'];
  animSpeed: number;
  captionTopPct?: number | null;
  captionBgStyle?: string;
  captionRotate?: number;
}> = ({ line, frame, fontFamily, fontSize, textColor, textAnimation, animSpeed, captionTopPct, captionBgStyle, captionRotate }) => {
  const localFrame = frame - line.startFrame;
  const lineDuration = line.endFrame - line.startFrame;
  const spd = animSpeed ?? 1;

  // Force black text when a light background box is applied
  const effectiveTextColor =
    captionBgStyle === 'white' || captionBgStyle === 'yellow' ? '#000000' : textColor;

  // Background-box style merged into every <p> via extraStyle
  const bgExtraStyle: React.CSSProperties =
    captionBgStyle === 'white'  ? { backgroundColor: 'rgba(255,255,255,0.95)', padding: '8px 16px', borderRadius: '8px', textShadow: 'none' } :
    captionBgStyle === 'dark'   ? { backgroundColor: 'rgba(0,0,0,0.72)',       padding: '8px 16px', borderRadius: '8px' } :
    captionBgStyle === 'yellow' ? { backgroundColor: '#ffe500',                padding: '8px 16px', borderRadius: '8px', textShadow: 'none' } :
    {};

  // Outer caption-positioning style — when captionTopPct is set the user
  // dragged the caption to a specific Y in the preview, so position it
  // there in the render too. Otherwise use the original centered layout.
  const rotateStyle: React.CSSProperties = captionRotate ? { transform: `rotate(${captionRotate}deg)` } : {};
  const containerCss: React.CSSProperties = captionTopPct != null
    ? { position: 'absolute', top: `${captionTopPct}%`, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '0 72px', ...rotateStyle }
    : { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 72px', ...rotateStyle };

  // Fade-in / fade-out windows scale inversely with speed (faster anim = fewer frames)
  const FADE_IN  = Math.round(10 / spd);
  const FADE_OUT = 8;

  if (frame < line.startFrame || frame > line.endFrame) return null;

  // ── Word-by-word reveal (uses AssemblyAI forced-alignment timestamps) ──
  // When the line carries `words` with real frame timings, we render each
  // word as a span that becomes visible *exactly when the speaker says it*.
  // This is the key to "captions match the voice perfectly".
  if (line.words && line.words.length > 0) {
    const fadeOutOp = interpolate(
      localFrame,
      [lineDuration - FADE_OUT, lineDuration],
      [1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    const wordSpans = line.words.map((w, i) => {
      const visible = frame >= w.startFrame;
      // Brief fade-in (3 frames) right at the word's start frame for polish
      const wordOp = interpolate(
        frame,
        [w.startFrame, w.startFrame + 3],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      return (
        <span key={i} style={{
          opacity: visible ? wordOp : 0,
          marginRight: i < line.words!.length - 1 ? '0.28em' : 0,
          display: 'inline-block',
        }}>{w.word}</span>
      );
    });
    return (
      <div style={{ ...containerCss, opacity: fadeOutOp }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, bgExtraStyle)}>{wordSpans}</p>
      </div>
    );
  }

  const opacity = interpolate(
    localFrame,
    [0, FADE_IN, lineDuration - FADE_OUT, lineDuration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  let transform = 'none';
  let filter = 'none';
  let extraStyle: React.CSSProperties = { ...bgExtraStyle };

  if (textAnimation === 'slide-up') {
    const y = interpolate(localFrame, [0, FADE_IN], [28, 0], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
    transform = `translateY(${y}px)`;

  } else if (textAnimation === 'scale') {
    const s = interpolate(localFrame, [0, FADE_IN], [0.88, 1], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.back(1.4)),
    });
    transform = `scale(${s})`;

  } else if (textAnimation === 'bounce') {
    const s = interpolate(localFrame, [0, FADE_IN], [0.7, 1], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.back(2.8)),
    });
    transform = `scale(${s})`;

  } else if (textAnimation === 'rise') {
    const riseEnd = Math.round(28 / spd);
    const y = interpolate(localFrame, [0, riseEnd], [48, 0], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.quad),
    });
    transform = `translateY(${y}px)`;

  } else if (textAnimation === 'glow') {
    const glowOpacity = interpolate(
      localFrame,
      [0, FADE_IN, lineDuration / 2, lineDuration - FADE_OUT, lineDuration],
      [0, 0.7, 1, 0.7, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    extraStyle = {
      ...bgExtraStyle,
      textShadow: `0 0 ${20 * glowOpacity}px ${effectiveTextColor}, 0 0 ${40 * glowOpacity}px ${effectiveTextColor}`,
    };

  } else if (textAnimation === 'blur-in') {
    const blurPx = interpolate(localFrame, [0, FADE_IN], [8, 0], {
      extrapolateRight: 'clamp',
    });
    filter = `blur(${blurPx}px)`;

  } else if (textAnimation === 'typewriter') {
    const revealEnd = Math.round((lineDuration * 0.7) / spd);
    const charsToShow = Math.floor(
      interpolate(localFrame, [0, revealEnd], [0, line.text.length], {
        extrapolateRight: 'clamp',
      })
    );
    const visibleText = line.text.slice(0, charsToShow);
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>
          {visibleText}
          <span style={{ opacity: localFrame % 16 < 8 ? 1 : 0 }}>|</span>
        </p>
      </div>
    );

  } else if (textAnimation === 'fade-typewriter') {
    // Each character fades in individually, staggered across the reveal window
    const revealEnd = Math.round((lineDuration * 0.65) / spd);
    const chars = line.text.split('');
    const charFadeDur = Math.max(4, Math.round(8 / spd));
    const charSpans = chars.map((ch, i) => {
      const charStart = (i / Math.max(chars.length - 1, 1)) * revealEnd;
      const charOp = interpolate(
        localFrame,
        [charStart, charStart + charFadeDur],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      return (
        <span key={i} style={{ opacity: charOp }}>{ch}</span>
      );
    });
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>
          {charSpans}
        </p>
      </div>
    );

  } else if (textAnimation === 'word-drop') {
    // Each word drops in from above, staggered
    const words = line.text.split(' ');
    const revealEnd = Math.round((lineDuration * 0.6) / spd);
    const wordFadeDur = Math.max(5, Math.round(10 / spd));
    const wordSpans = words.map((word, i) => {
      const wordStart = (i / Math.max(words.length - 1, 1)) * revealEnd;
      const wordOp = interpolate(
        localFrame,
        [wordStart, wordStart + wordFadeDur],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      const wordY = interpolate(
        localFrame,
        [wordStart, wordStart + wordFadeDur],
        [-22, 0],
        {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        }
      );
      return (
        <span
          key={i}
          style={{
            opacity: wordOp,
            transform: `translateY(${wordY}px)`,
            display: 'inline-block',
            marginRight: i < words.length - 1 ? '0.28em' : 0,
          }}
        >
          {word}
        </span>
      );
    });
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>
          {wordSpans}
        </p>
      </div>
    );

  } else if (textAnimation === 'shimmer') {
    // Per-char staggered fade with a brightness flash at each reveal moment
    const revealEnd = Math.round((lineDuration * 0.65) / spd);
    const chars = line.text.split('');
    const charFadeDur = Math.max(4, Math.round(10 / spd));
    const charSpans = chars.map((ch, i) => {
      const charStart = (i / Math.max(chars.length - 1, 1)) * revealEnd;
      const charOp = interpolate(
        localFrame,
        [charStart, charStart + charFadeDur],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      const peak = charStart + charFadeDur * 0.4;
      const bri = localFrame < charStart
        ? 1
        : interpolate(
            localFrame,
            [charStart, peak, charStart + charFadeDur * 2.5],
            [2.8, 1.8, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          );
      return (
        <span key={i} style={{ opacity: charOp, filter: `brightness(${bri})` }}>
          {ch}
        </span>
      );
    });
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>{charSpans}</p>
      </div>
    );

  } else if (textAnimation === 'cascade') {
    // Per-char drops from above, staggered left-to-right
    const revealEnd = Math.round((lineDuration * 0.6) / spd);
    const chars = line.text.split('');
    const charFadeDur = Math.max(5, Math.round(14 / spd));
    const charSpans = chars.map((ch, i) => {
      const charStart = (i / Math.max(chars.length - 1, 1)) * revealEnd;
      const charOp = interpolate(
        localFrame,
        [charStart, charStart + charFadeDur],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      const charY = interpolate(
        localFrame,
        [charStart, charStart + charFadeDur],
        [-32, 0],
        {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          easing: Easing.out(Easing.back(1.4)),
        }
      );
      return (
        <span key={i} style={{ opacity: charOp, transform: `translateY(${charY}px)`, display: 'inline-block' }}>
          {ch}
        </span>
      );
    });
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>{charSpans}</p>
      </div>
    );

  } else if (textAnimation === 'dissolve') {
    // Chars fade in a random (but deterministic) order
    const revealEnd = Math.round((lineDuration * 0.7) / spd);
    const chars = line.text.split('');
    const n = chars.length;
    const seed0 = line.text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 17);
    const shuffled = chars.map((_, i) => ({ i, r: ((seed0 + i * 1664525 + 1013904223) * (i + 3)) & 0x7fffffff }))
      .sort((a, b) => a.r - b.r);
    const revealOrder = new Array(n);
    shuffled.forEach(({ i }, pos) => { revealOrder[i] = pos; });
    const charFadeDur = Math.max(4, Math.round(10 / spd));
    const charSpans = chars.map((ch, i) => {
      const charStart = n <= 1 ? 0 : (revealOrder[i] / (n - 1)) * revealEnd;
      const charOp = interpolate(
        localFrame,
        [charStart, charStart + charFadeDur],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      return <span key={i} style={{ opacity: charOp }}>{ch}</span>;
    });
    return (
      <div style={{ ...containerCss, opacity }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>{charSpans}</p>
      </div>
    );

  } else if (textAnimation === 'flicker') {
    // CRT-style flicker burst then settle into a solid hold
    const flickerDur = Math.round(22 / spd);
    let flickerOp: number;
    if (localFrame < flickerDur) {
      const cycle = Math.max(1, Math.round(3 / spd));
      const phase = Math.floor(localFrame / cycle);
      const progress = localFrame / flickerDur;
      flickerOp = phase % 2 === 0 ? 0 : 0.55 + progress * 0.4;
    } else {
      flickerOp = interpolate(
        localFrame,
        [flickerDur, flickerDur + FADE_IN],
        [0.85, 1],
        { extrapolateRight: 'clamp' }
      );
    }
    const fadeOutOp = interpolate(
      localFrame,
      [lineDuration - FADE_OUT, lineDuration],
      [1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return (
      <div style={{ ...containerCss, opacity: Math.min(flickerOp, fadeOutOp) }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>{line.text}</p>
      </div>
    );

  } else if (textAnimation === 'glitch-in') {
    // Horizontal glitch bursts that dampen and snap to center
    const glitchDur = Math.round(16 / spd);
    const glitchPattern = [24, -20, 16, -12, 9, -6, 4, -3, 2, -1, 0];
    let glitchX = 0;
    if (localFrame < glitchDur) {
      const idx = Math.min(
        glitchPattern.length - 1,
        Math.floor((localFrame / glitchDur) * glitchPattern.length)
      );
      glitchX = glitchPattern[idx];
    }
    const glitchOp = localFrame < glitchDur
      ? interpolate(localFrame, [0, Math.round(4 / spd)], [0.2, 0.9], { extrapolateRight: 'clamp' })
      : opacity;
    const fadeOutOp = interpolate(
      localFrame,
      [lineDuration - FADE_OUT, lineDuration],
      [1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return (
      <div style={{
        ...containerCss,
        opacity: Math.min(glitchOp, fadeOutOp),
        transform: `translateX(${glitchX}px)`,
      }}>
        <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>{line.text}</p>
      </div>
    );
  }

  return (
    <div
      style={{
        ...containerCss,
        opacity,
        transform,
        filter,
      }}
    >
      <p style={getTextStyle(line.type, fontFamily, fontSize, effectiveTextColor, extraStyle)}>
        {line.text}
      </p>
    </div>
  );
};

function getTextStyle(
  type: ScriptLine['type'],
  fontFamily: string,
  baseFontSize: number,
  textColor: string,
  extra: React.CSSProperties = {}
): React.CSSProperties {
  const sizeMultiplier = type === 'hook' ? 1.15 : type === 'ending' ? 1.05 : 1;
  const weight = type === 'hook' || type === 'twist' ? 900 : 700;

  return {
    fontFamily,
    fontSize: baseFontSize * sizeMultiplier,
    fontWeight: weight,
    color: textColor,
    textAlign: 'center',
    lineHeight: 1.3,
    letterSpacing: type === 'hook' ? 1 : 0.5,
    textShadow: '2px 2px 0 rgba(0,0,0,0.9), -2px -2px 0 rgba(0,0,0,0.9), 2px -2px 0 rgba(0,0,0,0.9), -2px 2px 0 rgba(0,0,0,0.9), 0 4px 18px rgba(0,0,0,0.95)',
    margin: 0,
    padding: 0,
    maxWidth: '100%',
    ...extra,
  };
}

// ─── Progress bar (bottom) ────────────────────────────────────────────────────

const ProgressBar: React.FC<{ frame: number; totalFrames: number }> = ({ frame, totalFrames }) => {
  const progress = frame / totalFrames;
  return (
    <div style={{
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 3,
      background: 'rgba(255,255,255,0.08)',
    }}>
      <div style={{
        height: '100%',
        width: `${progress * 100}%`,
        background: 'rgba(255,255,255,0.35)',
        transition: 'none',
      }} />
    </div>
  );
};

// ─── Main composition ─────────────────────────────────────────────────────────

export const ZodiacVideo: React.FC<ZodiacVideoProps> = (props) => {
  const {
    backgroundVideo,
    backgroundBlur,
    backgroundBrightness,
    grainIntensity,
    grainType,
    fogOverlay,
    rainOverlay,
    slowZoom,
    colorGrade,
    colorGradeIntensity,
    saturation,
    contrast,
    exposure,
    highlights,
    shadows,
    captionTopPct,
    vignette,
    fontFamily,
    fontSize,
    textColor,
    textAnimation,
    animSpeed,
    scriptLines,
    audioFile,
    musicFile,
    musicVolume,
    captionBgStyle,
    captionRotate,
    voiceVolume,
    backgroundDurationFrames,
  } = props;

  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Slow zoom: scale 1.0 → 1.07 over entire video
  const zoomScale = slowZoom
    ? interpolate(frame, [0, durationInFrames], [1.0, 1.07], { extrapolateRight: 'clamp' })
    : 1.0;

  const adjustmentFilter = buildAdjustmentFilter({
    saturation: saturation ?? 100,
    contrast:   contrast   ?? 100,
    exposure:   exposure   ?? 0,
  });
  const bgFilter = [
    getColorGradeFilter(colorGrade, colorGradeIntensity ?? 100),
    adjustmentFilter,
    `blur(${backgroundBlur}px)`,
    `brightness(${backgroundBrightness})`,
  ].filter(Boolean).join(' ');

  const hasBg = backgroundVideo && backgroundVideo !== 'none';

  return (
    <AbsoluteFill style={{ backgroundColor: '#060409', overflow: 'hidden' }}>
      {/* Background video or solid */}
      {/*
        OffthreadVideo decodes frames in a worker via FFmpeg → stable, exact
        frame extraction at the composition fps. The previous <Video> tag used
        the browser's HTMLVideoElement, which is variable-frame-rate and the
        source of the choppy / flickering background reports. `loop` makes it
        cycle if the source clip is shorter than the composition; `muted` is
        kept so the source bg audio doesn't fight the narration.
      */}
      {hasBg ? (
        backgroundDurationFrames && backgroundDurationFrames > 0 ? (
          <Loop durationInFrames={Math.max(1, Math.floor(backgroundDurationFrames))}>
            <OffthreadVideo
              src={staticFile(`backgrounds/${backgroundVideo}`)}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                filter: bgFilter,
                transform: `scale(${zoomScale * 1.08})`,
                transformOrigin: 'center center',
              }}
              muted
            />
          </Loop>
        ) : (
          <OffthreadVideo
            src={staticFile(`backgrounds/${backgroundVideo}`)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: bgFilter,
              transform: `scale(${zoomScale * 1.08})`,
              transformOrigin: 'center center',
            }}
            muted
          />
        )
      ) : (
        <AbsoluteFill
          style={{
            background: 'linear-gradient(160deg, #0a0614 0%, #060409 40%, #0b0a18 100%)',
            transform: `scale(${zoomScale})`,
          }}
        />
      )}

      {/* Color grade overlay for non-video backgrounds */}
      {!hasBg && (
        <AbsoluteFill
          style={{
            background: colorGrade === 'purple'
              ? 'radial-gradient(ellipse at 50% 30%, rgba(80,20,120,0.4) 0%, transparent 70%)'
              : colorGrade === 'blue'
              ? 'radial-gradient(ellipse at 50% 30%, rgba(20,40,120,0.4) 0%, transparent 70%)'
              : colorGrade === 'warm'
              ? 'radial-gradient(ellipse at 50% 30%, rgba(120,60,20,0.4) 0%, transparent 70%)'
              : 'none',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Bottom gradient for readability */}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.2) 35%, rgba(0,0,0,0.05) 60%, rgba(0,0,0,0.25) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/*
        Tone overlay (highlights / shadows) uses mix-blend-mode, which composites
        with EVERY sibling above it in the stacking context. Without isolation,
        screen/multiply blend would bleed into the captions and grain — causing
        flickering as text fades in/out (the reported "glitching"). Wrapping it
        in `isolation: isolate` confines blending to just the background layer.
      */}
      <AbsoluteFill style={{ isolation: 'isolate', pointerEvents: 'none' }}>
        <ToneOverlay highlights={highlights ?? 0} shadows={shadows ?? 0} />
      </AbsoluteFill>

      {/* Vignette */}
      {vignette && <Vignette />}

      {/* Fog */}
      {fogOverlay && <FogOverlay frame={frame} />}

      {/* Rain */}
      {rainOverlay && <RainOverlay frame={frame} />}

      {/* VHS scan lines */}
      {grainType === 'vhs' && <ScanLines />}

      {/* Script lines */}
      {scriptLines.map((line, i) => (
        <ScriptLineComp
          key={i}
          line={line}
          frame={frame}
          fontFamily={fontFamily}
          fontSize={fontSize}
          textColor={textColor}
          textAnimation={textAnimation}
          animSpeed={animSpeed ?? 1}
          captionTopPct={captionTopPct ?? null}
          captionBgStyle={captionBgStyle ?? 'none'}
          captionRotate={captionRotate ?? 0}
        />
      ))}

      {/* Grain overlay (on top of text for realism) */}
      <GrainOverlay intensity={grainIntensity} type={grainType} />

      {/* Progress bar */}
      <ProgressBar frame={frame} totalFrames={durationInFrames} />

      {/* Voice audio — volume is prop-driven so the UI slider flows through */}
      {audioFile && (
        <Audio
          src={staticFile(`custom-audio/${audioFile}`)}
          volume={Math.max(0, Math.min(2, voiceVolume ?? 1))}
        />
      )}

      {/* Background music */}
      {musicFile && (
        <Audio
          src={staticFile(`music/${musicFile}`)}
          volume={musicVolume}
          loop
        />
      )}
    </AbsoluteFill>
  );
};
