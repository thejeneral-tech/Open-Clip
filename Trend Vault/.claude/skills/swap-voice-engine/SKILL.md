---
name: swap-voice-engine
description: Use this skill when the user wants to change how voices are produced — adjust the Kokoro server, swap voice presets, or troubleshoot the local TTS pipeline. The studio is Kokoro-only; there is no Edge / ElevenLabs / Piper fallback. Trigger on "switch voice", "voice engine broken", "use a different voice", "kokoro mapping", "voice not playing".
---

# Voice engine — Kokoro only

The Trend Vault studio uses one TTS engine: the local **Kokoro** Python server in `kokoro-tts/`.
ElevenLabs, Microsoft Edge TTS, and Piper have all been removed. There is **no fallback** — if Kokoro isn't running, voice generation fails with a clear error pointing at `start-kokoro.bat`.

## Where the wiring lives

- `kokoro-tts/kokoro_server.py` — Flask server on `:5070`. The `VOICE_MAP` dict at the top translates the legacy Edge Neural ids stored in `voicePresets.json` (`en-US-DavisNeural`, etc.) to Kokoro voices (`am_adam`, `af_bella`, …). Add a new mapping there if you wire up a preset with a `edgeId` not already covered.
- `scripts/tts/localTtsAdapter.ts` — thin HTTP client that posts `{ text, voice, speed }` to `/tts`. If the server is unreachable it returns null.
- `scripts/tts/ttsService.ts` — the only TTS entry point. Calls Kokoro and throws a "start the Kokoro server" error on failure.
- `server.ts` — `/api/trend-vault/generate-voice`, `/api/trend-vault/voice-preview`, and the render path all flow through `ttsService.generateVoice()`. No engine selection logic exists.
- `frontend/trend-vault.html` — no engine chips, no per-engine UI. Voice preset grid + sliders only.

## Common tasks

**The voice doesn't play / preview fails.**
1. Check the launcher's Kokoro card — green dot means port 5070 is bound.
2. Hit `http://127.0.0.1:5070/` directly; should return `{"ok":true,"engine":"kokoro",…}`.
3. Look in the Kokoro console window for Python tracebacks.
4. If the model file is missing the server logs it on boot — run `setup-kokoro.bat`.

**A preset sounds wrong / the wrong Kokoro voice plays.**
The preset's `edgeId` in `scripts/tts/voicePresets.json` is the lookup key. Open `kokoro-tts/kokoro_server.py` and update `VOICE_MAP[<edgeId>]` to a different Kokoro voice. The valid Kokoro voices for v0.19 are: `af_bella`, `af_sarah`, `af_nicole`, `af_sky`, `am_adam`, `am_michael`, `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis`. Restart Kokoro after editing.

**Adding a brand-new preset.**
Append to `voicePresets.json` with a `edgeId` that's already in `VOICE_MAP`. Easiest: pick an existing preset whose voice you want to clone, copy its `edgeId`.

**A preset with a brand-new `edgeId` was added (e.g. from MP3 Voice Editor).**
Add an entry to `VOICE_MAP`; otherwise the preset falls back to `af_bella`.

## What NOT to do

- Don't reintroduce `node-edge-tts`, ElevenLabs, or Piper "as a fallback." The user explicitly removed them. Voice failures should surface a clear "start Kokoro" error, not silently degrade.
- Don't add `voiceEngine` back to API request bodies or `state` — every consumer was simplified to assume Kokoro.
- Don't add a `LOCAL_TTS_ENGINE` env var; the adapter is hard-coded to speak the Kokoro `POST /tts` protocol.
