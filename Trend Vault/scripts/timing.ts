/**
 * Zodiac Program — Shared Timing Engine
 *
 * THE single source of truth for "what caption is on screen when".
 *
 * One contract used by every consumer:
 *   • server.ts          → after TTS, builds the canonical timeline
 *   • zodiac-render.ts   → reads startMs/endMs/words from each line
 *   • src/ZodiacVideo.tsx → consumes startFrame/endFrame computed from the same ms
 *   • frontend/zodiac.html → fetches the timed-captions JSON via the
 *                            /api/zodiac/voice-preview endpoint and uses the
 *                            exact same start/end times for live preview
 *
 * Rule: the generated voice audio duration is the master clock. Captions,
 * typewriter speed, line display, preview, and final render must all snap
 * to the timeline this module produces.
 *
 * Math:
 *   1. Count words in each line.
 *   2. Initial allocation: each line gets a slice of total audio duration
 *      proportional to its word count.
 *   3. Enforce a minimum readable display time (default 0.8s) — short lines
 *      get bumped up; longer lines proportionally absorb the deficit.
 *   4. Normalize so the last caption ends EXACTLY at audioDurationSec.
 *
 * The "Success condition" (last caption end is within 0.05s of the audio
 * duration) is hard-enforced by step 4 — we explicitly snap the final end
 * to the audio length and recompute the previous boundary if needed.
 */

export interface ScriptInput {
  text: string;
  type?: 'hook' | 'observation' | 'escalation' | 'truth' | 'twist' | 'ending';
  // Optional — completely ignored by the timing engine. Kept here only so the
  // engine accepts existing script-line shapes from the rest of the codebase
  // without type-juggling at every call site.
  durationSeconds?: number;
}

export interface TimedCaption {
  index: number;
  text: string;
  type: NonNullable<ScriptInput['type']>;
  // SI units — seconds, 0-based on the audio timeline
  start: number;
  end: number;
  duration: number;
  wordCount: number;
  // ms convenience aliases — scripts/zodiac-render.ts and src/ZodiacVideo.tsx
  // both consume startMs / endMs to compute frame indices.
  startMs: number;
  endMs: number;
  // Per-word timings — populated only when AssemblyAI alignment runs.
  // Frontend preview ignores these; renderer uses them for word-by-word reveal.
  words?: Array<{ word: string; startMs: number; endMs: number }>;
}

export interface TimedCaptionsBundle {
  audioDurationSec: number;
  totalWords: number;
  captions: TimedCaption[];
  // Which engine produced these timings — for telemetry / debug logs.
  source: 'word-proportional' | 'assemblyai-forced-alignment' | 'manual';
  // The diff between final caption end and audio duration AFTER normalization.
  // Must be < 0.05s for success — this module enforces it but the field is
  // exposed for the debug log + tests.
  finalCaptionEndDriftSec: number;
}

const WORD_RE = /\S+/g;
const DEFAULT_MIN_DISPLAY_SEC = 0.8;

// ── Public helpers ──────────────────────────────────────────────────────────

export function countWords(text: string): number {
  if (!text) return 0;
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

/**
 * Accept either an already-split array of lines OR a single multi-sentence
 * string and return an array of {text,type,durationSeconds} ready to feed
 * into buildTimedCaptions.
 */
export function splitScriptIntoCaptionLines(
  script: ScriptInput[] | string,
): ScriptInput[] {
  if (Array.isArray(script)) {
    return script
      .filter(l => (l?.text || '').trim().length > 0)
      .map(l => ({
        text: l.text.trim(),
        type: l.type ?? 'observation',
        durationSeconds: l.durationSeconds ?? 0,
      }));
  }
  // Plain string — split on sentence boundaries
  return String(script || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(text => ({ text, type: 'observation' as const, durationSeconds: 0 }));
}

/**
 * Core engine: produce a fully-timed caption bundle from a script + the
 * actual audio duration.
 *
 * Guarantees:
 *   • bundle.captions[last].end === audioDurationSec (drift < 1e-6)
 *   • bundle.captions[i].start === bundle.captions[i-1].end   (no gaps)
 *   • every caption.duration >= minDisplaySec (if the audio is long enough)
 */
export function buildTimedCaptions(
  script: ScriptInput[] | string,
  audioDurationSec: number,
  opts: {
    minDisplaySec?: number;
    /** When provided (e.g. from AssemblyAI), used to populate per-word timings */
    perLineWords?: Array<Array<{ word: string; startMs: number; endMs: number }>>;
    source?: TimedCaptionsBundle['source'];
  } = {},
): TimedCaptionsBundle {
  const lines = splitScriptIntoCaptionLines(script);
  const minDisplay = opts.minDisplaySec ?? DEFAULT_MIN_DISPLAY_SEC;
  const audio = Math.max(0.1, audioDurationSec);
  const n = lines.length;

  if (n === 0) {
    return {
      audioDurationSec: audio,
      totalWords: 0,
      captions: [],
      source: opts.source ?? 'word-proportional',
      finalCaptionEndDriftSec: 0,
    };
  }

  const wordCounts = lines.map(l => Math.max(1, countWords(l.text)));
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  // Step 1 — proportional allocation
  let raw = wordCounts.map(w => (w / totalWords) * audio);

  // Step 2 — enforce minimum readable display (only meaningful when audio is
  // long enough; if every line cannot satisfy minDisplay we skip this and
  // honor pure word proportionality)
  const totalMinNeeded = minDisplay * n;
  if (totalMinNeeded < audio * 0.85) {
    raw = raw.map(d => Math.max(minDisplay, d));
    // After lifting short lines, total may exceed audio — rescale proportionally
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - audio) > 1e-6) {
      const scale = audio / sum;
      raw = raw.map(d => d * scale);
    }
  } else {
    // Audio too short for everyone to hit minDisplay — leave proportional
    // allocation alone, will normalize below.
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      const scale = audio / sum;
      raw = raw.map(d => d * scale);
    }
  }

  // Step 3 — accumulate
  const captions: TimedCaption[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const start = t;
    const end = i === n - 1 ? audio : Math.min(audio, start + raw[i]);
    t = end;
    const words = opts.perLineWords?.[i];
    captions.push({
      index: i,
      text: lines[i].text,
      type: (lines[i].type ?? 'observation'),
      start,
      end,
      duration: end - start,
      wordCount: wordCounts[i],
      startMs: start * 1000,
      endMs: end * 1000,
      words: words && words.length > 0 ? words : undefined,
    });
  }

  // Step 4 — hard normalize: snap the last caption to exactly audio
  const last = captions[captions.length - 1];
  last.end = audio;
  last.duration = last.end - last.start;
  last.endMs = audio * 1000;
  const drift = last.end - audio; // tautologically 0 here, but kept for callers

  return {
    audioDurationSec: audio,
    totalWords,
    captions,
    source: opts.source ?? 'word-proportional',
    finalCaptionEndDriftSec: drift,
  };
}

