# Kokoro TTS

Local HTTP TTS server used by Trend Vault when `LOCAL_TTS_URL` is set
in `.env`. Lightweight (~80 MB ONNX model), Apache-licensed, no cloud calls.

## First-time setup

From `Trend Vault/`:

```
setup-kokoro.bat
```

This creates `.venv/`, installs `kokoro-onnx`, Flask, and friends, then
downloads `kokoro-v0_19.onnx` + `voices.bin` into this folder.

## Start the server

```
start-kokoro.bat
```

Listens on `http://127.0.0.1:5070`. Health check: `GET /`.
Synthesis: `POST /tts` with JSON `{ "text": "...", "voice": "en-US-DavisNeural", "speed": 1.0 }`.

The `voice` field accepts either an Edge Neural id (mapped via `VOICE_MAP`
in `kokoro_server.py`) or a raw Kokoro id like `af_bella` / `am_michael`.

## Files in this folder

| File                  | Source                                                                                          | Tracked via |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `kokoro_server.py`    | This repo                                                                                        | git         |
| `requirements.txt`    | This repo                                                                                        | git         |
| `kokoro-v0_19.onnx`   | https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files                            | git LFS     |
| `voices.bin`          | https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files                            | git LFS     |
| `.venv/`              | created by `setup-kokoro.bat`                                                                    | gitignored  |

## Why this exists

`scripts/tts/localTtsAdapter.ts` calls this server. If it's running, every
voice preview and every render uses Kokoro instead of Microsoft Edge TTS.
If it's down, the adapter quietly returns `null` and the pipeline falls back
to Edge TTS.
