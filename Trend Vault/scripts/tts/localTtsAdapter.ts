/**
 * Kokoro TTS Adapter
 * ─────────────────────────────────────────────────────────────────────────────
 * Talks to the local Kokoro HTTP server (Trend Vault/kokoro-tts/kokoro_server.py).
 *
 * Setup is a single-time `setup-kokoro.bat`; daily use is `start-kokoro.bat`
 * or the Kokoro card in the launcher. The server listens on
 * http://127.0.0.1:5070 by default; override with LOCAL_TTS_URL in .env.
 *
 * If the server isn't reachable this returns null and the caller surfaces a
 * clear "start kokoro" error — there is no Edge / ElevenLabs / Piper fallback.
 */

import * as fs from 'fs';

export interface LocalTtsRequest {
  text:    string;
  voice?:  string;     // Edge Neural id (mapped by the Kokoro server) or raw Kokoro id
  speed?:  number;     // 0.5-2.0
  outPath: string;     // where to write the WAV/MP3
}

export interface LocalTtsResult {
  outPath:  string;
  mimeType: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:5070';

function baseUrl(): string {
  return (process.env.LOCAL_TTS_URL || DEFAULT_BASE_URL).trim();
}

/**
 * Synthesize via the local Kokoro server.
 * Returns null if the server is unreachable — caller is responsible for the
 * "start the kokoro server" error message.
 */
export async function generateVoiceLocal(req: LocalTtsRequest): Promise<LocalTtsResult | null> {
  let res: Response;
  try {
    res = await fetch(new URL('/tts', baseUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text, voice: req.voice, speed: req.speed ?? 1.0 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return null; // Connection refused, timeout, etc.
  }
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(req.outPath, buf);
  return { outPath: req.outPath, mimeType: res.headers.get('content-type') || 'audio/wav' };
}

/**
 * Health probe used by the studio status dashboard.
 */
export async function probeLocalTts(): Promise<{ ok: boolean; engine?: 'kokoro'; url?: string }> {
  const url = baseUrl();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { ok: res.ok || res.status === 404, engine: 'kokoro', url };
  } catch {
    return { ok: false };
  }
}
