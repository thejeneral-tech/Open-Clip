# 🎬 YouTube Video Intelligence Agent

A local-first agent that **watches, reads, analyzes, and transforms** YouTube videos.
Paste a URL, tell it what you want in plain English, and it produces the right
output automatically — clips, summaries, scripts, blogs, subtitles, and more.

Everything runs on your machine: **DeepSeek-R1 via Ollama** for reasoning,
**Whisper** for transcription fallback, **yt-dlp** for data, **ffmpeg** for frames,
and **SQLite** for storage. No API keys required.

---

## ✨ What it does

| Capability | How |
|---|---|
| **Metadata** | Title, channel, date, duration, views, likes, tags, hashtags, chapters, thumbnail, **most-replayed heatmap**, Short vs long-form detection (via yt-dlp, no API key) |
| **Transcript** | Auto + manual captions, timestamped. Missing captions → **automatic Whisper transcription** of the audio |
| **Video understanding** | Downloads a low-res copy, extracts frames every N seconds **+ scene-change detection** (ffmpeg). Optional **vision model** captions on-screen text, people, products, slides, charts |
| **Comment intelligence** | Topics, audience reactions, questions, funny/controversial moments, **most-mentioned timestamps**, clip requests, sentiment, pinned/top comments |
| **Intent understanding** | Plain-English request → the correct workflow ("best Shorts clips", "viral TikTok script", "funniest moments", "blog post"…) |
| **Clip finder** | Ranked clip candidates with start/end, title, **viral score**, hook, caption, suggested platform & edit style |
| **Output modes** | Summary · Clip list · Shorts/TikTok script · Subtitles (SRT) · Blog article · Tweet thread · Research notes · Content ideas · Editing instructions · Timeline markers · Hooks · Comment-driven timestamps |
| **Exports** | JSON · CSV · TXT · Markdown · SRT · Editing timeline notes |
| **Storage** | Every video, transcript, comment set, frame set, clip, prompt, and output saved in SQLite |

The pipeline:

```
URL → Metadata → Transcript → Comments → Frames → Understand request
    → Rank moments / find clips → Generate output
```

---

## 🚀 Quick start

### 1. Prerequisites (install these once)
- **Python 3.10+** (tested on 3.13) — tick *"Add python.exe to PATH"* during setup
- **[Ollama](https://ollama.com)** installed and running

Everything else — web server, yt-dlp, **ffmpeg**, PyTorch, Whisper, and the AI
models — is downloaded automatically. You do **not** install ffmpeg yourself.

### 2. Install (first run downloads everything)
Double-click **`install.bat`** (or run `python install.py`). It downloads the
Python deps, a pinned CPU build of PyTorch, openai-whisper, the Whisper model, and
the `deepseek-r1:8b` reasoning model. See **[INSTALL.md](INSTALL.md)** for details
and sizes. This can take a while and a few GB the first time.

### 3. Run
Double-click **`server.bat`**. It runs the **app starter** ([`starter.py`](starter.py)),
which re-checks and auto-fixes the whole stack, then launches on
**http://127.0.0.1:6113** (opens automatically):

```
 [1/8] Python runtime         -> verifies Python 3.10+
 [2/8] Python dependencies    -> installs core deps + pinned CPU PyTorch + openai-whisper
 [3/8] Ollama server          -> auto-starts `ollama serve` if installed but down
 [4/8] Reasoning model        -> auto-pulls deepseek-r1:8b if missing
 [5/8] Whisper model          -> downloads the speech-to-text model if missing
 [6/8] ffmpeg                 -> uses system or bundled binary
 [7/8] Port 6113              -> frees/detects an already-running instance
 [8/8] Launch web server      -> opens the dashboard in your browser
```

Because `server.bat` self-heals, you can even skip step 2 — but running
`install.bat` first gets the big downloads out of the way at once. If a check
can't be auto-fixed (e.g. Ollama isn't installed) the starter prints a clear
`[WARN]`/`[FAIL]` and continues with reduced features or stops with the fix.

From a terminal instead:
```bash
python starter.py        # same preflight + launch (uses YIA_PORT, default 6113)
python run.py            # plain launch, default port 8000
```
Change the port any time with the `YIA_PORT` environment variable.

---

## 🖱️ Using the dashboard

1. **Paste a YouTube URL** (watch, `youtu.be`, Shorts, or a bare video id).
2. **Type a task** — or click an example chip. Examples:
   - *Find the best clips for YouTube Shorts*
   - *Summarize this video*
   - *Make a viral TikTok script from this*
   - *Find the funniest moments* / *Find controversial moments*
   - *Turn this into a blog post* · *Make a tweet thread* · *Give me hooks*
   - *Find clips under 60 seconds* · *Make subtitles from the best section*
