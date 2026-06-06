# Installation & First-Run Setup

This app is **local-first** — it downloads its dependencies and AI models to your
machine once, then runs entirely offline (apart from fetching the YouTube videos
you analyze and talking to your local Ollama).

---

## TL;DR

1. Install the two prerequisites (below).
2. Double-click **`install.bat`** and wait (first run downloads several GB).
3. Double-click **`server.bat`** to use it (opens http://127.0.0.1:6113).

> `server.bat` runs the same checks as the installer and will auto-fix anything
> missing, so technically you can skip step 2 — but running `install.bat` first
> gets all the big downloads out of the way in one go.

---

## Prerequisites (install these yourself)

| Prerequisite | Why | Get it |
|---|---|---|
| **Python 3.10+** | Runs the app | https://www.python.org/downloads/ — tick **"Add python.exe to PATH"** during install |
| **Ollama** | Runs the local AI models | https://ollama.com |

Everything else (web server, yt-dlp, **ffmpeg**, PyTorch, Whisper, the models) is
downloaded automatically by the installer. You do **not** need to install ffmpeg.

---

## What `install.bat` downloads

Run it once. It is safe to re-run (it skips anything already present).

| Step | What | Approx size |
|---|---|---|
| 1 | Upgrade pip | — |
| 2 | Core Python deps (FastAPI, yt-dlp, Pillow, bundled ffmpeg…) | ~80 MB |
| 3 | **Speech-to-text engine**: CPU PyTorch (pinned) + openai-whisper | ~250 MB |
| 4 | Verify imports | — |
| 5 | ffmpeg (bundled binary) | included above |
| 6 | **Whisper model** (`base`) for transcribing videos without captions | ~150 MB |
| 7 | **Ollama reasoning model** `deepseek-r1:8b` | ~5 GB |

Optional:
```bat
install.bat --vision        REM also pulls a local vision model (moondream, ~1.7 GB)
```

After it finishes, start the app with **`server.bat`**.

---

## Why PyTorch is pinned (important)

On Python 3.13 / Windows, the **newest** native AI wheels have shipped broken:
- `torch 2.12.0+cpu` — its `c10.dll` fails to initialize (`WinError 1114`).
- `ctranslate2 4.7.2` (faster-whisper) — segfaults on model load.

So the installer deliberately installs a **known-good CPU build of PyTorch**
(`torch>=2.6,<2.9`) and uses **openai-whisper**, and runs transcription in an
**isolated subprocess** so that even a bad native library can never crash the
server. This is handled for you — no action needed.

---

## Manual install (if you prefer the command line)

```bash
pip install -r requirements.txt
pip install "torch>=2.6,<2.9" --index-url https://download.pytorch.org/whl/cpu
pip install openai-whisper
ollama pull deepseek-r1:8b
python starter.py
```

---

## Troubleshooting

**`OSError: [WinError 1114] ... c10.dll`** or a transcription **segfault**
→ A broken/too-new PyTorch is installed. Fix:
```bash
pip install --upgrade "torch>=2.6,<2.9" --index-url https://download.pytorch.org/whl/cpu
```
(The installer/starter do this automatically.)

**"Whisper model not downloaded"** → Re-run `install.bat`, or it will download on
the first video that has no captions. Needs internet the first time.

**"Ollama server not reachable"** → Start Ollama (it usually runs in the tray),
then `ollama pull deepseek-r1:8b`. The app still does metadata/transcript/clips
analysis; only the AI-writing features need Ollama.

**Generation is slow** → DeepSeek-R1 reasons heavily. For faster output:
`ollama pull qwen2.5:7b` then set `YIA_REASONING_MODEL=qwen2.5:7b`.

**Transcription is slow** → Whisper on CPU is slow for long videos. Use a smaller
model: set `YIA_WHISPER_MODEL=tiny`. Most videos have captions and skip Whisper
entirely.

**Port 6113 already in use** → `set YIA_PORT=<other port>` before launching, or
the starter will detect an already-running instance and just open it.
