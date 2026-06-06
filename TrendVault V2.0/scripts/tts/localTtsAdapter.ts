/**
 * Kokoro TTS Adapter
 */

import * as fs from 'fs';

export interface LocalTtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  outPath: string;
  timeoutMs?: number;
}

export interface LocalTtsResult {
  outPath: string;
  mimeType: string;
  bytes: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:5070';
const DEFAULT_TIMEOUT_MS = 600000;

function baseUrl(): string {
  return (process.env.LOCAL_TTS_URL || DEFAULT_BASE_URL).trim();
}

export class KokoroTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KokoroTimeoutError';
  }
}

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = (cause && cause.code) || '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
    return true;
  }
  const msg = err.message.toLowerCase();
  return msg.indexOf('econnrefused') >= 0 || msg === 'fetch failed';
}

export async function generateVoiceLocal(req: LocalTtsRequest): Promise<LocalTtsResult | null> {
  const url = new URL('/tts', baseUrl());
  const timeoutMs = req.timeoutMs !== undefined ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text, voice: req.voice, speed: req.speed !== undefined ? req.speed : 1.0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isConnectionRefused(err)) return null;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new KokoroTimeoutError(
        'Kokoro TTS request timed out after ' + Math.round(timeoutMs / 1000) + 's for ' + req.text.length + ' chars'
      );
    }
    const msg = (err instanceof Error ? err.message : String(err)) || 'unknown';
    throw new Error('Kokoro TTS request failed: ' + msg);
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error('Kokoro TTS returned HTTP ' + res.status + (body ? ': ' + body : ''));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(req.outPath, buf);
  return { outPath: req.outPath, mimeType: res.headers.get('content-type') || 'audio/wav', bytes: buf.length };
}

export async function probeLocalTts(): Promise<{ ok: boolean; engine?: 'kokoro'; url?: string }> {
  const url = baseUrl();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { ok: res.ok || res.status === 404, engine: 'kokoro', url };
  } catch {
    return { ok: false };
  }
}

export async function probeKokoroAlive(): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  const url = new URL('/tts', baseUrl());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test.', voice: 'en-US-JennyNeural', speed: 1.0 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { ok: false, reason: 'response too small (' + buf.length + ' bytes)', bytes: buf.length };
    return { ok: true, bytes: buf.length };
  } catch (err) {
    if (isConnectionRefused(err)) return { ok: false, reason: 'connection refused' };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

export async function waitForKokoroReady(
  options: { maxMs?: number; intervalMs?: number; logger?: (line: string) => void } = {},
): Promise<{ ready: boolean; elapsedMs: number; lastReason?: string }> {
  const maxMs = options.maxMs !== undefined ? options.maxMs : 60000;
  const intervalMs = options.intervalMs !== undefined ? options.intervalMs : 2000;
  const log = options.logger || (() => {});
  const start = Date.now();
  let attempt = 0;
  let lastReason: string | undefined;
  while (Date.now() - start < maxMs) {
    attempt++;
    const probe = await probeKokoroAlive();
    if (probe.ok) {
      const elapsed = Date.now() - start;
      log('Kokoro ready (attempt ' + attempt + ', ' + elapsed + 'ms, test audio ' + probe.bytes + ' bytes)');
      return { ready: true, elapsedMs: elapsed };
    }
    lastReason = probe.reason;
    log('Kokoro not ready (attempt ' + attempt + '): ' + (probe.reason || 'unknown') + ' - retrying in ' + Math.round(intervalMs / 1000) + 's');
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ready: false, elapsedMs: Date.now() - start, lastReason };
}