3. Click **⚡ Run Full Analysis** for the automated end-to-end flow,
   or use the **manual step buttons** to run one stage at a time:
   *Fetch Metadata · Get Transcript · Analyze Comments · Extract Frames · Find Clips · Generate Output*.
4. Watch the **progress bar + step status + activity log**, then explore the tabs:
   **Output · Clips & Timeline · Transcript · Comments · Frames · Export**.

The left panel shows metadata + your analysis **History** (click any past video to reload it).

---

## ⚙️ Configuration (environment variables)

All optional — sensible defaults are used.

| Variable | Default | Purpose |
|---|---|---|
| `YIA_REASONING_MODEL` | `deepseek-r1:8b` | Main reasoning model (any Ollama model) |
| `YIA_VISION_MODEL` | *(auto-detect)* | Vision model for frame analysis |
| `YIA_WHISPER_MODEL` | `base` | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `YIA_WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `YIA_FRAME_INTERVAL` | `8` | Seconds between sampled frames |
| `YIA_MAX_COMMENTS` | `200` | Comments to fetch |
| `YIA_PORT` | `8000` | Server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |

Example (PowerShell):
```powershell
$env:YIA_REASONING_MODEL = "qwen2.5:7b"; python run.py
```

---

## 🔌 Optional enhancements

- **👁 Visual frame analysis** — install any vision model; it's auto-detected:
  ```bash
  ollama pull moondream          # small & fast (~1.7 GB)
  # or: ollama pull llama3.2-vision   /   ollama pull qwen2.5vl
  ```
  Without one, frames are still extracted (with scene detection); only the AI
  captioning step is skipped.

- **⚡ Faster generation** — DeepSeek-R1 is a *reasoning* model and is thorough
  but slow (tens of seconds to a few minutes per generation). For much faster
  output, point the agent at a non-reasoning model:
  ```bash
  ollama pull qwen2.5:7b
  ```
  then set `YIA_REASONING_MODEL=qwen2.5:7b`.

- **🧩 Best yt-dlp reliability** — YouTube extraction in 2025+ benefits from a JS
  runtime. If you see *"No supported JavaScript runtime"* warnings or download
  issues, install **[Deno](https://deno.com)** (`winget install DenoLand.Deno`).
  Metadata and captions work without it.

---

## 🛠️ Troubleshooting

- **"No transcript"** → the agent automatically falls back to Whisper (downloads
  audio and transcribes locally, in an isolated process). First Whisper run
  downloads the model (~150 MB for `base`). Long videos take a while on CPU.
- **`WinError 1114` / transcription segfault** → a broken/too-new PyTorch wheel.
  Run `install.bat` again (it reinstalls a pinned, known-good CPU build). See
  **[INSTALL.md](INSTALL.md#troubleshooting)**.
- **No comments** → some networks/accounts trigger YouTube **Restricted Mode**,
  which hides comments. The agent continues without them (by design).
- **Generation feels slow** → that's DeepSeek-R1 reasoning. Switch to a faster
  model (see above). The progress log shows exactly what's happening.
- **Vision says "no vision model"** → pull one (see above).
- **Private / age-restricted / unavailable video** → the agent reports a clear
  reason and continues with whatever data it can get.

---

## 📁 Project structure

```
app/
  config.py          settings + env overrides
  database.py        SQLite layer
  llm.py             Ollama client (DeepSeek-R1 <think> stripping, JSON, vision)
  ffmpeg_utils.py    system/bundled ffmpeg discovery + on-PATH shim
  bootstrap.py       shared dependency setup (pinned CPU torch + whisper)
  jobs.py            in-memory progress/job manager
  pipeline.py        full + per-step orchestration
  server.py          FastAPI app (REST + static hosting)
  whisper_worker.py  isolated subprocess for Whisper (crash-safe)
  util.py            timestamps, URL parsing
  services/
    metadata.py      yt-dlp metadata + heatmap + Short detection
    transcript.py    captions → yt-dlp subs → Whisper (subprocess)
    comments.py      comments + insights + timestamp mining
    frames.py        download + ffmpeg frames + vision captioning
    intent.py        plain-English → workflow
    clips.py         ranked viral clip finder
    context.py       transcript shaping / digests
    outputs.py       all output-mode generators
    exporters.py     JSON/CSV/TXT/MD/SRT/timeline
web/                 zero-build dashboard (HTML/CSS/JS)
data/                SQLite DB + per-video frames/audio/exports (created at runtime)
install.py / install.bat   first-run installer (downloads everything)
starter.py / server.bat    preflight launcher (port 6113)
run.py                     plain entry point (port 8000)
```

---

## 🔒 Privacy

100% local. Video data, transcripts, comments, frames, and AI outputs never leave
your machine. The only network calls are to YouTube (to fetch the public video
data) and to your local Ollama server.
