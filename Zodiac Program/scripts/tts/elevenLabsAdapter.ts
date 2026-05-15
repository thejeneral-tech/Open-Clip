/**
 * ElevenLabs adapter for the Zodiac timing pipeline.
 *
 * Why this exists:
 *   Edge TTS gives no per-word timings; Kokoro also doesn't.
 *   ElevenLabs has a `with-timestamps` endpoint that returns BOTH the audio
 *   and a `normalized_alignment` block with per-character start/end times.
 *   We aggregate those into per-word timings and feed them straight into
 *   buildTimedCaptions(... { perLineWords }) so the master clock is no
 *   longer an approximation — every word is positioned at the exact second
 *   the speaker says it.
 *
 * Public:
 *   • listElevenLabsVoices()
 *   • generateElevenLabsVoice({ text, voiceId, modelId, stability, similarity, style })
 *   • generateElevenLabsVoiceWithTimestamps(...)
 *
 * Never throws raw strings — always Error objects with a useful message.
 */

import * as fs from 'fs';
import * as path from 'path';

const API_BASE = 'https://api.elevenlabs.io/v1';

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  description?: string;
}

export interface ElevenLabsGenerateOptions {
  text: string;
  voiceId: string;
  modelId?: string;            // default 'eleven_multilingual_v2' (highest quality + timestamps)
  stability?: number;          // 0-1, default 0.5
  similarity?: number;         // 0-1, default 0.75
  style?: number;              // 0-1, default 0.0
  speakerBoost?: boolean;      // default true
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface ElevenLabsWithTimings {
  buffer: Buffer;
  mimeType: string;
  // The script split into words with their per-word ms timestamps.
  // Empty if ElevenLabs did not return alignment data.
  words: WordTiming[];
}

function getKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY is not set in .env');
  return k;
}

/** GET /v1/voices — list every voice on the account (premade + cloned + saved). */
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const r = await fetch(`${API_BASE}/voices`, {
    headers: { 'xi-api-key': getKey() },
  });
  if (!r.ok) {
    throw new Error(`ElevenLabs /voices failed: HTTP ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as { voices: ElevenLabsVoice[] };
  return data.voices;
}

/**
 * POST /v1/text-to-speech/{voice_id}/with-timestamps — returns audio + word/character alignment.
 * This is the variant we want for the Zodiac pipeline so captions can be
 * placed at the exact frame each word is spoken.
 */
export async function generateElevenLabsVoiceWithTimestamps(
  opts: ElevenLabsGenerateOptions,
): Promise<ElevenLabsWithTimings> {
  const modelId = opts.modelId ?? 'eleven_multilingual_v2';
  const r = await fetch(`${API_BASE}/text-to-speech/${opts.voiceId}/with-timestamps`, {
    method: 'POST',
    headers: {
      'xi-api-key':   getKey(),
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: modelId,
      voice_settings: {
        stability:        opts.stability     ?? 0.5,
        similarity_boost: opts.similarity    ?? 0.75,
        style:            opts.style         ?? 0.0,
        use_speaker_boost: opts.speakerBoost ?? true,
      },
      output_format: 'mp3_44100_128',
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (HTTP ${r.status}): ${body.slice(0, 200)}`);
  }

  // The with-timestamps endpoint returns JSON with base64 audio + alignment.
  type AlignBlock = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  const j = (await r.json()) as {
    audio_base64: string;
    alignment?:            AlignBlock;
    normalized_alignment?: AlignBlock;
  };
  const audioB64 = j.audio_base64;
  if (!audioB64) throw new Error('ElevenLabs returned no audio_base64');
  const buffer = Buffer.from(audioB64, 'base64');

  const align = j.normalized_alignment ?? j.alignment;
  let words: WordTiming[] = [];
  if (align && align.characters?.length === align.character_start_times_seconds.length) {
    words = aggregateCharsToWords(
      align.characters,
      align.character_start_times_seconds,
      align.character_end_times_seconds,
    );
  }

  return { buffer, mimeType: 'audio/mpeg', words };
}

/**
 * Aggregate per-character timestamps into per-word timestamps. Whitespace
 * characters act as word breaks. A word's start = first non-space char's
 * start; its end = last non-space char's end.
 *
 * ElevenLabs sometimes emits 0/0 timing for non-speech characters (commas,
 * ellipses); we skip those when aggregating but include the actual chars
 * in the word text so it matches what the user typed.
 */
function aggregateCharsToWords(
  chars: string[],
  starts: number[],
  ends: number[],
): WordTiming[] {
  const out: WordTiming[] = [];
  let curWord = '';
  let curStart = -1;
  let curEnd = -1;
  const flush = () => {
    if (curWord.trim().length > 0 && curStart >= 0 && curEnd >= 0) {
      out.push({
        word: curWord,
        startMs: Math.round(curStart * 1000),
        endMs:   Math.round(curEnd * 1000),
      });
    }
    curWord = ''; curStart = -1; curEnd = -1;
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const s = starts[i];
    const e = ends[i];
    if (/\s/.test(c)) { flush(); continue; }
    if (curStart < 0) curStart = s;
    if (e > curEnd)   curEnd = e;
    curWord += c;
  }
  flush();
  return out;
}

/**
 * Map a flat array of word timings onto a list of script lines. Words are
 * consumed in order — for each line we eat as many words as match its
 * tokenization. Returns one WordTiming[] per line, in the shape the timing
 * engine expects under `opts.perLineWords`.
 *
 * Forgiving matcher: punctuation in the source line is ignored; case is
 * normalized; if a token doesn't match, we still consume one word from the
 * stream (so we don't run out of sync on contractions etc.).
 */
export function alignWordsToLines(
  scriptLines: Array<{ text: string }>,
  words: WordTiming[],
): WordTiming[][] {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let cursor = 0;
  return scriptLines.map((line) => {
    const tokens = line.text.split(/\s+/).filter(Boolean);
    const out: WordTiming[] = [];
    for (const tok of tokens) {
      const targetN = norm(tok);
      if (!targetN) continue;
      // Look-ahead window of 4 to recover from minor TTS divergence
      let pickIdx = -1;
      for (let i = cursor; i < Math.min(cursor + 4, words.length); i++) {
        if (norm(words[i].word) === targetN) { pickIdx = i; break; }
      }
      if (pickIdx === -1) pickIdx = cursor; // best-effort
      if (pickIdx < words.length) {
        out.push({ word: tok, startMs: words[pickIdx].startMs, endMs: words[pickIdx].endMs });
        cursor = pickIdx + 1;
      }
    }
    return out;
  });
}

// ── Lightweight usage counter ──────────────────────────────────────────────
// Bumped each time a full render uses ElevenLabs. UI reads this to warn the
// user when they're approaching their self-imposed budget (ELEVENLABS_USAGE_BUDGET).

const USAGE_FILE = path.resolve('data', 'elevenlabs-usage.json');

export function readElevenLabsUsage(): { count: number; budget: number } {
  const budget = Number(process.env.ELEVENLABS_USAGE_BUDGET ?? 20) || 20;
  try {
    const j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return { count: Number(j.count) || 0, budget };
  } catch {
    return { count: 0, budget };
  }
}

export function incrementElevenLabsUsage(): { count: number; budget: number } {
  const cur = readElevenLabsUsage();
  const next = { count: cur.count + 1, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(next, null, 2));
  } catch { /* non-fatal */ }
  return { count: next.count, budget: cur.budget };
}
