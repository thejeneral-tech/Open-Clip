# OpenClip 🎬

**A self-hosted, open-source alternative to Opus Clip — powered entirely by local AI (Ollama + Whisper).**

OpenClip ingests long-form videos, finds the most viral-worthy moments, cuts them into vertical short-form clips, reframes them with face/speaker tracking, burns in animated captions, scores each clip for predicted engagement, and lets you manage everything from a modern web dashboard. No cloud APIs, no per-minute billing — it runs on your own machine.

> **Runs as a plain local Python stack — no Docker.** Metadata lives in a single
> SQLite file and the background queue is filesystem-based, so there's no
> PostgreSQL or Redis to install. The only external tools you need are Python,
> Node.js, FFmpeg, and Ollama.

---

## ✨ Features

| Area | What it does |
| --- | --- |
| **Ingestion** | Drag-and-drop upload, YouTube URL import, local file import, resumable progress, background processing |
| **Transcription** | Whisper Large V3 / Faster-Whisper, word-level timestamps, sentence segmentation, speaker diarization |
| **Viral detection** | LLM analysis of emotional peaks, story transitions, humor, controversy, questions, CTAs, high-energy moments → 10–50 candidate clips with start/end, score, reasoning, title |
| **AI ranking** | Multi-factor 0–100 scoring (hook, emotional intensity, curiosity gap, retention, platform fit) with confidence and explanation |
| **Smart reframing** | Face / speaker / object tracking (MediaPipe + OpenCV + YOLO) → dynamic crops for 9:16, 1:1, 4:5, 16:9 |
| **Captions** | Burned-in animated subtitles + SRT + VTT, word highlighting, emoji insertion, AI emphasis, dynamic sizing, 5 preset styles (Hormozi, Modern TikTok, Minimal, Gaming, Podcast) |
| **B-roll** | Transcript-driven search terms, scene descriptions, stock-footage suggestions, optional Stable Diffusion generation |
| **Titles & descriptions** | 20 title variations per platform, SEO descriptions, hashtags, keywords |
| **Batch processing** | Multi-video queues, distributed Celery workers, priority scheduling |
| **Timeline editor** | Browser-based trim / split / reposition captions / change aspect / replace / overlays |
| **Export** | MP4 / MOV, 720p–4K, NVENC / QuickSync / AMF hardware acceleration |

---

## 🏗️ Architecture

```
                         ┌──────────────────────────┐
                         │      Next.js 15 (UI)      │
                         │  TS · Tailwind · shadcn   │
                         └─────────────┬────────────┘
                                       │ REST + WebSocket
                         ┌─────────────▼────────────┐
              ┌──────────│      FastAPI (API)        │──────────┐
              │          └─────────────┬────────────┘          │
              │                        │                        │
      ┌───────▼──────┐        ┌────────▼────────┐      ┌────────▼────────┐
      │   SQLite     │        │  Filesystem     │      │   Local disk    │
      │  (metadata)  │        │  queue (Celery) │      │    (media)      │
      └──────────────┘        └────────┬────────┘      └─────────────────┘
                                       │ Celery
                         ┌─────────────▼────────────┐
                         │     Celery Worker         │
                         │  FFmpeg · OpenCV · YOLO   │
                         │  Faster-Whisper · MediaPipe│
                         └─────────────┬────────────┘
                                       │ HTTP
                         ┌─────────────▼────────────┐
                         │          Ollama           │
                         │ Qwen3 · DeepSeek-R1 · etc │
                         └──────────────────────────┘
```

**Stack:** FastAPI · SQLite · Celery (filesystem broker) · FFmpeg · Ollama · Next.js 15 · TypeScript · TailwindCSS · shadcn/ui · React Query.

Everything the app generates — the SQLite database, uploaded/rendered media, the
task queue, and progress snapshots — lives under `./data/`.

---

## 🤖 Autonomous multi-bot automation

On top of the manual clip studio, OpenClip runs an optional **autonomous content
pipeline**. Create any number of **bots** that each:

1. **Discover** trending content from their own sources (YouTube search/channels,
   RSS/Atom feeds, subreddits — pluggable),
2. **Score** every candidate 0–100 locally (engagement velocities + recency + an
   Ollama-judged topic-relevance signal),
3. **Ingest & process** the winners through the *existing* transcription →
   viral-detection → clipping → captioning → reframing pipeline,
4. **Queue / publish** the resulting clips per their **approval mode**
   (manual · semi-automatic · autonomous), and
5. **Learn** from performance (the self-improvement task writes recommendations
   back onto each bot).

Everything is driven from new dashboard pages — **Bots**, **Discovery**,
**Publishing**, **Models & GPU** — and a full REST API under `/api/v1/bots`,
`/presets`, `/discovery`, `/publishing`, `/automation` (see Swagger).

Key design points:

* **100% local AI.** Every inference — discovery relevance, scoring, clip
  selection, titles, metadata, captions, self-improvement — flows through a
  single **Ollama service layer** (`app.services.ollama_service`) that does
  per-stage model routing, concurrency control, health, VRAM/`/api/ps`, and local
  embeddings. Assign different models to different stages per bot.
* **Presets.** System presets (`PODCAST_VIRAL`, `NEWS_FAST`, `AI_NEWS`,
  `SPORTS_HIGHLIGHTS`, `BUSINESS_GROWTH`, `GAMING_MOMENTS`, `MOTIVATION`,
  `CUSTOM`) seed a bot; clone/edit/version your own.
