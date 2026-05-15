/**
 * Text Preprocessor for TTS Cadence
 * ─────────────────────────────────────────────────────────────────────────────
 * The single most impactful upgrade for "less robotic" voice is BEFORE the audio
 * model: cleaning punctuation, inserting natural pause markers, and emitting two
 * separate texts —
 *   1) ttsText      → fed to the TTS engine, with ellipses / commas / em-dashes
 *                     deliberately tuned so prosody sounds intentional.
 *   2) captionText  → what gets drawn on screen, free of pause-only markers.
 *
 * Edge TTS does NOT support full SSML in node-edge-tts, but it DOES respect
 * ellipses ("..."), em-dashes ("—"), and explicit periods as pause cues. This
 * module shapes the script into a form that uses those cues to sound human.
 *
 * Configurable via PauseConfig if a caller wants different rhythms (slower for
 * Cave Oracle, faster for Fast Viral).
 */

export interface PauseConfig {
  commaPauseMs:    number; // pause after a comma
  periodPauseMs:   number; // pause after a period / question / exclamation
  ellipsisPauseMs: number; // pause for an ellipsis "..."
  lineBreakPauseMs:number; // pause between consecutive lines
  hookPauseMs:     number; // pause after the opening hook line
  endingPauseMs:   number; // pause before the final beat
}

export const DEFAULT_PAUSES: PauseConfig = {
  commaPauseMs:    180,
  periodPauseMs:   380,
  ellipsisPauseMs: 650,
  lineBreakPauseMs:500,
  hookPauseMs:     700,
  endingPauseMs:   800,
};

export const CINEMATIC_PAUSES: PauseConfig = {
  commaPauseMs:    250,
  periodPauseMs:   550,
  ellipsisPauseMs: 900,
  lineBreakPauseMs:750,
  hookPauseMs:     1000,
  endingPauseMs:   1100,
};

/**
 * Royal Pace slider (0-100) → PauseConfig.
 * 0   = natural rhythm (≈ DEFAULT_PAUSES)
 * 50  = slow cinematic (close to CINEMATIC_PAUSES)
 * 100 = ancient storyteller, dramatic dwells everywhere
 *
 * Formulas match the spec from the design doc — slight tweaks so the curve
 * stays linear-ish but caps at sensible upper bounds.
 */
export function pauseConfigFromRoyalPace(slider: number): PauseConfig {
  const v = Math.max(0, Math.min(100, slider || 0));
  return {
    commaPauseMs:    Math.round(120 + v * 2),
    periodPauseMs:   Math.round(280 + v * 4),
    ellipsisPauseMs: Math.round(450 + v * 5),
    lineBreakPauseMs:Math.round(350 + v * 4),
    hookPauseMs:     Math.round(500 + v * 4),
    endingPauseMs:   Math.round(650 + v * 4),
  };
}

/**
 * Normalize raw script text so the TTS model produces a consistent,
 * intentional-sounding read. This is purely textual — no audio is touched here.
 *
 * Transforms:
 *   "—"  → ", " + period-style pause             (em-dash → cinematic hold)
 *   "..." → preserved, becomes the longest pause (already standardized)
 *   ".."  → "..."
 *   "  " → " "
 *   trailing whitespace stripped per line
 *   single sentences with no end punctuation get a period appended
 *   removes stray symbols TTS would read aloud (e.g. unmatched quotes, "*")
 */
export function normalizeForTts(input: string): string {
  let s = input;
  // Strip markdown / formatting artifacts that TTS would read literally
  s = s.replace(/[*_~`#]+/g, '');
  // Collapse repeated dots into a real ellipsis
  s = s.replace(/\.{2,}/g, '...');
  // Em-dash and en-dash → comma + slight breath
  s = s.replace(/\s*[—–]\s*/g, ', ');
  // Smart quotes → straight quotes (some engines mispronounce them)
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Standalone numerals that the engine reads "two thousand twenty four" weirdly
  // → leave numbers up to 99 alone, but we don't try to spell out years here
  // (script content rarely contains them in this app).
  // Compress whitespace
  s = s.replace(/[ \t]{2,}/g, ' ');
  // Ensure punctuation has a single space after it (helps prosody)
  s = s.replace(/([,;:.!?])(?=[^\s\d])/g, '$1 ');
  // Final trim
  s = s.trim();
  // If a sentence has no terminal punctuation, append a period for a clean stop
  if (s && !/[.!?…]$/.test(s)) s += '.';
  return s;
}

/**
 * Strip pause-only markers and return a clean caption-friendly version.
 * Called when the on-screen text should NOT show ellipses inserted purely for
 * cadence (we keep author-original ellipses, but not engine-injected ones).
 */
export function normalizeForCaption(input: string): string {
  let s = input;
  s = s.replace(/[*_~`#]+/g, '');
  s = s.replace(/\s*[—–]\s*/g, ' — ');     // restore em-dash for visual rhythm
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.trim();
  return s;
}

export interface PreparedScript {
  ttsText:     string;   // single string fed to the TTS engine (joined w/ pauses)
  ttsChunks:   Array<{ text: string; pauseAfterMs: number }>; // per-line splits, useful for engines without SSML — concat audio + insert silence
  captionText: string;   // clean text for on-screen captions (newline-separated)
}

/**
 * Take a multi-line script (one sentence per line, as the motivational scripts
 * already produce) and prepare it for both TTS and captions.
 *
 * The opening line is treated as a HOOK and gets a longer pause after it.
 * The last line is treated as the ENDING beat.
 */
export function prepareScript(
  lines: string[],
  cfg: PauseConfig = DEFAULT_PAUSES,
): PreparedScript {
  const cleanLines = lines
    .map(l => l.trim())
    .filter(Boolean);

  const ttsChunks = cleanLines.map((raw, i) => {
    const isHook   = i === 0;
    const isEnding = i === cleanLines.length - 1;
    const isShort  = raw.split(/\s+/).length <= 5;
    const ttsLine  = normalizeForTts(raw);

    // Longer pause for hook + ending; tiny extra for very short emphatic lines
    let pause = cfg.lineBreakPauseMs;
    if (isHook)        pause = cfg.hookPauseMs;
    else if (isEnding) pause = cfg.endingPauseMs;
    else if (isShort)  pause = cfg.lineBreakPauseMs + 150;

    return { text: ttsLine, pauseAfterMs: pause };
  });

  // For engines without explicit pause control, we approximate inter-line
  // pauses by inserting an ellipsis (long pause) or em-dash-style comma chain.
  // Edge TTS handles "..." as ~700-900ms, perfect for our needs.
  const ttsText = ttsChunks
    .map((c, i) => {
      if (i === ttsChunks.length - 1) return c.text;
      // Approximate pauseAfterMs as ellipsis-count: 1 ellipsis ≈ 700ms
      const ellipsisCount = Math.max(1, Math.round(c.pauseAfterMs / 700));
      const tail = '... '.repeat(ellipsisCount).trim();
      return c.text + ' ' + tail;
    })
    .join(' ');

  const captionText = cleanLines.map(normalizeForCaption).join('\n');

  return { ttsText, ttsChunks, captionText };
}

/**
 * Convenience: prepare a single string. Splits on existing newlines /
 * sentence-ending punctuation if no newlines are present.
 */
export function prepareString(text: string, cfg?: PauseConfig): PreparedScript {
  const lines = text.includes('\n')
    ? text.split('\n')
    : text.split(/(?<=[.!?])\s+/);
  return prepareScript(lines, cfg);
}
