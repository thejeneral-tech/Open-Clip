---
name: swap-voice-engine
description: Use this skill when the user wants to switch the voice engine — between local Kokoro and Microsoft Edge TTS, force Kokoro only, get rid of Edge, set up a new local TTS server like Coqui or Piper, or change which engine handles a specific render. Trigger on phrases like "switch to kokoro", "stop using edge tts", "force local voices", "use coqui instead", "swap to piper", "rip out microsoft voices for real this time".
---

# Swap the voice engine

The Zodiac project supports three voice engine modes selected via UI chip in the Voice Preset card:

| Mode | Behavior |
|---|---|
| `auto` (default) | Try the local TTS server first; if it fails, fall back to Edge TTS |
| `local` | Local TTS only; if no local server is reachable, surface a clear error |
| `edge` | Always use Microsoft Edge TTS (cloud); skip the local server |

The wiring lives in:
- `frontend/zodiac.html` — `state.voiceEngine` chip handlers
- `server.ts` — engine forwarded into `generateVoice`
- `scripts/tts/ttsService.ts` — engine selection logic
- `scripts/tts/localTtsAdapter.ts` — HTTP adapter for local engines

## To make a clean switch FROM Edge TO Kokoro

1. Run `setup-kokoro.bat` once (creates a Python venv + installs Kokoro + downloads model).
2. Run `start-kokoro.bat` to launch the Kokoro server on port 5070.
3. Edit `.env` to include:
   ```
   LOCAL_TTS_URL=http://localhost:5070
   LOCAL_TTS_ENGINE=kokoro
   ```
4. Restart the Node server (must read updated `.env`).
5. In the studio, click the **🏠 Local Only** chip. Voice card's status line should turn green with `Local TTS: kokoro @ http://localhost:5070`.
6. Click ▶ PREVIEW. The MP3 played is now coming from Kokoro, fully bypassing Microsoft.

## To swap Kokoro for Coqui XTTS or Piper

The adapter speaks two protocols — Kokoro-style (`POST /tts` JSON) and Coqui XTTS-style (`GET /api/tts?text=...`).

For **Coqui XTTS**:
1. `pip install TTS`
2. Run their built-in server: `tts-server --model_name tts_models/multilingual/multi-dataset/xtts_v2` (port 5002 by default)
3. `.env`:
   ```
   LOCAL_TTS_URL=http://localhost:5002
   LOCAL_TTS_ENGINE=coqui
   ```
4. Restart Node, hard-refresh studio, pick Local Only.

For **Piper**:
1. Download `piper.exe` + a voice `.onnx` from https://github.com/rhasspy/piper/releases.
2. Wrap in a small HTTP server that exposes `POST /tts` (the adapter expects the Kokoro protocol — easiest path is a 30-line Flask wrapper).
3. Point `LOCAL_TTS_URL` at it, set `LOCAL_TTS_ENGINE=piper`.

## Voice mapping

Each preset's `edgeId` (like `en-US-DavisNeural`) is what the studio sends in the local request body. The local server is responsible for mapping that to its own voice id.

For Kokoro: `kokoro-tts/kokoro_server.py` has `VOICE_MAP`. To add new mappings:
```python
VOICE_MAP = {
    "en-US-AriaNeural":    "af_bella",
    "en-US-DavisNeural":   "am_michael",
    # add new mappings here
}
```

Restart Kokoro after editing.

## To rip Edge TTS out for real

Edge TTS is still in the codebase as a defensive fallback. To FORCE all renders through local:

1. Set the studio's engine chip to `🏠 Local Only`. This is per-session.
2. To persist it across sessions, edit `state.voiceEngine` default in `frontend/zodiac.html` from `'auto'` to `'local'`. The autosave layer respects this.
3. To remove Edge TTS code entirely, delete `import { edgeTtsToFile } from './edgeTtsAdapter'` from `ttsService.ts` and remove the `await edgeTtsToFile(...)` call. The `if (engine === 'local')` path already throws a clear error if local fails — so removing Edge breaks `auto` mode. Don't do this unless local is rock-solid.

## After swapping

Verify via:
```
http://localhost:3001/api/zodiac/engine-status
```

`localTts.ok: true` confirms the Node server can reach the new local engine. Any voice preview from this point uses it.
