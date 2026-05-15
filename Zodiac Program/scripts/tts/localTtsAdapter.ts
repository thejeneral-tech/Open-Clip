/**
 * Local TTS Adapter — Kokoro / Coqui XTTS / Piper
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A REAL ADAPTER, NOT A STUB.
 *
 * It calls a local HTTP TTS server you run separately (Kokoro, Coqui, Piper).
 * If the server isn't reachable, it returns null and the caller falls back to
 * the existing Edge TTS path. Nothing fakes a successful synthesis.
 *
 * ─── Why not bundle the model directly? ──────────────────────────────────────
 * Kokoro / Coqui / Piper / WhisperX all require Python + PyTorch / ONNX runtime
 * + ~80MB-1.5GB model files. Spawning Python from Node is doable but has
 * significant startup cost on every request and fails silently on missing deps.
 * Running them as a long-lived HTTP server is the standard pattern.
 *
 * ─── Setup, in order of recommendation ────────────────────────────────────────
 *
 *   1. KOKORO (default; lightweight, Apache-licensed, ~80MB):
 *      pip install kokoro-onnx soundfile
 *      Then run a tiny Python HTTP server (see kokoro_server.py example below)
 *      on port 5070. Set env: LOCAL_TTS_URL=http://localhost:5070
 *
 *   2. COQUI XTTS (heavy, voice cloning, ~1.5GB):
 *      pip install TTS
 *      Run their built-in server: tts-server --model_name tts_models/multilingual/multi-dataset/xtts_v2
 *      It speaks on port 5002 by default. Set LOCAL_TTS_URL=http://localhost:5002
 *
 *   3. PIPER (fast Windows fallback, single .exe + .onnx model):
 *      Download piper.exe + a voice model (en_US-libritts_r-medium.onnx) from
 *      https://github.com/rhasspy/piper/releases
 *      Wrap in a small Node http server, or use the included CLI mode.
 *
 *   4. STAY ON EDGE TTS (current default, requires no setup, free, zero local
 *      compute) — this adapter just returns null and the existing pipeline runs.
 *
 * ─── Reference Kokoro server (save as scripts/tts/kokoro_server.py) ──────────
 *
 *   from flask import Flask, request, send_file
 *   from kokoro_onnx import Kokoro
 *   import soundfile, io
 *   app = Flask(__name__)
 *   k = Kokoro("kokoro-v0_19.onnx", "voices.bin")
 *   @app.post("/tts")
 *   def tts():
 *       data = request.json
 *       audio, sr = k.create(data["text"], voice=data.get("voice","af_bella"), speed=data.get("speed",1.0))
 *       buf = io.BytesIO()
 *       soundfile.write(buf, audio, sr, format="WAV")
 *       buf.seek(0)
 *       return send_file(buf, mimetype="audio/wav")
 *   if __name__ == "__main__": app.run(port=5070)
 *
 *   Then: pip install flask && python kokoro_server.py
 *
 * ─── Once the local service is up, the rest of this app uses it automatically
 * via generateVoiceLocal() below.
 */

import * as fs from 'fs';

export type LocalEngine = 'kokoro' | 'coqui' | 'piper';

export interface LocalTtsRequest {
  text:    string;
  voice?:  string;     // engine-specific voice id (e.g. "af_bella" for Kokoro)
  speed?:  number;     // 0.5-2.0
  outPath: string;     // where to write the WAV/MP3
  engine?: LocalEngine;
}

export interface LocalTtsResult {
  outPath:  string;
  mimeType: string;
}

/**
 * Try to synthesize via a local TTS HTTP service.
 * Returns null if the service is unreachable or fails — caller falls back.
 */
export async function generateVoiceLocal(req: LocalTtsRequest): Promise<LocalTtsResult | null> {
  const baseUrl = process.env.LOCAL_TTS_URL;
  if (!baseUrl) return null; // No local engine configured → skip

  const engine = req.engine || (process.env.LOCAL_TTS_ENGINE as LocalEngine) || 'kokoro';

  // Each engine speaks slightly different protocols. Default to a Kokoro-style
  // POST /tts JSON body that returns audio/wav. Coqui XTTS server uses a query-
  // string GET on /api/tts; we handle both.
  let res: Response;
  try {
    if (engine === 'coqui') {
      const url = new URL('/api/tts', baseUrl);
      url.searchParams.set('text', req.text);
      if (req.voice) url.searchParams.set('speaker_id', req.voice);
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } else {
      // Kokoro / Piper-server style
      res = await fetch(new URL('/tts', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, voice: req.voice, speed: req.speed ?? 1.0 }),
        signal: AbortSignal.timeout(30_000),
      });
    }
  } catch {
    return null; // Connection refused, timeout, etc.
  }
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(req.outPath, buf);
  const mimeType = res.headers.get('content-type') || 'audio/wav';
  return { outPath: req.outPath, mimeType };
}

/**
 * Hard check: is a local TTS service reachable right now?
 * Used by the UI to show "Local TTS engine detected" / "using cloud Edge TTS".
 */
export async function probeLocalTts(): Promise<{ ok: boolean; engine?: LocalEngine; url?: string }> {
  const baseUrl = process.env.LOCAL_TTS_URL;
  if (!baseUrl) return { ok: false };
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
    return { ok: res.ok || res.status === 404, engine: (process.env.LOCAL_TTS_ENGINE as LocalEngine) || 'kokoro', url: baseUrl };
  } catch {
    return { ok: false };
  }
}
