---
name: diagnose-voice-pipeline
description: Use this skill whenever the user reports voice problems in the Zodiac studio — the voice sounds robotic, kokoro isn't connecting, edge TTS keeps timing out, the preview doesn't match the rendered audio, the wrong engine is being used, the voice slider has no audible effect, or any other audio-pipeline weirdness. Trigger on phrases like "voice not working", "still hearing edge tts", "kokoro broken", "voice timed out", "preview doesn't match render", "audio pipeline issue", "the new sliders don't change anything", or anyone asking "why is my voice X". Use proactively the moment a voice issue is mentioned, before guessing.
---

# Diagnose the voice pipeline

The pipeline has six stages. Walk them in order — the first stage that fails is the bug.

## Stage 1: Engine selection in the UI

Where: `state.voiceEngine` in `frontend/zodiac.html` (default `'auto'`).

- `'auto'` → try local first, fall back to Edge TTS
- `'local'` → local only, throws a clear error if Kokoro is down
- `'edge'` → always Edge TTS, skips local entirely

If user said "I clicked Local Only and got a clear error", they're correctly diagnosing — go to stage 3. If user is in `auto` and "still hearing Edge", it means stage 3 is silently falling back. Check stage 2 first.

## Stage 2: Node server `.env` loading

The Node process reads `.env` **once at startup**.

```
http://localhost:3001/api/zodiac/engine-status
```

Should return `localTts.ok: true, engine: "kokoro", url: "http://localhost:5070"`.

If `localTts: { ok: false }` here, `LOCAL_TTS_URL` is not in the Node process's environment. Either:
- It's missing from `.env` → add `LOCAL_TTS_URL=http://localhost:5070` and `LOCAL_TTS_ENGINE=kokoro`
- Node was started before `.env` was edited → restart Node

## Stage 3: Kokoro server reachability

```
http://localhost:5070/
```

Should return `{"ok": true, "engine": "kokoro"}`. If not, Kokoro isn't running. Run `start-kokoro.bat` and wait for `Running on http://127.0.0.1:5070`.

## Stage 4: Preset → engine voice mapping

`scripts/tts/voicePresets.json` voices use Edge IDs like `en-US-DavisNeural`. The Kokoro server (`kokoro-tts/kokoro_server.py`) maps these to Kokoro voice ids in its `VOICE_MAP`. If a preset was added with a new Edge ID that isn't in the map, the server falls back to `af_bella`. To add new mappings, edit the dict in `kokoro_server.py` and restart Kokoro.

## Stage 5: Cinematic slider effect

Where: `scripts/tts/audioPostProcess.ts` `buildFilterChain()`.

The 4 sliders (`throatDepth`, `ancientRasp`, `royalPace`, `chamberSpace`) are folded into the FFmpeg chain. If a slider has no audible effect:
- Check `getVoiceParams()` in `zodiac.html` — does it include the slider?
- Check the server preview endpoint — does it forward the slider to `generateVoice`?
- Check `ttsService.generateVoice` — does it pass it to `applyAudioFX`?
- All three points were wired in the cinematic-narrator overhaul. If any link is broken, the change recently regressed.

## Stage 6: Preview vs render mismatch

The preview and render call the SAME `generateVoice()` with the SAME params. If they differ:
- Browser cached an old preview → cache-buster `?_=Date.now()` is already on the URL; force-refresh anyway.
- The audio element didn't reload → `audioEl.load()` is called explicitly after setting `src`.
- The render uses different params → check `getVoiceParams()` is included in render settings (`state.voice` is sent in render request).

## How to report findings

After running the diagnosis, tell the user the **exact failed stage**, what's broken, and the one-line fix. Don't dump every check — surface the actual cause.
