---
name: diagnose-voice-pipeline
description: Use this skill whenever the user reports voice problems in the Trend Vault studio — Kokoro isn't connecting, the voice sounds wrong, the preview doesn't match the rendered audio, a slider has no audible effect, or any other audio-pipeline weirdness. The studio is Kokoro-only; there is no Edge/ElevenLabs/Piper fallback. Trigger on phrases like "voice not working", "kokoro broken", "no audio", "voice timed out", "preview doesn't match render", "audio pipeline issue", "sliders don't change anything".
---

# Diagnose the voice pipeline

The pipeline has four stages. Walk them in order — the first stage that fails is the bug.

## Stage 1: Kokoro server reachable?

```
http://localhost:5070/
```

Should return `{"ok": true, "engine": "kokoro", "model": "kokoro-v0_19.onnx", ...}`. If not:
- Server isn't running → click **Start Kokoro TTS** in the launcher, or run `start-kokoro.bat`. Wait for `Running on http://127.0.0.1:5070`.
- Server crashed → look in its console window for a Python traceback.
- Model missing → `setup-kokoro.bat` (idempotent; re-downloads only what's missing).

## Stage 2: Node server can reach Kokoro?

```
http://localhost:3001/api/trend-vault/engine-status
```

Should return `localTts: { ok: true, engine: "kokoro", url: "http://localhost:5070" }`.

If `localTts.ok: false` here even though Stage 1 passed:
- Node started before Kokoro → restart the Node server (close the cmd window + Start Web App in the launcher).
- `LOCAL_TTS_URL` mis-set in `.env` → confirm it's `http://localhost:5070`. Default is the same, so removing it works too.

## Stage 3: Preset → Kokoro voice mapping

`scripts/tts/voicePresets.json` presets carry an `edgeId` (legacy field, e.g. `en-US-DavisNeural`). The Kokoro server (`kokoro-tts/kokoro_server.py`) maps these via `VOICE_MAP` to Kokoro voice ids (`am_adam`, `af_bella`, etc.). If a preset has a brand-new `edgeId` that isn't in the map, the server falls back to `af_bella`.

Fix: add the mapping in `VOICE_MAP` and restart Kokoro.

## Stage 4: Cinematic slider effect

Where: `scripts/tts/audioPostProcess.ts` `buildFilterChain()`.

The 4 sliders (`throatDepth`, `ancientRasp`, `royalPace`, `chamberSpace`) fold into the FFmpeg chain. If a slider has no audible effect:
- Check `getVoiceParams()` in `trend-vault.html` — does it include the slider?
- Check the server preview endpoint (`/api/trend-vault/voice-preview`) — does it forward the slider to `generateVoice`?
- Check `ttsService.generateVoice` — does it pass it to `applyAudioFX`?
- All three points were wired in the cinematic-narrator overhaul. If a link is broken, something regressed recently.

## Preview vs render mismatch

Preview and render both call `generateVoice()` with the same params. If they differ:
- Browser cached an old preview → the URL has `?_=Date.now()`; force-refresh anyway.
- `audioEl.load()` is called explicitly after setting `src` — verify.
- Different params on render → check `state.voice` (the preset+sliders bundle) is in the render request body.

## How to report findings

Surface the **failed stage** and the one-line fix. Don't dump every check — just the cause.