* **No new services.** Scheduling runs as a lightweight asyncio loop inside the
  API process (no `celery beat`); bot work runs on a new Celery `bots` queue
  alongside the existing `default`/`media`/`ai` queues. Discovery uses only deps
  already in the stack (`yt-dlp`, `httpx`, the stdlib XML parser) — nothing extra
  to install.
* **Safe publishing default.** The built-in **manual** connector turns the queue
  into a review-and-download workflow with zero setup. Real platform connectors
  (YouTube, TikTok, …) activate once you add your own OAuth credentials under
  **Publishing → Connectors** — OpenClip never posts on your behalf until then.
* **Offline-resilient.** Only discovery, downloads, and publishing need the
  internet; transcription, analysis, clipping, and captioning keep working
  offline.

On PostgreSQL, apply the automation schema with `alembic upgrade head`
(migration `0002_automation`); on SQLite it's created automatically.

## ✅ Prerequisites

Install these once (no Docker required):

| Tool | Notes |
| --- | --- |
| **Python 3.10–3.12** | The ML wheels (mediapipe, faster-whisper, numpy) don't yet ship for 3.13+. |
| **Node.js 18+** | For the Next.js dashboard. |
| **FFmpeg** | On PATH (`ffmpeg`/`ffprobe`). Required for all media work. |
| **Ollama** | <https://ollama.com/download> — the local LLM runtime. |

An NVIDIA GPU is optional: everything runs on CPU, just slower. With a GPU, set
`WHISPER_DEVICE=cuda` (and `HWACCEL=nvenc`) in `.env`.

---

## 🚀 Quick start

A single, dependency-free Python launcher drives the whole stack:

```bash
python launch.py            # interactive menu
# …or go straight to it:
python launch.py doctor     # check Python / Node / FFmpeg / Ollama / ports
python launch.py setup      # create venv, install deps, init the database
python launch.py up         # start everything, wait, open browser
python launch.py status     # service + health overview
python launch.py logs api   # tail a service (api | worker | frontend | ollama)
python launch.py down       # stop everything
```

Prefer a native launcher? The OS wrappers take the **same** subcommands and
arguments — they just find Python and hand off to `launch.py`:

```bash
./launch.sh            # Linux / macOS   — e.g. ./launch.sh up, ./launch.sh logs api
.\launch.ps1           # Windows / PowerShell — e.g. .\launch.ps1 up
```

`setup` creates `backend/.venv`, installs the Python + Node dependencies, and
initializes the SQLite database. `up` then starts four background processes —
**api** (Uvicorn), **worker** (Celery), **frontend** (Next.js), and **ollama** —
waits for them to come online, and opens the app.

First boot creates the database schema and seeds an admin account
(`admin@openclip.local` / `changeme` — change it immediately under **Settings**).

> **No AI models are downloaded automatically.** Open **Settings → AI models** in
> the web app to install exactly the models you want (with a live download
> progress bar) and remove ones you don't, so you stay in control of disk usage.
> Whisper transcription models download on first use per your **Settings** choice.

> On **Windows** the Celery worker runs single-process (`--pool=solo`), so one
> media job runs at a time. On macOS/Linux it scales to `WORKER_CONCURRENCY`.

Open <http://localhost:3000> once it's up.

---

## 🧑‍💻 Manual run (without the launcher)

```bash
# 1. Backend
cd backend
python -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.db_init                     # create ./data + SQLite schema
uvicorn app.main:app --host 127.0.0.1 --port 8000
# in another shell, with the venv activated:
celery -A app.workers.celery_app worker --loglevel=info -Q default,media,ai
#   on Windows append:  --pool=solo

# 2. Frontend
cd frontend
npm install
npm run dev                               # http://localhost:3000
```

The Next.js dev server proxies `/api` and `/media` to the backend, and the
progress WebSocket connects to it directly — those URLs are written to
`frontend/.env.local` by `launch.py setup` (or set `NEXT_PUBLIC_WS_URL` and
`BACKEND_INTERNAL_URL` yourself).

### Optional: PostgreSQL instead of SQLite

The app still supports Postgres. Install `asyncpg` + `psycopg[binary]`, set
`DB_BACKEND=postgres` (plus the `POSTGRES_*` vars) in `.env`, and manage the
schema with Alembic (`alembic upgrade head`) instead of `app.db_init`.

---

## 📚 Documentation

* Interactive API docs: `http://localhost:8000/api/docs` (Swagger) and `/api/redoc`.
* OpenAPI schema: `http://localhost:8000/api/openapi.json`.
* Environment reference: [`.env.example`](.env.example).

---

## 🧪 Tests

```bash
# backend unit + API tests (SQLite) — activate the venv first, or:
cd backend && .venv/bin/python -m pytest    # Windows: .venv\Scripts\python -m pytest
cd frontend && npm test                     # frontend component tests (vitest)
```

CI runs lint + type-check + tests on every push — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## 🗺️ Project layout

```
openclip/
├── backend/          FastAPI app, services, Celery worker, Alembic migrations
│   └── .venv/        backend virtualenv (created by `launch.py setup`)
├── frontend/         Next.js 15 dashboard
├── scripts/          setup.ps1 / setup.sh convenience wrappers
├── data/             SQLite DB, media, queue, logs (git-ignored, created at runtime)
├── .github/          CI
├── launch.py         the local control panel
├── launch.sh         native launcher wrapper (Linux / macOS)
└── launch.ps1        native launcher wrapper (Windows / PowerShell)
```

---

## 📝 License

MIT — see [LICENSE](LICENSE).