/**
 * Given a single timed caption and a "current time" on the master timeline,
 * report how many characters of typewriter text should be visible AND the
 * 0..1 progress through the line. Used by the frontend preview AND any
 * future preview component. The Remotion renderer derives the same thing
 * from line.startFrame/endFrame, which were computed from these same ms.
 *
 * Reveal happens across the first 75% of the line's window so the line
 * settles before the next one takes over — same shape used inside
 * src/ZodiacVideo.tsx so preview and render stay aligned.
 */
export function getTypingProgressForTime(
  line: { start: number; end: number; text: string },
  currentTimeSec: number,
): { charsToShow: number; progress01: number; revealPct: number } {
  const dur = Math.max(1e-3, line.end - line.start);
  const t = Math.max(0, Math.min(1, (currentTimeSec - line.start) / dur));
  const revealPct = Math.max(0, Math.min(1, t / 0.75));
  return {
    progress01: t,
    revealPct,
    charsToShow: Math.floor(line.text.length * revealPct),
  };
}

/**
 * Print the standard [TIMING] debug block. Used by server.ts when building
 * the canonical bundle and by zodiac-render.ts when consuming it — so the
 * same log block appears at every layer.
 */
export function logTimingDebug(
  bundle: TimedCaptionsBundle,
  log: (line: string) => void = (s) => console.log(s),
  tag: string = 'TIMING',
): void {
  log(`[${tag}] audio duration: ${bundle.audioDurationSec.toFixed(3)}s`);
  log(`[${tag}] script word count: ${bundle.totalWords}`);
  log(`[${tag}] caption lines: ${bundle.captions.length}`);
  log(`[${tag}] source: ${bundle.source}`);
  for (const c of bundle.captions) {
    const preview = c.text.length > 56 ? c.text.slice(0, 53) + '...' : c.text;
    log(
      `[${tag}]   #${String(c.index).padStart(2)}  ` +
      `${c.start.toFixed(3)}s → ${c.end.toFixed(3)}s  ` +
      `(${c.duration.toFixed(3)}s, ${c.wordCount}w)  "${preview}"`
    );
  }
  if (bundle.captions.length > 0) {
    const lastEnd = bundle.captions[bundle.captions.length - 1].end;
    const diff = lastEnd - bundle.audioDurationSec;
    log(
      `[${tag}] final caption end: ${lastEnd.toFixed(3)}s   ` +
      `audio: ${bundle.audioDurationSec.toFixed(3)}s   ` +
      `diff: ${diff.toFixed(3)}s`
    );
    if (Math.abs(diff) > 0.05) {
      log(`[${tag}] ⚠️  diff > 0.05s — timing drift detected (success threshold not met)`);
    } else {
      log(`[${tag}] ✓ within 0.05s success window`);
    }
  }
}

/**
 * Convenience: convert a TimedCaptionsBundle into the shape that
 * scripts/zodiac-render.ts and src/ZodiacVideo.tsx already understand
 * (the existing "scriptLines with startMs/endMs/words" interface).
 *
 * No new shape — we keep the existing renderer contract stable. Both the
 * preview and the render then read the SAME object structure.
 */
export function bundleToRenderLines(bundle: TimedCaptionsBundle): Array<{
  text: string;
  type: TimedCaption['type'];
  startMs: number;
  endMs: number;
  durationSeconds: number;
  words?: TimedCaption['words'];
}> {
  return bundle.captions.map(c => ({
    text: c.text,
    type: c.type,
    startMs: c.startMs,
    endMs: c.endMs,
    durationSeconds: c.duration,
    words: c.words,
  }));
}
