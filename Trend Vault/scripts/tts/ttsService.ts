import * as fs from 'fs';
import * as path from 'path';
import { spawn as _spawn } from 'child_process';
import {
  applyAudioFX,
  PostProcessOptions,
  concatWithPauses,
  probeAudioDurationSec,
  tmpAudioFile,
} from './audioPostProcess';
import { formatScript, truncateForPreview } from './scriptFormatter';
import { prepareString, DEFAULT_PAUSES, CINEMATIC_PAUSES, pauseConfigFromRoyalPace } from './textPreprocessor';
import { generateVoiceLocal, KokoroTimeoutError } from './localTtsAdapter';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presetsRaw = require('./voicePresets.json') as unknown[];

const CUSTOM_PRESETS_PATH = path.resolve('./custom-presets.json');
function readCustomPresets(): VoicePreset[] {
  if (!fs.existsSync(CUSTOM_PRESETS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CUSTOM_PRESETS_PATH, 'utf8')) as VoicePreset[]; }
  catch { return []; }
}

export interface VoicePreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  edgeId: string;
  defaults: {
    pitch: number;
    rate: number;
    speed: number;
    volume: number;
    intensity: number;
  };
  eq: string;
  reverb: boolean;
  robot: boolean;
}

export const VOICE_PRESETS: VoicePreset[] = presetsRaw as VoicePreset[];

export type TtsLogger = (line: string) => void;

export interface GenerateVoiceOptions {
  text: string;
  presetId: string;
  pitch?: number;
  rate?: number;
  speed?: number;
  volume?: number;
  intensity?: number;
  preview?: boolean;
  throatDepth?:  number;
  ancientRasp?:  number;
  royalPace?:    number;
  chamberSpace?: number;
  logger?: TtsLogger;
  safeMode?: boolean;
  engine?: 'auto' | 'local' | 'edge';
}

const KOKORO_UNREACHABLE_MESSAGE =
  'Kokoro TTS server is not reachable. Start it with start-kokoro.bat ' +
  '(the launchers Kokoro card does the same thing) and try again.';

const MAX_CHUNK_CHARS = 240;
const MIN_CHUNK_DURATION_SEC = 0.2;
const MIN_CHUNK_BYTES = 2_000;

