/**
 * TTS Engine Manager - Kokoro-only ladder with voice fallback
 */

import * as fs from 'fs';
import { generateVoiceLocal, KokoroTimeoutError } from './localTtsAdapter';
import { probeAudioDurationSec, tmpAudioFile } from './audioPostProcess';

export type TtsLogger = (line: string) => void;

export interface TtsEngine {
  name: string;
  probe(): Promise<{ ok: boolean; reason?: string }>;
  synthesizeChunk(text: string, outPath: string): Promise<{ bytes: number; durationSec: number }>;
}

export const MAX_CHUNK_CHARS = 160;
export const MIN_CHUNK_DURATION_SEC = 0.2;
export const MIN_CHUNK_BYTES = 2000;
export const MIN_FINAL_DURATION_SEC = 1.0;
export const RETRIES_PER_CHUNK_PER_ENGINE = 3;

export function sanitizeAttempt1(input: string): string {
  let s = input;
  s = s.replace(/\u2026/g, '. ');
  s = s.replace(/\.{2,}/g, '. ');
  s = s.replace(/\s*[\u2014\u2013]\s*/g, ', ');
  s = s.replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/[*_~`#]+/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) return s;
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

export function sanitizeAttempt2(input: string): string {
  let s = sanitizeAttempt1(input);
  const contractions: [RegExp, string][] = [
    [/\bdon't\b/gi, 'do not'], [/\bdoesn't\b/gi, 'does not'], [/\bdidn't\b/gi, 'did not'],
    [/\bwon't\b/gi, 'will not'], [/\bwouldn't\b/gi, 'would not'], [/\bshouldn't\b/gi, 'should not'],
    [/\bcouldn't\b/gi, 'could not'], [/\bcan't\b/gi, 'cannot'], [/\bisn't\b/gi, 'is not'],
    [/\bwasn't\b/gi, 'was not'], [/\baren't\b/gi, 'are not'], [/\bweren't\b/gi, 'were not'],
    [/\bhasn't\b/gi, 'has not'], [/\bhaven't\b/gi, 'have not'], [/\bthat's\b/gi, 'that is'],
    [/\bit's\b/gi, 'it is'], [/\bthey're\b/gi, 'they are'], [/\byou're\b/gi, 'you are'],
    [/\bwe're\b/gi, 'we are'], [/\bI'm\b/g, 'I am'], [/\bI've\b/g, 'I have'],
    [/\bI'll\b/g, 'I will'], [/\bI'd\b/g, 'I would'],
  ];
  for (const [pat, rep] of contractions) s = s.replace(pat, rep);
  s = s.replace(/[^\x20-\x7E]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) return s;
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

export function sanitizeAttempt3(input: string): string {
  let s = sanitizeAttempt2(input);
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9 .,!?']/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) return s;
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

export function splitForKokoro(text: string): string[] {
  const out: string[] = [];
  if (!text || !text.trim()) return out;
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?\u2026])\s+|\.{2,}\s+/).map(s => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHUNK_CHARS) { out.push(sentence); continue; }
    const words = sentence.split(/\s+/);
    let buf = '';
    for (const w of words) {
      if (!buf) { buf = w; continue; }
      if (buf.length + 1 + w.length > MAX_CHUNK_CHARS) { out.push(buf); buf = w; }
      else { buf += ' ' + w; }
    }
    if (buf) out.push(buf);
  }
  return out;
}

export class KokoroEngine implements TtsEngine {
  public readonly name: string;
  private readonly voice: string;
  private readonly speed: number;
  constructor(displayName: string, voice: string, speed: number) {
    this.name = displayName; this.voice = voice; this.speed = speed;
  }
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    const outPath = tmpAudioFile('.wav');
    try {
      const res = await generateVoiceLocal({
        text: 'This is a render test.', voice: this.voice, speed: this.speed,
        outPath, timeoutMs: 30000,
      });
      if (!res) return { ok: false, reason: 'Kokoro server unreachable (connection refused)' };
      if (res.bytes < MIN_CHUNK_BYTES) return { ok: false, reason: 'test audio too small (' + res.bytes + ' bytes)' };
      const dur = await probeAudioDurationSec(outPath);
      if (dur < 0.5) return { ok: false, reason: 'test audio duration ' + dur.toFixed(2) + 's (< 0.5s)' };
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    } finally {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    }
  }
  async synthesizeChunk(text: string, outPath: string): Promise<{ bytes: number; durationSec: number }> {
    const res = await generateVoiceLocal({ text, voice: this.voice, speed: this.speed, outPath });
    if (!res) throw new Error('Kokoro server unreachable');
    if (res.bytes < MIN_CHUNK_BYTES) throw new Error('audio too small (' + res.bytes + ' bytes)');
    const dur = await probeAudioDurationSec(outPath);
    if (dur < MIN_CHUNK_DURATION_SEC) throw new Error('audio too short (' + dur.toFixed(2) + 's)');
    return { bytes: res.bytes, durationSec: dur };
  }
}

export { KokoroTimeoutError };

export interface ChunkPlan {
  originalLineIndex: number;
  text: string;
  pauseAfterMs: number;
}

export interface OrchestrationOk {
  ok: true;
  engineUsed: string;
  chunkPaths: string[];
  perChunkDurations: number[];
  pauseAfterMs: number[];
}

export interface OrchestrationFail {
  ok: false;
  reasons: string[];
}

export type OrchestrationResult = OrchestrationOk | OrchestrationFail;

export async function orchestrateScript(
  chunks: ChunkPlan[],
  engines: TtsEngine[],
  log: TtsLogger,
): Promise<OrchestrationResult> {
  const reasons: string[] = [];
  if (engines.length === 0) return { ok: false, reasons: ['No TTS engines configured'] };
  for (let ei = 0; ei < engines.length; ei++) {
    const engine = engines[ei];
    log('Trying engine ' + (ei + 1) + '/' + engines.length + ': ' + engine.name);
    log('  Probing ' + engine.name + ' with real synthesis test...');
    const probe = await engine.probe();
    if (!probe.ok) {
      const why = engine.name + ' failed real synthesis test: ' + (probe.reason || 'unknown');
      log('  ' + why);
      reasons.push(why);
      continue;
    }
    log('  ' + engine.name + ' passed real synthesis test');
    const chunkPaths: string[] = [];
    const chunkDur: number[] = [];
    const chunkPauses: number[] = [];
    let engineFailed = false;
    let engineFailReason = '';
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const label = 'chunk ' + (ci + 1) + '/' + chunks.length + ' (engine ' + engine.name + ')';
      let chunkOk = false;
      let lastErr = '';
      for (let attempt = 1; attempt <= RETRIES_PER_CHUNK_PER_ENGINE; attempt++) {
        const sanitized =
          attempt === 1 ? sanitizeAttempt1(chunk.text) :
          attempt === 2 ? sanitizeAttempt2(chunk.text) :
                          sanitizeAttempt3(chunk.text);
        if (!sanitized) { lastErr = 'empty text after sanitize'; continue; }
        const outPath = tmpAudioFile('.wav');
        try {
          const r = await engine.synthesizeChunk(sanitized, outPath);
          log('  ' + label + ' attempt ' + attempt + ': ' + r.durationSec.toFixed(2) + 's, ' + Math.round(r.bytes / 1024) + 'KB');
          chunkPaths.push(outPath);
          chunkDur.push(r.durationSec);
          chunkPauses.push(chunk.pauseAfterMs);
          chunkOk = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          log('  ' + label + ' attempt ' + attempt + ' FAILED: ' + lastErr);
          try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
          if (/server unreachable/i.test(lastErr) || /connection refused/i.test(lastErr)) break;
        }
      }
      if (!chunkOk) {
        engineFailed = true;
        engineFailReason = engine.name + ' failed ' + label + ': ' + lastErr + ' | text: "' + chunk.text.slice(0, 60) + '"';
        log('  ' + engineFailReason);
        log('  Abandoning ' + engine.name + ' and trying next engine...');
        break;
      }
    }
    if (engineFailed) {
      for (const p of chunkPaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
      reasons.push(engineFailReason);
      continue;
    }
    log('  ' + engine.name + ' synthesized all ' + chunks.length + ' chunks successfully');
    return { ok: true, engineUsed: engine.name, chunkPaths, perChunkDurations: chunkDur, pauseAfterMs: chunkPauses };
  }
  return { ok: false, reasons };
}