// ══════════════════════════════════════════════════════════════════════
// Text sanitizers (the silent-chunk root cause was raw text + wrong voice)
// ══════════════════════════════════════════════════════════════════════
function sanitizeForKokoroBase(input: string): string {
  let s = String(input || '');
  // Smart quotes → straight
  s = s.replace(/[‘’‚‛]/g, "'");
  s = s.replace(/[“”„‟]/g, '"');
  // Em/en dashes → comma
  s = s.replace(/[–—―]/g, ',');
  // Ellipsis / repeated dots → single period
  s = s.replace(/…/g, '.');
  s = s.replace(/\.{2,}/g, '.');
  // Zero-width / BOM / direction marks
  s = s.replace(/[​-‏﻿‪-‮]/g, '');
  // Strip emoji
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}]/gu, '');
  // De-shout: lowercase if 90%+ of letters are uppercase
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4) {
    const upperRatio = (letters.match(/[A-Z]/g) || []).length / letters.length;
    if (upperRatio >= 0.9) s = s.toLowerCase();
  }
  // Contractions Kokoro pronounces poorly
  s = s.replace(/\bdoesn't\b/gi, 'does not')
       .replace(/\bisn't\b/gi,   'is not')
       .replace(/\bwasn't\b/gi,  'was not')
       .replace(/\baren't\b/gi,  'are not')
       .replace(/\bweren't\b/gi, 'were not')
       .replace(/\bcan't\b/gi,   'cannot')
       .replace(/\bwon't\b/gi,   'will not')
       .replace(/\bdon't\b/gi,   'do not')
       .replace(/\bdidn't\b/gi,  'did not');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length) s = s[0].toUpperCase() + s.slice(1);
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

function sanitizeForKokoro(input: string, attempt: number): string {
  let s = sanitizeForKokoroBase(input);
  if (attempt >= 2) s = s.replace(/[^\x20-\x7E]/g, '');
  if (attempt >= 3) {
    s = s.replace(/[^a-zA-Z0-9 .,!?'-]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (s && !/[.!?]$/.test(s)) s += '.';
  }
  return s;
}
export { sanitizeForKokoroBase, sanitizeForKokoro };

// ══════════════════════════════════════════════════════════════════════
// Kokoro voice resolver — the OTHER silent-chunk root cause
// ══════════════════════════════════════════════════════════════════════
// Kokoro IDs look like "af_heart" / "am_eric"; Edge IDs look like
// "en-US-AriaNeural"; custom preset IDs look like "custom_XXX". Sending
// the wrong shape produces 0.00s audio with no error.
const KOKORO_DEFAULT_VOICES: string[] = ['af_heart', 'af_bella', 'am_michael', 'am_eric', 'af_nicole'];
const KOKORO_SAFEST_DEFAULT = 'af_heart';

function isLikelyKokoroVoiceId(id: string): boolean {
  return !!id && /^[a-z]{2}_[a-z0-9]+$/.test(id);
}

function pickKokoroVoiceForAttempt(rawVoice: string, attempt: number): string {
  if (attempt === 1 && isLikelyKokoroVoiceId(rawVoice)) return rawVoice;
  if (attempt === 1 && rawVoice) return KOKORO_SAFEST_DEFAULT;
  return KOKORO_DEFAULT_VOICES[(attempt - 1) % KOKORO_DEFAULT_VOICES.length];
}
export { KOKORO_DEFAULT_VOICES, KOKORO_SAFEST_DEFAULT, pickKokoroVoiceForAttempt };

// ══════════════════════════════════════════════════════════════════════
// Chunking
// ══════════════════════════════════════════════════════════════════════
function splitForKokoro(text: string): string[] {
  const out: string[] = [];
  if (!text || !text.trim()) return out;
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHUNK_CHARS) { out.push(sentence); continue; }
    const words = sentence.split(/\s+/);
    let buf = '';
    for (const w of words) {
      if (!buf) { buf = w; continue; }
      if (buf.length + 1 + w.length > MAX_CHUNK_CHARS) { out.push(buf); buf = w; }
      else buf += ' ' + w;
    }
    if (buf) out.push(buf);
  }
  return out;
}

interface PreparedChunk {
  originalLineIndex: number;
  text: string;
  pauseAfterMs: number;
}

function buildKokoroChunks(
  ttsChunks: { text: string; pauseAfterMs: number }[],
  formatter: (text: string) => string,
): PreparedChunk[] {
  const out: PreparedChunk[] = [];
  for (let li = 0; li < ttsChunks.length; li++) {
    const { text: rawText, pauseAfterMs } = ttsChunks[li];
    const cleaned = formatter(rawText);
    if (!cleaned || !cleaned.trim()) continue;
    const parts = splitForKokoro(cleaned);
    for (let pi = 0; pi < parts.length; pi++) {
      const isLastPart = pi === parts.length - 1;
      out.push({ originalLineIndex: li, text: parts[pi], pauseAfterMs: isLastPart ? pauseAfterMs : 60 });
    }
  }
  return out;
}

function splitChunkIntoSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[.!?])\s+/)
    .flatMap(s => s.length > 110 ? s.split(/,\s+/) : [s])
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => /[.!?]$/.test(s) ? s : s + '.');
  return pieces.length ? pieces : [text];
}

interface ChunkGenerationResult {
  path: string;
  durationSec: number;
  bytes: number;
  attempts: number;
}

// Robust duration probe with wait + retry — hides the OS metadata-flush race
// that was reporting 0.00s on freshly-written Kokoro files.
async function probeDurationRobust(filePath: string, log: TtsLogger): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const d = await probeAudioDurationSec(filePath);
    if (d >= MIN_CHUNK_DURATION_SEC) return d;
    if (i < 4) await new Promise(r => setTimeout(r, 300));
  }
  const final = await probeAudioDurationSec(filePath);
  log('  duration probe: ' + final.toFixed(3) + 's after 5 retries');
  return final;
}

async function tryKokoroOnce(
  text: string,
  voice: string,
  speed: number,
  log: TtsLogger,
  label: string,
): Promise<{ ok: true; path: string; bytes: number; duration: number } | { ok: false; reason: string; reachable: boolean }> {
  if (!text) return { ok: false, reason: 'empty text', reachable: true };
  const outPath = tmpAudioFile('.wav');
  try {
    const local = await generateVoiceLocal({ text, voice, speed, outPath });
    if (!local) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
      return { ok: false, reason: 'kokoro unreachable', reachable: false };
    }
    if (local.bytes < MIN_CHUNK_BYTES) {
      log('  ' + label + ' returned ' + local.bytes + ' bytes (too small)');
      try { fs.unlinkSync(outPath); } catch {}
      return { ok: false, reason: 'too small (' + local.bytes + ' bytes)', reachable: true };
    }
    const dur = await probeDurationRobust(outPath, log);
    if (dur < MIN_CHUNK_DURATION_SEC) {
      log('  ' + label + ' returned ' + dur.toFixed(3) + 's of audio');
      try { fs.unlinkSync(outPath); } catch {}
      return { ok: false, reason: 'duration ' + dur.toFixed(3) + 's', reachable: true };
    }
    log('  ' + label + ' success: ' + dur.toFixed(2) + 's, ' + Math.round(local.bytes / 1024) + 'KB, voice=' + voice);
    return { ok: true, path: outPath, bytes: local.bytes, duration: dur };
  } catch (err) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    const reachable = !(err instanceof Error && /unreachable|ECONNREFUSED|fetch failed/i.test(msg));
    log('  ' + label + ' threw: ' + msg);
    if (err instanceof KokoroTimeoutError) log('  (timeout)');
    return { ok: false, reason: msg, reachable };
  }
}

// Multi-attempt chunk synthesis — A/B/C/D plan
export class ChunkSynthesisFailed extends Error {
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
  constructor(msg: string, chunkIndex: number, totalChunks: number, chunkText: string) {
    super(msg);
    this.name = 'ChunkSynthesisFailed';
    this.chunkIndex = chunkIndex;
    this.totalChunks = totalChunks;
    this.chunkText = chunkText;
  }
}

async function generateChunkWithRetry(
  chunk: PreparedChunk,
  voice: string,
  speed: number,
  chunkIndex: number,
  totalChunks: number,
  log: TtsLogger,
): Promise<ChunkGenerationResult> {
  const safeVoice = pickKokoroVoiceForAttempt(voice, 1);
  const tag = (s: string) => '  chunk ' + chunkIndex + '/' + totalChunks + ' ' + s;

  // Attempt A — preset voice (mapped to a Kokoro id) + baseline-sanitized text
  log(tag('attempt A — preset voice "' + voice + '" via Kokoro id "' + safeVoice + '"'));
  {
    const t = sanitizeForKokoroBase(chunk.text);
    const r = await tryKokoroOnce(t, safeVoice, speed, log, 'attempt A');
    if (r.ok) return { path: r.path, durationSec: r.duration, bytes: r.bytes, attempts: 1 };
    if (!r.reachable) throw new Error(KOKORO_UNREACHABLE_MESSAGE);
  }

  // Attempt B — safest default Kokoro voice + fully sanitized text
  log(tag('attempt B — safest default voice ' + KOKORO_SAFEST_DEFAULT));
  {
    const t = sanitizeForKokoro(chunk.text, 2);
    const r = await tryKokoroOnce(t, KOKORO_SAFEST_DEFAULT, 1.0, log, 'attempt B');
    if (r.ok) return { path: r.path, durationSec: r.duration, bytes: r.bytes, attempts: 2 };
    if (!r.reachable) throw new Error(KOKORO_UNREACHABLE_MESSAGE);
  }

  // Attempt C — short safe text (<=120 chars) + safest default voice
  {
    let t = sanitizeForKokoro(chunk.text, 3);
    if (t.length > 120) t = t.slice(0, 117).replace(/\s+\S*$/, '') + '.';
    log(tag('attempt C — short safe text (' + t.length + ' chars), default voice'));
    const r = await tryKokoroOnce(t, KOKORO_SAFEST_DEFAULT, 1.0, log, 'attempt C');
    if (r.ok) return { path: r.path, durationSec: r.duration, bytes: r.bytes, attempts: 3 };
    if (!r.reachable) throw new Error(KOKORO_UNREACHABLE_MESSAGE);
  }

  // Attempt D — split into sentences, synthesize each, then concat
  const pieces = splitChunkIntoSentences(sanitizeForKokoroBase(chunk.text));
  log(tag('attempt D — split into ' + pieces.length + ' sub-sentences'));
  if (pieces.length > 1) {
    const subPaths: string[] = [];
    let subBytes = 0;
    for (let i = 0; i < pieces.length; i++) {
      const r = await tryKokoroOnce(pieces[i], KOKORO_SAFEST_DEFAULT, 1.0, log, 'attempt D sub ' + (i + 1));
      if (!r.ok) {
        if (!r.reachable) throw new Error(KOKORO_UNREACHABLE_MESSAGE);
        for (const p of subPaths) try { fs.unlinkSync(p); } catch {}
        throw new ChunkSynthesisFailed(
          'attempt D failed on sub-sentence ' + (i + 1) + '/' + pieces.length + ': ' + r.reason,
          chunkIndex, totalChunks, chunk.text,
        );
      }
      subPaths.push(r.path);
      subBytes += r.bytes;
    }
    const merged = tmpAudioFile('.wav');
    await concatWithPauses(subPaths, subPaths.map(() => 30), merged);
    for (const p of subPaths) try { fs.unlinkSync(p); } catch {}
    const mergedDur = await probeDurationRobust(merged, log);
    log(tag('attempt D merged ' + subPaths.length + ' pieces → ' + mergedDur.toFixed(2) + 's'));
    return { path: merged, durationSec: mergedDur, bytes: subBytes, attempts: 4 };
  }

  const preview = chunk.text.slice(0, 80).replace(/\n/g, ' ');
  throw new ChunkSynthesisFailed(
    'Kokoro could not synthesize chunk ' + chunkIndex + '/' + totalChunks +
    ' after attempts A/B/C/D. Chunk text: "' + preview + (chunk.text.length > 80 ? '...' : '') + '"',
    chunkIndex, totalChunks, chunk.text,
  );
}

// ══════════════════════════════════════════════════════════════════════
// Engine-level fallback (ElevenLabs → Edge TTS)
// ══════════════════════════════════════════════════════════════════════
async function elevenLabsSynthesize(text: string, apiKey: string): Promise<{ path: string; bytes: number; duration: number }> {
  const voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel — exists on every account
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?optimize_streaming_latency=0';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let body = ''; try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error('ElevenLabs HTTP ' + res.status + (body ? ': ' + body : ''));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = tmpAudioFile('.mp3');
  fs.writeFileSync(out, buf);
  const dur = await probeAudioDurationSec(out);
  if (dur < MIN_CHUNK_DURATION_SEC) throw new Error('ElevenLabs returned ' + dur.toFixed(2) + 's audio');
  return { path: out, bytes: buf.length, duration: dur };
}

async function edgeTtsSynthesize(text: string): Promise<{ path: string; bytes: number; duration: number }> {
  const out = tmpAudioFile('.mp3');
  await new Promise<void>((resolve, reject) => {
    const pyCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
    const tryOne = (idx: number) => {
      if (idx >= pyCmds.length) { reject(new Error('python interpreter not found (install python + pip install edge-tts)')); return; }
      const p = _spawn(pyCmds[idx], ['-m', 'edge_tts', '--voice', 'en-US-AriaNeural', '--text', text, '--write-media', out], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('error', () => tryOne(idx + 1));
      p.on('close', code => {
        if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1024) resolve();
        else if (/No module named|edge_tts/i.test(err)) reject(new Error('edge-tts not installed - run: pip install edge-tts'));
        else reject(new Error('edge-tts exit ' + code + (err ? ': ' + err.slice(-200) : '')));
      });
    };
    tryOne(0);
  });
  const buf = fs.readFileSync(out);
  const dur = await probeAudioDurationSec(out);
  if (dur < MIN_CHUNK_DURATION_SEC) throw new Error('edge-tts returned ' + dur.toFixed(2) + 's audio');
  return { path: out, bytes: buf.length, duration: dur };
}

async function fallbackEngineSynthesize(
  rawText: string,
  log: TtsLogger,
): Promise<{ engine: string; path: string; bytes: number; duration: number }> {
  const text = sanitizeForKokoroBase(rawText) || rawText;
  const elKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (elKey) {
    try {
      const r = await elevenLabsSynthesize(text, elKey);
      log('Fallback TTS success: ' + r.duration.toFixed(1) + 's via ElevenLabs');
      return { engine: 'elevenlabs', ...r };
    } catch (e) {
      log('ElevenLabs fallback failed: ' + (e as Error).message + ' - trying Edge TTS next');
    }
  }
  try {
    const r = await edgeTtsSynthesize(text);
    log('Fallback TTS success: ' + r.duration.toFixed(1) + 's via Edge TTS');
    return { engine: 'edge-tts', ...r };
  } catch (e) {
    log('Edge TTS fallback failed: ' + (e as Error).message);
    throw new Error(
      'All TTS engines failed for this chunk. ' +
      (elKey ? '' : 'No ELEVENLABS_API_KEY set. ') +
      'Edge TTS error: ' + (e as Error).message + '. Install once: pip install edge-tts',
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
// Public preflight + debug
// ══════════════════════════════════════════════════════════════════════
export interface PreflightResult {
  ok: boolean;
  engine: 'kokoro' | 'kokoro_unreachable' | 'silent';
  duration?: number;
  bytes?: number;
  reason?: string;
}

export async function runKokoroRenderPreflight(presetEdgeId?: string, log: TtsLogger = () => {}): Promise<PreflightResult> {
  const voice = pickKokoroVoiceForAttempt(presetEdgeId || '', 1);
  log('Preflight: synthesizing "This is a render test." via voice ' + voice);
  const r = await tryKokoroOnce('This is a render test.', voice, 1.0, log, 'preflight');
  if (r.ok) {
    try { fs.unlinkSync(r.path); } catch {}
    return { ok: true, engine: 'kokoro', duration: r.duration, bytes: r.bytes };
  }
  if (!r.reachable) return { ok: false, engine: 'kokoro_unreachable', reason: r.reason };
  return { ok: false, engine: 'silent', reason: r.reason };
}

export interface ChunkDebugReport {
  variant: 'A_original' | 'B_sanitized' | 'C_split_first' | 'C_split_second';
  textSent: string;
  voiceSent: string;
  ok: boolean;
  bytes?: number;
  duration?: number;
  outPath?: string;
  reason?: string;
}

export async function debugChunkSynthesis(
  rawText: string,
  presetEdgeId: string,
  log: TtsLogger = () => {},
): Promise<ChunkDebugReport[]> {
  const debugDir = path.resolve('./debug/kokoro');
  try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}

  const stamp = Date.now();
  const reports: ChunkDebugReport[] = [];

  const variants: Array<{ name: ChunkDebugReport['variant']; text: string; voice: string }> = [
    { name: 'A_original',     text: rawText,                              voice: pickKokoroVoiceForAttempt(presetEdgeId, 1) },
    { name: 'B_sanitized',    text: sanitizeForKokoroBase(rawText),       voice: KOKORO_SAFEST_DEFAULT },
  ];
  const sentences = splitChunkIntoSentences(sanitizeForKokoroBase(rawText));
  if (sentences.length >= 1) variants.push({ name: 'C_split_first',  text: sentences[0], voice: KOKORO_SAFEST_DEFAULT });
  if (sentences.length >= 2) variants.push({ name: 'C_split_second', text: sentences[1], voice: KOKORO_SAFEST_DEFAULT });

  for (const v of variants) {
    const r = await tryKokoroOnce(v.text, v.voice, 1.0, log, 'debug ' + v.name);
    if (r.ok) {
      const dst = path.join(debugDir, 'chunk_' + stamp + '_' + v.name + '.wav');
      try { fs.copyFileSync(r.path, dst); } catch {}
      try { fs.unlinkSync(r.path); } catch {}
      reports.push({ variant: v.name, textSent: v.text, voiceSent: v.voice, ok: true, bytes: r.bytes, duration: r.duration, outPath: dst });
    } else {
      reports.push({ variant: v.name, textSent: v.text, voiceSent: v.voice, ok: false, reason: r.reason });
    }
  }
  try {
    const summary = reports.map(r =>
      r.variant + ' voice=' + r.voiceSent + ' text="' + r.textSent.slice(0, 80) + '" ' +
      (r.ok ? 'OK ' + r.duration?.toFixed(2) + 's ' + Math.round((r.bytes || 0) / 1024) + 'KB -> ' + r.outPath
            : 'FAIL ' + r.reason)
    ).join('\n');
    fs.writeFileSync(path.join(debugDir, 'chunk_' + stamp + '_summary.txt'), summary);
  } catch {}
  return reports;
}

// ══════════════════════════════════════════════════════════════════════
// Main generateVoice — with preflight + engine fallback
// ══════════════════════════════════════════════════════════════════════
export async function generateVoice(opts: GenerateVoiceOptions): Promise<{ buffer: Buffer; mimeType: string }> {
  const log: TtsLogger = opts.logger || (() => {});

  const preset =
    VOICE_PRESETS.find(p => p.id === opts.presetId) ||
    readCustomPresets().find(p => p.id === opts.presetId);
  if (!preset) throw new Error('Unknown preset: ' + opts.presetId);

  const isCinematic = /cave_oracle|dungeon_wizard|cosmic_monk|dark_story|forbidden|shadow_prophet|gravel_king|ancient_librarian|ethereal|mythic|raspy|ancient_king|medieval_oracle|cave_prophet|dungeon_storyteller|old_warlock|cathedral_monk|gravel_knight|shadow_bard|elder_dragon|royal_seer|night_watchman|stone_temple|wandering_sage|dark_cosmos|flamekeeper|quiet_giant|old_kingdom/i.test(preset.id);
  const pauseCfg = (opts.royalPace && opts.royalPace > 0)
    ? pauseConfigFromRoyalPace(opts.royalPace)
    : (isCinematic ? CINEMATIC_PAUSES : DEFAULT_PAUSES);
  const prepared = prepareString(opts.text, pauseCfg);
  const speed = opts.speed !== undefined ? opts.speed : preset.defaults.speed;

  let chunks: PreparedChunk[];
  if (opts.preview) {
    const joinedText = prepared.ttsChunks.map(c => c.text).join(' ');
    const truncated = truncateForPreview(joinedText, 12, speed);
    chunks = [{ originalLineIndex: 0, text: formatScript(truncated), pauseAfterMs: 0 }];
  } else {
    chunks = buildKokoroChunks(prepared.ttsChunks, formatScript);
  }
  chunks = chunks.filter(c => c.text && c.text.trim().length > 0);
  if (chunks.length === 0) throw new Error('No non-empty text to synthesize.');

  log('Splitting script into ' + chunks.length + ' chunk(s) (max ' + MAX_CHUNK_CHARS + ' chars each)');

  const linePaths: string[]   = [];
  const linePauses: number[]  = [];
  const cleanup: string[]     = [];
  const perChunkDur: number[] = [];

  try {
    // Preflight — run the SAME tryKokoroOnce the render uses on a known
    // short sentence. If THAT fails, switch to fallback engine before we
    // burn 17 silent chunks of attempts.
    let kokoroHealthy = true;
    if (!opts.preview) {
      log('Checking Kokoro real render synthesis...');
      const pre = await tryKokoroOnce('This is a render test.', pickKokoroVoiceForAttempt(preset.edgeId, 1), speed, log, 'preflight');
      if (pre.ok) {
        log('Kokoro real-synthesis preflight: ' + pre.duration.toFixed(2) + 's, ' + Math.round(pre.bytes / 1024) + 'KB - Kokoro healthy.');
        try { fs.unlinkSync(pre.path); } catch {}
      } else {
        kokoroHealthy = false;
        log(pre.reachable
          ? 'Kokoro real test failed: ' + pre.reason + ' - switching to fallback engine before render.'
          : 'Kokoro preflight: server unreachable - switching to fallback engine.');
      }
    }

    let usedFallbackEngine: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      let result: ChunkGenerationResult | null = null;
      if (kokoroHealthy) {
        try {
          result = await generateChunkWithRetry(chunks[i], preset.edgeId, speed, i + 1, chunks.length, log);
        } catch (e) {
          if (e instanceof Error && /unreachable/i.test(e.message)) {
            kokoroHealthy = false;
            log('Kokoro became unreachable mid-render - switching to fallback engine.');
          } else if (e instanceof ChunkSynthesisFailed) {
            kokoroHealthy = false;
            log('Kokoro could not synthesize chunk ' + e.chunkIndex + '/' + e.totalChunks + ' - switching to fallback engine.');
          } else {
            throw e;
          }
        }
      }
      if (!result) {
        const fb = await fallbackEngineSynthesize(chunks[i].text, log);
        usedFallbackEngine = fb.engine;
        result = { path: fb.path, durationSec: fb.duration, bytes: fb.bytes, attempts: 99 };
      }
      cleanup.push(result.path);
      linePaths.push(result.path);
      linePauses.push(chunks[i].pauseAfterMs);
      perChunkDur.push(result.durationSec);
    }
    if (usedFallbackEngine) log('Fallback TTS engine used: ' + usedFallbackEngine + ' - render continued with voice.');

    const sumChunkDur = perChunkDur.reduce((a, b) => a + b, 0);
    const sumPauseDur = linePauses.slice(0, -1).reduce((a, b) => a + b, 0) / 1000;
    log('Merging ' + chunks.length + ' chunk(s), expected total ~ ' + (sumChunkDur + sumPauseDur).toFixed(2) + 's');

    const concatPath = tmpAudioFile('.wav');
    cleanup.push(concatPath);
    await concatWithPauses(linePaths, linePauses, concatPath);

    const concatDur = await probeDurationRobust(concatPath, log);
    if (concatDur < MIN_CHUNK_DURATION_SEC) {
      throw new Error('Concat produced ' + concatDur.toFixed(2) + 's of audio from ' + linePaths.length + ' chunks (expected ~' + (sumChunkDur + sumPauseDur).toFixed(2) + 's).');
    }
    log('Merged audio duration: ' + concatDur.toFixed(2) + 's');

    const presetSliders = (preset as { sliders?: { throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number } }).sliders || {};
    const finalPath = tmpAudioFile('.mp3');
    cleanup.push(finalPath);

    if (opts.safeMode) {
      log('Safe mode: skipping FX chain');
      await applyAudioFX(concatPath, finalPath, {
        pitch: 0, rate: 0, speed: 1.0, volume: 0, intensity: 0,
        eq: 'none', reverb: false, robot: false,
        throatDepth: 0, ancientRasp: 0, royalPace: 0, chamberSpace: 0,
      });
    } else {
      const fxOpts: PostProcessOptions = {
        pitch:     opts.pitch     !== undefined ? opts.pitch     : preset.defaults.pitch,
        rate:      opts.rate      !== undefined ? opts.rate      : preset.defaults.rate,
        speed:     opts.speed     !== undefined ? opts.speed     : preset.defaults.speed,
        volume:    opts.volume    !== undefined ? opts.volume    : preset.defaults.volume,
        intensity: opts.intensity !== undefined ? opts.intensity : preset.defaults.intensity,
        eq:        preset.eq,
        reverb:    preset.reverb,
        robot:     preset.robot,
        throatDepth:  opts.throatDepth  !== undefined ? opts.throatDepth  : (presetSliders.throatDepth  || 0),
        ancientRasp:  opts.ancientRasp  !== undefined ? opts.ancientRasp  : (presetSliders.ancientRasp  || 0),
        royalPace:    opts.royalPace    !== undefined ? opts.royalPace    : (presetSliders.royalPace    || 0),
        chamberSpace: opts.chamberSpace !== undefined ? opts.chamberSpace : (presetSliders.chamberSpace || 0),
      };
      await applyAudioFX(concatPath, finalPath, fxOpts);
    }

    const finalDur = await probeDurationRobust(finalPath, log);
    if (finalDur < MIN_CHUNK_DURATION_SEC) {
      throw new Error('Final post-FX audio is ' + finalDur.toFixed(2) + 's - FX chain destroyed the audio. Try Force Working Voice Render.');
    }
    log('Final voice audio: ' + finalDur.toFixed(2) + 's' + (opts.safeMode ? ' (safe mode)' : ''));

    const buffer = fs.readFileSync(finalPath);
    return { buffer, mimeType: 'audio/mpeg' };
  } finally {
    for (const f of cleanup) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════
// Force Working Voice Render
// ══════════════════════════════════════════════════════════════════════
export async function forceWorkingVoiceRender(
  text: string,
  log: TtsLogger = (l: string) => console.log('[FORCE]', l),
): Promise<{ buffer: Buffer; mimeType: string; engine: string }> {
  log('Force Working Voice Render - bypassing custom Kokoro preset');
  const prepared = prepareString(text, DEFAULT_PAUSES);
  const chunkSpecs = buildKokoroChunks(prepared.ttsChunks, formatScript);
  const cleanup: string[] = [];
  const linePaths: string[] = [];
  const linePauses: number[] = [];
  let engineUsed = 'kokoro_default';
  try {
    for (let i = 0; i < chunkSpecs.length; i++) {
      const chunk = chunkSpecs[i];
      const safeText = sanitizeForKokoroBase(chunk.text);
      const r = await tryKokoroOnce(safeText, KOKORO_SAFEST_DEFAULT, 1.0, log, 'force chunk ' + (i + 1));
      let path: string;
      if (r.ok) { path = r.path; }
      else {
        const fb = await fallbackEngineSynthesize(safeText, log);
        engineUsed = fb.engine;
        path = fb.path;
      }
      cleanup.push(path);
      linePaths.push(path);
      linePauses.push(chunk.pauseAfterMs);
    }
    const merged = tmpAudioFile('.mp3');
    cleanup.push(merged);
    await concatWithPauses(linePaths, linePauses, merged);
    const buf = fs.readFileSync(merged);
    return { buffer: buf, mimeType: 'audio/mpeg', engine: engineUsed };
  } finally {
    for (const f of cleanup) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}
 KOKORO_UNREACHABLE_MESSAGE);
  }

  const pieces = splitChunkIntoSentences(sanitizeForKokoroBase(chunk.text));
  log(tag('attempt D — split into ' + pieces.length + ' sub-sentences'));
  if (pieces.length > 1) {
    const subPaths: string[] = [];
    let subBytes = 0;
    for (let i = 0; i < pieces.length; i++) {
      const r = await tryKokoroOnce(pieces[i], KOKORO_SAFEST_DEFAULT, 1.0, log, 'attempt D sub ' + (i + 1));
      if (!r.ok) {
        if (!r.reachable) throw new Error(KOKORO_UNREACHABLE_MESSAGE);
        for (const p of subPaths) try { fs.unlinkSync(p); } catch {}
        throw new ChunkSynthesisFailed(
          'attempt D failed on sub-sentence ' + (i + 1) + '/' + pieces.length + ': ' + r.reason,
          chunkIndex, totalChunks, chunk.text,
        );
      }
      subPaths.push(r.path);
      subBytes += r.bytes;
    }
    const merged = tmpAudioFile('.wav');
    await concatWithPauses(subPaths, subPaths.map(() => 30), merged);
    for (const p of subPaths) try { fs.unlinkSync(p); } catch {}
    const mergedDur = await probeDurationRobust(merged, log);
    return { path: merged, durationSec: mergedDur, bytes: subBytes, attempts: 4 };
  }

  const preview = chunk.text.slice(0, 80).replace(/\n/g, ' ');
  throw new ChunkSynthesisFailed(
    'Kokoro could not synthesize chunk ' + chunkIndex + '/' + totalChunks +
    ' after attempts A/B/C/D. Chunk text: "' + preview + (chunk.text.length > 80 ? '...' : '') + '"',
    chunkIndex, totalChunks, chunk.text,
  );
}

// ── Engine-level fallback (ElevenLabs → Edge TTS) ───────────────────────
async function elevenLabsSynthesize(text: string, apiKey: string): Promise<{ path: string; bytes: number; duration: number }> {
  const voiceId = '21m00Tcm4TlvDq8ikWAM';
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?optimize_streaming_latency=0';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let body = ''; try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error('ElevenLabs HTTP ' + res.status + (body ? ': ' + body : ''));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = tmpAudioFile('.mp3');
  fs.writeFileSync(out, buf);
  const dur = await probeAudioDurationSec(out);
  if (dur < MIN_CHUNK_DURATION_SEC) throw new Error('ElevenLabs returned ' + dur.toFixed(2) + 's audio');
  return { path: out, bytes: buf.length, duration: dur };
}

async function edgeTtsSynthesize(text: string): Promise<{ path: string; bytes: number; duration: number }> {
  const out = tmpAudioFile('.mp3');
  await new Promise<void>((resolve, reject) => {
    const pyCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
    const tryOne = (idx: number) => {
      if (idx >= pyCmds.length) { reject(new Error('python interpreter not found (install python + pip install edge-tts)')); return; }
      const p = _spawn(pyCmds[idx], ['-m', 'edge_tts', '--voice', 'en-US-AriaNeural', '--text', text, '--write-media', out], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('error', () => tryOne(idx + 1));
      p.on('close', code => {
        if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1024) resolve();
        else if (/No module named|edge_tts/i.test(err)) reject(new Error('edge-tts not installed - run: pip install edge-tts'));
        else reject(new Error('edge-tts exit ' + code + (err ? ': ' + err.slice(-200) : '')));
      });
    };
    tryOne(0);
  });
  const buf = fs.readFileSync(out);
  const dur = await probeAudioDurationSec(out);
  if (dur < MIN_CHUNK_DURATION_SEC) throw new Error('edge-tts returned ' + dur.toFixed(2) + 's audio');
  return { path: out, bytes: buf.length, duration: dur };
}

async function fallbackEngineSynthesize(rawText: string, log: TtsLogger): Promise<{ engine: string; path: string; bytes: number; duration: number }> {
  const text = sanitizeForKokoroBase(rawText) || rawText;
  const elKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (elKey) {
    try {
      const r = await elevenLabsSynthesize(text, elKey);
      log('Fallback TTS success: ' + r.duration.toFixed(1) + 's via ElevenLabs');
      return { engine: 'elevenlabs', ...r };
    } catch (e) {
      log('ElevenLabs fallback failed: ' + (e as Error).message + ' - trying Edge TTS next');
    }
  }
  try {
    const r = await edgeTtsSynthesize(text);
    log('Fallback TTS success: ' + r.duration.toFixed(1) + 's via Edge TTS');
    return { engine: 'edge-tts', ...r };
  } catch (e) {
    log('Edge TTS fallback failed: ' + (e as Error).message);
    throw new Error('All TTS engines failed. ' + (elKey ? '' : 'No ELEVENLABS_API_KEY set. ') + 'Edge TTS: ' + (e as Error).message + '. Install once: pip install edge-tts');
  }
}

// ── Public preflight + debug ────────────────────────────────────────────
export interface PreflightResult {
  ok: boolean;
  engine: 'kokoro' | 'kokoro_unreachable' | 'silent';
  duration?: number;
  bytes?: number;
  reason?: string;
}

export async function runKokoroRenderPreflight(presetEdgeId?: string, log: TtsLogger = () => {}): Promise<PreflightResult> {
  const voice = pickKokoroVoiceForAttempt(presetEdgeId || '', 1);
  log('Preflight: synthesizing "This is a render test." via voice ' + voice);
  const r = await tryKokoroOnce('This is a render test.', voice, 1.0, log, 'preflight');
  if (r.ok) {
    try { fs.unlinkSync(r.path); } catch {}
    return { ok: true, engine: 'kokoro', duration: r.duration, bytes: r.bytes };
  }
  if (!r.reachable) return { ok: false, engine: 'kokoro_unreachable', reason: r.reason };
  return { ok: false, engine: 'silent', reason: r.reason };
}

export interface ChunkDebugReport {
  variant: string;
  textSent: string;
  voiceSent: string;
  ok: boolean;
  bytes?: number;
  duration?: number;
  outPath?: string;
  reason?: string;
}

export async function debugChunkSynthesis(rawText: string, presetEdgeId: string, log: TtsLogger = () => {}): Promise<ChunkDebugReport[]> {
  const debugDir = path.resolve('./debug/kokoro');
  try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}
  const stamp = Date.now();
  const reports: ChunkDebugReport[] = [];
  const variants: Array<{ name: string; text: string; voice: string }> = [
    { name: 'A_original',     text: rawText,                              voice: pickKokoroVoiceForAttempt(presetEdgeId, 1) },
    { name: 'B_sanitized',    text: sanitizeForKokoroBase(rawText),       voice: KOKORO_SAFEST_DEFAULT },
  ];
  const sentences = splitChunkIntoSentences(sanitizeForKokoroBase(rawText));
  if (sentences.length >= 1) variants.push({ name: 'C_split_first',  text: sentences[0], voice: KOKORO_SAFEST_DEFAULT });
  if (sentences.length >= 2) variants.push({ name: 'C_split_second', text: sentences[1], voice: KOKORO_SAFEST_DEFAULT });
  for (const v of variants) {
    const r = await tryKokoroOnce(v.text, v.voice, 1.0, log, 'debug ' + v.name);
    if (r.ok) {
      const dst = path.join(debugDir, 'chunk_' + stamp + '_' + v.name + '.wav');
      try { fs.copyFileSync(r.path, dst); } catch {}
      try { fs.unlinkSync(r.path); } catch {}
      reports.push({ variant: v.name, textSent: v.text, voiceSent: v.voice, ok: true, bytes: r.bytes, duration: r.duration, outPath: dst });
    } else {
      reports.push({ variant: v.name, textSent: v.text, voiceSent: v.voice, ok: false, reason: r.reason });
    }
  }
  return reports;
}

// ── Main generateVoice with preflight + engine fallback ─────────────────
export async function generateVoice(opts: GenerateVoiceOptions): Promise<{ buffer: Buffer; mimeType: string }> {
  const log: TtsLogger = opts.logger || (() => {});
  const preset = VOICE_PRESETS.find(p => p.id === opts.presetId) || readCustomPresets().find(p => p.id === opts.presetId);
  if (!preset) throw new Error('Unknown preset: ' + opts.presetId);
  const isCinematic = /cave_oracle|dungeon_wizard|cosmic_monk|dark_story|forbidden|shadow_prophet|gravel_king|ancient_librarian|ethereal|mythic|raspy|ancient_king|medieval_oracle|cave_prophet|dungeon_storyteller|old_warlock|cathedral_monk|gravel_knight|shadow_bard|elder_dragon|royal_seer|night_watchman|stone_temple|wandering_sage|dark_cosmos|flamekeeper|quiet_giant|old_kingdom/i.test(preset.id);
  const pauseCfg = (opts.royalPace && opts.royalPace > 0) ? pauseConfigFromRoyalPace(opts.royalPace) : (isCinematic ? CINEMATIC_PAUSES : DEFAULT_PAUSES);
  const prepared = prepareString(opts.text, pauseCfg);
  const speed = opts.speed !== undefined ? opts.speed : preset.defaults.speed;

  let chunks: PreparedChunk[];
  if (opts.preview) {
    const joinedText = prepared.ttsChunks.map(c => c.text).join(' ');
    const truncated = truncateForPreview(joinedText, 12, speed);
    chunks = [{ originalLineIndex: 0, text: formatScript(truncated), pauseAfterMs: 0 }];
  } else {
    chunks = buildKokoroChunks(prepared.ttsChunks, formatScript);
  }
  chunks = chunks.filter(c => c.text && c.text.trim().length > 0);
  if (chunks.length === 0) throw new Error('No non-empty text to synthesize.');
  log('Splitting script into ' + chunks.length + ' chunk(s) (max ' + MAX_CHUNK_CHARS + ' chars each)');

  const linePaths: string[] = [];
  const linePauses: number[] = [];
  const cleanup: string[] = [];
  const perChunkDur: number[] = [];
  try {
    let kokoroHealthy = true;
    if (!opts.preview) {
      log('Checking Kokoro real render synthesis...');
      const pre = await tryKokoroOnce('This is a render test.', pickKokoroVoiceForAttempt(preset.edgeId, 1), speed, log, 'preflight');
      if (pre.ok) {
        log('Kokoro real-synthesis preflight: ' + pre.duration.toFixed(2) + 's, ' + Math.round(pre.bytes / 1024) + 'KB - Kokoro healthy.');
        try { fs.unlinkSync(pre.path); } catch {}
      } else {
        kokoroHealthy = false;
        log(pre.reachable
          ? 'Kokoro real test failed: ' + pre.reason + ' - switching to fallback engine before render.'
          : 'Kokoro preflight: server unreachable - switching to fallback engine.');
      }
    }

    let usedFallbackEngine: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      let result: ChunkGenerationResult | null = null;
      if (kokoroHealthy) {
        try {
          result = await generateChunkWithRetry(chunks[i], preset.edgeId, speed, i + 1, chunks.length, log);
        } catch (e) {
          if (e instanceof Error && /unreachable/i.test(e.message)) {
            kokoroHealthy = false;
            log('Kokoro became unreachable mid-render - switching to fallback engine.');
          } else if (e instanceof ChunkSynthesisFailed) {
            kokoroHealthy = false;
            log('Kokoro could not synthesize chunk ' + e.chunkIndex + '/' + e.totalChunks + ' - switching to fallback engine.');
          } else {
            throw e;
          }
        }
      }
      if (!result) {
        const fb = await fallbackEngineSynthesize(chunks[i].text, log);
        usedFallbackEngine = fb.engine;
        result = { path: fb.path, durationSec: fb.duration, bytes: fb.bytes, attempts: 99 };
      }
      cleanup.push(result.path);
      linePaths.push(result.path);
      linePauses.push(chunks[i].pauseAfterMs);
      perChunkDur.push(result.durationSec);
    }
    if (usedFallbackEngine) log('Fallback TTS engine used: ' + usedFallbackEngine + ' - render continued with voice.');

    const sumChunkDur = perChunkDur.reduce((a, b) => a + b, 0);
    const sumPauseDur = linePauses.slice(0, -1).reduce((a, b) => a + b, 0) / 1000;
    log('Merging ' + chunks.length + ' chunk(s), expected total ~ ' + (sumChunkDur + sumPauseDur).toFixed(2) + 's');
    const concatPath = tmpAudioFile('.wav');
    cleanup.push(concatPath);
    await concatWithPauses(linePaths, linePauses, concatPath);
    const concatDur = await probeDurationRobust(concatPath, log);
    if (concatDur < MIN_CHUNK_DURATION_SEC) throw new Error('Concat produced ' + concatDur.toFixed(2) + 's of audio from ' + linePaths.length + ' chunks.');
    log('Merged audio duration: ' + concatDur.toFixed(2) + 's');

    const presetSliders = (preset as { sliders?: { throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number } }).sliders || {};
    const finalPath = tmpAudioFile('.mp3');
    cleanup.push(finalPath);
    if (opts.safeMode) {
      log('Safe mode: skipping FX chain');
      await applyAudioFX(concatPath, finalPath, {
        pitch: 0, rate: 0, speed: 1.0, volume: 0, intensity: 0,
        eq: 'none', reverb: false, robot: false,
        throatDepth: 0, ancientRasp: 0, royalPace: 0, chamberSpace: 0,
      });
    } else {
      const fxOpts: PostProcessOptions = {
        pitch:     opts.pitch     !== undefined ? opts.pitch     : preset.defaults.pitch,
        rate:      opts.rate      !== undefined ? opts.rate      : preset.defaults.rate,
        speed:     opts.speed     !== undefined ? opts.speed     : preset.defaults.speed,
        volume:    opts.volume    !== undefined ? opts.volume    : preset.defaults.volume,
        intensity: opts.intensity !== undefined ? opts.intensity : preset.defaults.intensity,
        eq:        preset.eq,
        reverb:    preset.reverb,
        robot:     preset.robot,
        throatDepth:  opts.throatDepth  !== undefined ? opts.throatDepth  : (presetSliders.throatDepth  || 0),
        ancientRasp:  opts.ancientRasp  !== undefined ? opts.ancientRasp  : (presetSliders.ancientRasp  || 0),
        royalPace:    opts.royalPace    !== undefined ? opts.royalPace    : (presetSliders.royalPace    || 0),
        chamberSpace: opts.chamberSpace !== undefined ? opts.chamberSpace : (presetSliders.chamberSpace || 0),
      };
      await applyAudioFX(concatPath, finalPath, fxOpts);
    }
    const finalDur = await probeDurationRobust(finalPath, log);
    if (finalDur < MIN_CHUNK_DURATION_SEC) throw new Error('Final post-FX audio is ' + finalDur.toFixed(2) + 's - try Force Working Voice Render.');
    log('Final voice audio: ' + finalDur.toFixed(2) + 's' + (opts.safeMode ? ' (safe mode)' : ''));
    const buffer = fs.readFileSync(finalPath);
    return { buffer, mimeType: 'audio/mpeg' };
  } finally {
    for (const f of cleanup) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

// ── Force Working Voice Render ──────────────────────────────────────────
export async function forceWorkingVoiceRender(text: string, log: TtsLogger = (l: string) => console.log('[FORCE]', l)): Promise<{ buffer: Buffer; mimeType: string; engine: string }> {
  log('Force Working Voice Render - bypassing custom Kokoro preset');
  const prepared = prepareString(text, DEFAULT_PAUSES);
  const chunkSpecs = buildKokoroChunks(prepared.ttsChunks, formatScript);
  const cleanup: string[] = [];
  const linePaths: string[] = [];
  const linePauses: number[] = [];
  let engineUsed = 'kokoro_default';
  try {
    for (let i = 0; i < chunkSpecs.length; i++) {
      const chunk = chunkSpecs[i];
      const safeText = sanitizeForKokoroBase(chunk.text);
      const r = await tryKokoroOnce(safeText, KOKORO_SAFEST_DEFAULT, 1.0, log, 'force chunk ' + (i + 1));
      let p: string;
      if (r.ok) { p = r.path; }
      else {
        const fb = await fallbackEngineSynthesize(safeText, log);
        engineUsed = fb.engine;
        p = fb.path;
      }
      cleanup.push(p);
      linePaths.push(p);
      linePauses.push(chunk.pauseAfterMs);
    }
    const merged = tmpAudioFile('.mp3');
    cleanup.push(merged);
    await concatWithPauses(linePaths, linePauses, merged);
    const buf = fs.readFileSync(merged);
    return { buffer: buf, mimeType: 'audio/mpeg', engine: engineUsed };
  } finally {
    for (const f of cleanup) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

// ── Force Working Voice Render ──────────────────────────────────────────
// Skips broken Kokoro custom presets entirely. Tries Kokoro with the safest
// default voice; if that fails, escalates straight to the engine fallback
// chain (ElevenLabs → Edge TTS). Always produces a usable mp3 buffer.
export async function forceWorkingVoiceRender(
  text: string,
  log: TtsLogger = (l: string) => console.log('[FORCE]', l),
): Promise<{ buffer: Buffer; mimeType: string; engine: string }> {
  log('Force Working Voice Render - bypassing custom Kokoro preset');
  const prepared = prepareString(text, DEFAULT_PAUSES);
  const chunkSpecs = buildKokoroChunks(prepared.ttsChunks, formatScript);
  const cleanup: string[] = [];
  const linePaths: string[] = [];
  const linePauses: number[] = [];
  let engineUsed = 'kokoro_default';
  try {
    for (let i = 0; i < chunkSpecs.length; i++) {
      const chunk = chunkSpecs[i];
      const safeText = sanitizeForKokoroBase(chunk.text);
      const r = await tryKokoroOnce(safeText, KOKORO_SAFEST_DEFAULT, 1.0, log, 'force chunk ' + (i + 1));
      let p: string;
      if (r.ok) { p = r.path; }
      else {
        const fb = await fallbackEngineSynthesize(safeText, log);
        engineUsed = fb.engine;
        p = fb.path;
      }
      cleanup.push(p);
      linePaths.push(p);
      linePauses.push(chunk.pauseAfterMs);
    }
    const merged = tmpAudioFile('.mp3');
    cleanup.push(merged);
    await concatWithPauses(linePaths, linePauses, merged);
    const buf = fs.readFileSync(merged);
    return { buffer: buf, mimeType: 'audio/mpeg', engine: engineUsed };
  } finally {
    for (const f of cleanup) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}
