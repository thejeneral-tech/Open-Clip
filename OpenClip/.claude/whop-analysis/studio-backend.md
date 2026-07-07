# OpenClip End-to-End Pipeline Mapping

## 1. VIDEO INGEST

### 1.1 Upload Endpoint
**Endpoint:** `POST /projects/{project_id}/videos/upload`
- **Request Shape:**
  - `file`: `UploadFile` (multipart form data)
  - `title`: `str | None` (optional form field)
- **Response:** `VideoOut` (201 Created)
- **Accepted Formats:** mp4, mov, mkv, webm, avi, m4v
- **Max Size:** Configurable via `settings.MAX_UPLOAD_SIZE_MB` (defaults to unset, enforced in code)
- **Storage:** Files are chunked in 4MB blocks, written to storage backend (local filesystem or S3), then a Celery task `ingest_upload_task` is triggered
- **Video Model Fields After Upload:**
  - `project_id`, `source` (set to `VideoSource.UPLOAD`), `original_filename`, `title`
  - `status` → `QUEUED`, `stage` → `ingest`
  - `storage_path` (the storage backend key), `size_bytes`

### 1.2 YouTube/URL Import Endpoint
**Endpoint:** `POST /projects/{project_id}/videos/youtube`
- **Request Shape:** `YouTubeImportRequest`
  ```python
  {
    "url": HttpUrl,           # validated HTTP/HTTPS URL
    "title": str | None       # optional
  }
  ```
- **Response:** `VideoOut` (201 Created)
- **Mechanism:** Uses **yt-dlp** to download videos
  - **Function:** `app.services.youtube.download(url, dest_path, on_progress=callback)`
  - **Format Selection Strategy** (prioritized):
    1. H.264 video + audio pair (height ≤ 1440) — ensures OpenCV reframe compatibility
    2. Any codec video + audio pair (height ≤ 1440)
    3. Any single best stream
  - **Output:** Merges to MP4 via ffmpeg
  - **Returns:** Metadata dict: `{title, duration, width, height, ext, uploader}`
- **Storage:** Downloaded file stored at key returned by `video_source_key(project_id, video_id, "mp4")`

### 1.3 Post-Ingest: Probing & Thumbnailing
**Function:** `_probe_and_thumbnail(video_id)` (part of both `ingest_upload_task` and `ingest_youtube_task`)
- **What It Does:**
  1. Probes media via FFmpeg: extracts `duration`, `width`, `height`, `fps`, `codec`
  2. Extracts a thumbnail at 10% into the video (clamped 0.5s–2.0s)
  3. Updates Video record with media properties
- **Video Model Fields Updated:**
  - `duration_seconds`, `width`, `height`, `fps`, `codec`, `size_bytes`, `thumbnail_path`
  - `status` → `COMPLETED`, `stage` → `ready`

**Important:** Both upload and YouTube ingest are **asynchronous** — the API immediately returns with a Video record, then Celery workers probe the media in the background.

---

## 2. PROCESSING PIPELINE (Celery `process_video_task`)

### 2.1 Overview
**Endpoint:** `POST /videos/{video_id}/process`
- **Request Shape:** `ProcessOptions` (optional, defaults applied):
  ```python
  {
    "target_clip_count": int = 12,              # 1–50 clips to generate
    "min_clip_seconds": int = 8,                # minimum clip length
    "max_clip_seconds": int = 90,               # maximum clip length
    "aspect_ratios": [AspectRatio] = [VERTICAL],  # 9:16, 1:1, 16:9, 4:5
    "caption_style": CaptionStyle = HORMOZI,    # font/layout preset
    "caption_config": dict | None = None,       # karaoke/pop + color overrides
    "template_id": int | None = None,           # StoryVault preset
    "language": str | None = None,              # force language for transcription
    "generate_titles": bool = True,
    "generate_descriptions": bool = True,
    "generate_broll": bool = True,
    "enable_reframe": bool = True,              # smart cropping
    "enable_captions": bool = True,
    "model": str | None = None                  # override default Ollama model
  }
  ```
- **Response:** `TaskResponse` with Celery `task_id`

### 2.2 Pipeline Stages (with Progress Bands)
The pipeline emits progress via WebSocket (`ProgressTracker`) with stages and % completion:

#### Stage 1: Transcription (0%–40%)
**Function:** `_transcribe(video_id, opts, models, tracker)`
- **Input:** Raw video file at `storage_path`
- **Processor:** **faster-whisper** (CTranslate2, default) or openai-whisper fallback
  - Model: User setting or default `settings.WHISPER_MODEL` (e.g., "base", "small", "medium", "large")
  - Device: `settings.WHISPER_DEVICE` (auto-fallback: GPU → CPU int8)
  - Compute type: `settings.WHISPER_COMPUTE_TYPE` (e.g., float32, float16, int8)
  - CPU threads: `settings.WHISPER_CPU_THREADS` (0 = auto)
- **Process:**
  1. Extract audio from video via ffmpeg (4MB key `video_audio_key`)
  2. Run whisper with word-level timestamps + VAD (silence filter ≥ 400ms)
  3. Optional: **pyannote.audio** diarization when `ENABLE_DIARIZATION=true` (adds speaker labels)
- **Output:** Transcript record with:
  - `full_text`, `word_count`, `num_speakers`, `language`, `engine`, `model`
  - `segments`: `[{id, start, end, text, speaker, words: [{word, start, end, probability}]}, ...]`
- **Stored:** `Transcript` ORM record, also returned as dict to next stage

#### Stage 2: Viral Moment Detection (40%–50%)
**Function:** `_detect(video_id, transcript, opts, models, tracker)`
- **Input:** Transcript segments + ProcessOptions
- **Processor:** Ollama LLM (default `settings.OLLAMA_DEFAULT_MODEL`, e.g., "qwen3:32b")
- **Strategy:** 
  - For videos > 10 minutes (600s), split into overlapping windows (600s window, 30s overlap)
  - Each window sent to LLM with system prompt + viral detection schema
  - Results: candidates with `start`, `end`, `title`, `viral_score` (0–100), `reasoning`, `hook_type`
  - Post-process: de-overlap, snap to sentence boundaries, normalize to `target_clip_count`
- **Constraints:**
  - Minimum clip length: `min_clip_seconds` (default 8s)
  - Maximum clip length: `max_clip_seconds` (default 90s, biased toward upper end)
  - Exactly `target_clip_count` clips returned (or fewer if video too short)
- **Outputs:** List of `CandidateClip` objects, stored as `Clip` records with:
  - `start_time`, `end_time`, `duration`
  - `title`, `reasoning`, `transcript_text`, `viral_score` (from LLM)
  - `aspect_ratio` (from ProcessOptions), `caption_style`
  - `status` → `PENDING`, ready for enrichment
- **Stored:** `Clip` ORM records + `AIAnalysis` audit record for the viral detection call

#### Stage 3: Per-Clip Enrichment (50%–100%)
**Function:** `_enrich_clip(clip_id, source_path, segments, opts, models)` (parallelized)

Clips are enriched in parallel using a ThreadPoolExecutor (up to `settings.CLIP_CONCURRENCY` workers). Each clip goes through:

##### 3a. Ranking + Titles + Description + B-roll (Single LLM Call)
**Function:** `clip_meta_svc.generate_clip_metadata(title, text, duration, model)`
- **Processor:** One consolidated Ollama call (avoids 4× feedback)
- **Input:** 
  - `title`: initial title from viral detection (or empty)
  - `text`: transcript text for that clip's time range
  - `duration`: `end_time - start_time`
  - `model`: user's ranking model (default `settings.OLLAMA_RANKING_MODEL`)
- **System Prompt:** Instructs model on five scoring dimensions:
  - `hook_strength` (first 3s grippiness)
  - `emotional_intensity`
  - `curiosity_gap`
  - `retention_likelihood`
  - `platform_suitability` (vertical short-form fit)
  - `overall_score` (0–100, synthesized if missing)
  - `confidence` (0–100)
- **Also Returns:**
  - **Titles:** Platform-specific (tiktok, shorts, reels) + a best title
  - **Description:** SEO copy + hashtags (formatted with `#`) + keywords
  - **B-roll:** Array of suggestions with `{start, end, search_terms, scene_description, sd_prompt}`
- **Output:** Dict with keys `{ranking, titles, description, broll}`
- **Stored:** `Clip` fields updated:
  - `ranking_score`, `confidence`, `score_breakdown` (dict with 5 dimensions + explanation)
  - `title` (best from titles array), `title_variations` (all 20)
  - `description`, `hashtags`, `keywords`
  - `broll_suggestions`
  - `AIAnalysis` records for ranking, titles, description, broll

##### 3b. Caption Generation (Heuristic, No LLM)
**Function:** `captions_svc.heuristic_emphasis(captions_svc.build_tokens(words))`
- **Process:**
  1. Build tokens from transcript `words` (word-level start/end from whisper)
  2. Heuristic emphasis: marks important words (long words, numbers, repeated) for visual pop
  3. Optional emoji insertion (model-driven when enabled, but heuristic is fast)
- **Output:** Array of token dicts:
  ```python
  [{
    "word": str,
    "start": float,
    "end": float,
    "emphasis": bool,
    "emoji": str | None
  }, ...]
  ```
- **Stored:** `Clip.captions` (JSON array)

##### 3c. Smart Reframing / Subject Tracking
**Function:** `reframing.compute_trajectory(source_path, start, end, hq_detection, face_zoom, on_progress)`
- **What It Does:**
  - Samples video frames (at settable FPS, default 2 fps)
  - Detects subject center:
    1. **MediaPipe Face Detection** (face center)
    2. **YOLO Person Detection** (if face fails; head anchor for continuity)
    3. **Center fallback** (if both fail; frame center)
  - Detects scene cuts via HSV histogram correlation
  - Builds piecewise-static trajectory: crop *locks* onto subject, moves only on cuts or sustained deadband escape
- **Detection Modes:**
  - `hq_detection=bool(models["reframe_hq"])`: Higher-quality face model
  - `face_zoom=bool(models["reframe_face_zoom"])`: Zoom in on face (9:16 to focus face)
- **Output:** Dict:
  ```python
  {
    "source_w": int, "source_h": int,
    "sample_fps": float, "src_fps": float,
    "centers": [{"t": float, "cx": 0..1, "cy": 0..1, "conf": 0..1}, ...],
    "method": "face" | "person" | "center"
  }
  ```
- **GPU Requirement:** YOLO uses `settings.YOLO_DEVICE` (default "cpu", can be "cuda:0")
- **Stored:** `Clip.reframe_data` (JSON dict)

##### 3d. Render Preview (1080p)
**Function:** `export.render_clip(source_path, output_path, start, end, aspect_ratio, resolution="1080p", ...)`
- **Pipeline:** ffmpeg filter chain:
  1. Cut to `[start, end]`
  2. **Dynamic crop** (driven by reframe trajectory)
  3. **Scale** to target aspect ratio & resolution
  4. **Burn captions** (if enabled; ASS subtitle format, with karaoke animation)
  5. **Encode** (libx264 by default, or hardware encoder if `settings.HWACCEL` set)
- **Hardware Acceleration Options:**
  - `"none"`: libx264/libx265 (CPU)
  - `"nvenc"`: NVIDIA hardware encoder (h264_nvenc/hevc_nvenc)
  - `"qsv"`: Intel QuickSync (h264_qsv/hevc_qsv)
  - `"amf"`: AMD (h264_amf/hevc_amf)
  - `"vaapi"`: AMD/Intel on Linux
- **Output:** Preview MP4 at `clip_preview_key(project_id, video_id, clip_id)`
- **Also:** Extract thumbnail at 0.5s mark, stored at `clip_thumb_key`
- **Stored:**
  - `Clip.preview_path` (storage key)
  - `Clip.thumbnail_path` (storage key)
  - `Clip.status` → `COMPLETED`

### 2.3 Clip Regeneration (Per-Field)
**Endpoint:** `POST /clips/{clip_id}/regenerate`
- **Request:** `ClipRegenerateRequest`
  ```python
  {
    "regenerate_captions": bool = False,
    "regenerate_titles": bool = False,
    "regenerate_description": bool = False,
    "regenerate_broll": bool = False,
    "rerank": bool = False
  }
  ```
- **Function:** `regenerate_clip_task` (Celery)
  - Calls individual services (not consolidated) for each flagged field
  - Ranking: `ranking_svc.rank_clip(title, text, duration, model)`
  - Titles: `titles_svc.generate_titles(text, model)`
  - Description: `desc_svc.generate_description(title, text, model)`
  - B-roll: `broll_svc.suggest_broll(text, model)`
  - Captions: `captions_svc.apply_emphasis(tokens, model)`
- **Updates only the requested fields** on the clip
- **No re-render** (unless timeline editor triggers it)

---

## 3. CLIP MODEL & SCHEMA

### 3.1 Clip ORM Model (`models/clip.py`)

**All fields in the `Clip` table:**

| Field | Type | Purpose |
|-------|------|---------|
| `id` | int (PK) | Unique clip ID |
| `video_id` | int (FK) | Parent video |
| `order_index` | int | Display order (set by viral detection rank) |
| **Timing** | | |
| `start_time` | float | Start in seconds (source video) |
| `end_time` | float | End in seconds (source video) |
| `duration` | float | Computed as `end_time - start_time` |
| **Metadata** | | |
| `title` | str\|None | Best title from LLM (≤ 60 chars) |
| `reasoning` | str\|None | Why this clip is viral (from detection stage) |
| `transcript_text` | str\|None | Full text of clip's transcript segment |
| `description` | str\|None | SEO description (generated by LLM) |
| **Scoring (Virality)** | | |
| `viral_score` | float | 0–100, from viral detection LLM |
| `ranking_score` | float | 0–100, overall virality score from ranking LLM (alias: `ranking_score`) |
| `confidence` | float | 0–100, LLM confidence in the ranking |
| `score_breakdown` | dict (JSON) | Component scores: `{hook_strength, emotional_intensity, curiosity_gap, retention_likelihood, platform_suitability, explanation}` |
| **Render Config** | | |
| `aspect_ratio` | str | One of "9:16", "1:1", "16:9", "4:5" (enum value) |
| `caption_style` | str | One of "hormozi", "modern_tiktok", "minimal", "gaming", "podcast" |
| `caption_config` | dict\|None | Override blob: `{style: "karaoke"\|"pop", primary: "#RRGGBB", highlight: "#RRGGBB", ...}` |
| `title_variations` | list (JSON) | All ~20 platform titles (tiktok + shorts + reels combined) |
| `hashtags` | list (JSON) | Platform hashtags, prefixed with `#` |
| `keywords` | list (JSON) | SEO keywords (not prefixed) |
| `broll_suggestions` | list (JSON) | B-roll: `[{start, end, search_terms, scene_description, sd_prompt}, ...]` |
| `captions` | list (JSON) | Caption tokens: `[{word, start, end, emphasis, emoji}, ...]` |
| `reframe_data` | dict (JSON) | Trajectory data for smart cropping (centers array + metadata) |
| **Render Artifacts** | | |
| `preview_path` | str\|None | Storage key for 1080p preview MP4 |
| `thumbnail_path` | str\|None | Storage key for preview thumbnail (JPG) |
| **Job Lifecycle** | | |
| `status` | str | JobStatus enum: PENDING → PROCESSING → COMPLETED or FAILED |
| `stage` | str\|None | Current stage (analyze, captions, reframe, render, etc.) |
| `progress` | float | 0.0–1.0, linear within the clip's enrichment |
| `error` | str\|None | Error message if FAILED |
| `celery_task_id` | str\|None | Celery task ID for this clip's enrichment |
| **Timestamps** | | |
| `created_at` | datetime | Record creation |
| `updated_at` | datetime | Last update |

### 3.2 Clip Pydantic Schema (`schemas/clip.py`)

**ClipOut** (read response):
```python
{
  "id": int,
  "video_id": int,
  "order_index": int,
  "start_time": float,
  "end_time": float,
  "duration": float,
  "title": str | None,
  "reasoning": str | None,
  "transcript_text": str | None,
  "description": str | None,
  "viral_score": float,
  "ranking_score": float,
  "confidence": float,
  "score_breakdown": dict,  # {hook_strength, emotional_intensity, ...}
  "aspect_ratio": AspectRatio,  # enum, serialized as "9:16" etc
  "caption_style": CaptionStyle,  # enum, serialized as "hormozi" etc
  "title_variations": list[str],
  "hashtags": list[str],
  "keywords": list[str],
  "broll_suggestions": list[dict],
  "captions": list[dict],
  "reframe_data": dict,
  "preview_path": str | None,  # S3 URL or /media/... path
  "thumbnail_path": str | None,
  "status": JobStatus,
  "progress": float,
  "error": str | None,
  "created_at": datetime,
  "updated_at": datetime
}
```

**ClipUpdate** (PATCH request):
```python
{
  "title": str | None,
  "description": str | None,
  "start_time": float | None,  # > 0
  "end_time": float | None,    # > 0
  "aspect_ratio": AspectRatio | None,
  "caption_style": CaptionStyle | None,
  "captions": list[dict] | None,
  "reframe_data": dict | None,
  "order_index": int | None
}
```

---

## 4. CLIPS & EXPORTS API

### 4.1 Clip Endpoints

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| GET | `/videos/{video_id}/clips` | List clips for a video | `sort` query param: "score" (default) or "time" | `list[ClipOut]` |
| GET | `/clips/{clip_id}` | Get single clip details | — | `ClipOut` |
| PATCH | `/clips/{clip_id}` | Edit clip (timeline editor) | `ClipUpdate` | `ClipOut` |
| POST | `/clips/{clip_id}/regenerate` | Re-run AI steps | `ClipRegenerateRequest` | `TaskResponse` |
| POST | `/clips/{clip_id}/render` | Re-render preview | — | `TaskResponse` |
| DELETE | `/clips/{clip_id}` | Delete clip | — | `Message` |
| GET | `/clips/{clip_id}/captions.srt` | Download SRT file | — | SRT text file |
| GET | `/clips/{clip_id}/captions.vtt` | Download VTT file | — | VTT text file |

### 4.2 Export Endpoints

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| GET | `/exports/{export_id}` | Get export details | — | `ExportOut` |
| GET | `/exports/{export_id}/download` | Download rendered clip | Optional `?token=...` for guest links | MP4 / MOV file |
| POST | `/clips/{clip_id}/exports` | Create new export | `ExportCreate` | `ExportOut` (201) |
| GET | `/clips/{clip_id}/exports` | List exports for clip | — | `list[ExportOut]` |

### 4.3 Export Creation & Rendering
**Endpoint:** `POST /clips/{clip_id}/exports`
- **Request:** `ExportCreate`
  ```python
  {
    "format": ExportFormat = MP4,          # mp4, mov, webm
    "resolution": ExportResolution = P1080, # 480p–2160p
    "aspect_ratio": AspectRatio = VERTICAL, # 9:16, 1:1, 16:9, 4:5
    "burn_captions": bool = True            # burned SRT or standalone
  }
  ```
- **Process:** Creates `Export` record, queues `export_clip_task` (Celery)
  - Calls same `render_clip` as preview, but with export-specific resolution + hwaccel
  - Hardware acceleration pulled from `settings.HWACCEL` (auto-detected or manual)
- **Response:** `ExportOut` with `status=QUEUED`, progress updates via WebSocket
- **Export Model Fields:**
  - `id`, `clip_id`, `format`, `resolution`, `aspect_ratio`, `burn_captions`
  - `hwaccel`, `storage_path`, `size_bytes`, `width`, `height`, `duration_seconds`
  - `status`, `progress`, `error`, `celery_task_id`
  - `created_at`

---

## 5. LLM MODELS & OLLAMA CALLS

### 5.1 Which Models Are Used?

| Stage | Config Key | Default | Purpose | Calls |
|-------|------------|---------|---------|-------|
| **Viral Detection** | `OLLAMA_DEFAULT_MODEL` | `qwen3:32b` | Select viral clips from transcript | Once per video (windowed) |
| **Ranking + Titles + Desc + B-roll** | `OLLAMA_RANKING_MODEL` or `OLLAMA_DEFAULT_MODEL` | `qwen3:32b` | Score + metadata in 1 call | Once per clip |
| **Per-Field Regeneration** | `OLLAMA_RANKING_MODEL` or `OLLAMA_DEFAULT_MODEL` | `qwen3:32b` | Refresh one field (titles, desc, etc.) | Variable (user-triggered) |
| **Captions** | None | N/A | Heuristic emphasis (no LLM) | N/A |
| **Transcription** | `WHISPER_MODEL` | (no default) | faster-whisper or openai-whisper | Once per video |

### 5.2 Ollama Client Integration
**File:** `services/ollama_client.py`
- **Base URL:** `settings.OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- **Timeout:** `settings.OLLAMA_TIMEOUT` (default 600s = 10 min)
- **Methods:**
  - `generate(prompt, model, system, format, options)` → raw text response
  - `generate_json(prompt, model, system, schema, options)` → parsed JSON (with reasoning tag stripping)
  - `list_models()` → `[{name, ...}, ...]`
- **JSON Extraction:** Handles markdown fences, `<think>` blocks (reasoning models), and bracket slicing to extract valid JSON even if model emits prose

### 5.3 Parallel LLM Concurrency
- **Per-Worker Limit:** `settings.OLLAMA_MAX_CONCURRENCY` (default 1)
  - Gated by `OllamaService` (centralized semaphore per worker process)
  - For multi-GPU, raise this value
- **Clip Enrichment Parallelism:** `settings.CLIP_CONCURRENCY`
  - Up to N clips enriched in parallel threads
  - Each thread respects the per-worker LLM concurrency limit
  - ThreadPoolExecutor avoids GIL on ffmpeg/reframing (subprocess/C-bound), unblocks on LLM waits

---

## 6. HARDWARE ACCELERATION & GPU SUPPORT

### 6.1 What Requires GPU?

| Component | GPU Needed? | CPU-Only Fallback | Config |
|-----------|-------------|-------------------|--------|
| **faster-whisper** | Optional | Yes, int8 auto-fallback | `WHISPER_DEVICE` (cpu/cuda), auto-fallback if GPU fails |
| **YOLO person detection** | Optional | Yes, CPU mode | `YOLO_DEVICE` (default cpu) |
| **MediaPipe face detection** | Optional | Yes, CPU | Built-in, uses CPU by default |
| **Ollama LLM** | Depends on model | Yes, CPU inference | Ollama-side setting (model-specific) |
| **ffmpeg encoding** | Optional | Yes, libx264/libx265 | `HWACCEL` setting (none/nvenc/qsv/amf/vaapi) |

### 6.2 CPU-Only Pipeline Behavior
**All pipeline stages work without GPU:**
- Whisper: Falls back to `device="cpu"`, `compute_type="int8"`
- Viral detection: Ollama handles CPU/GPU (user's ollama setup)
- Ranking/titles/etc.: Ollama CPU inference (slow but works)
- Captions: Heuristic, no LLM
- Reframing: YOLO runs on CPU (slower but completes)
- Rendering: libx264 (CPU-bound ffmpeg, very slow for 1080p)

**Critical:** CPU-only is **viable** but **slow**. A 60-minute video might take 8–12 hours on a single CPU core.

### 6.3 Hardware Encoder Auto-Detection
**File:** `services/ffmpeg.py`
- Function: `detect_hwaccel()` probes available encoders (nvenc/qsv/amf/vaapi)
- If `settings.HWACCEL="auto"`, tries in order: vaapi → amf → qsv → nvenc → none
- Falls back to libx264 if none available
- Render includes progress parsing from ffmpeg's `-progress` pipe

---

## 7. CONFIGURATION & ENVIRONMENT

### Key Settings (from `core/config.py`)

```python
# LLM / Transcription
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
OLLAMA_DEFAULT_MODEL = "qwen3:32b"
OLLAMA_RANKING_MODEL = "qwen3:32b"
OLLAMA_TIMEOUT = 600
OLLAMA_MAX_CONCURRENCY = 1
WHISPER_MODEL = "base" | "small" | "medium" | "large"
WHISPER_DEVICE = "auto" | "cuda" | "cpu"
WHISPER_COMPUTE_TYPE = "float32" | "float16" | "int8"
WHISPER_CPU_THREADS = 0  # auto

# Processing
CLIP_CONCURRENCY = 2  # parallel clips per worker
MAX_UPLOAD_SIZE_MB = 5000

# Storage
STORAGE_BACKEND = "local" | "s3"
STORAGE_ROOT = "./data/storage"

# Hardware
HWACCEL = "auto" | "none" | "nvenc" | "qsv" | "amf" | "vaapi"
YOLO_DEVICE = "cpu" | "cuda:0"

# Celery
CELERY_BROKER_URL = "filesystem://"  # SQLite-backed queue
WORKER_CONCURRENCY = 2
```

---

## 8. ARCHITECTURE SUMMARY: VIDEO → CLIPS PIPELINE

```
┌─────────────────────────────────────────────────────────────┐
│  INGEST                                                     │
├─────────────────────────────────────────────────────────────┤
│  Upload / YouTube Download (yt-dlp)                         │
│  ↓                                                          │
│  ingest_*_task: FFmpeg probe + thumbnail                   │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  PROCESS_VIDEO_TASK (Celery)                               │
├─────────────────────────────────────────────────────────────┤
│  1. Transcribe (faster-whisper)                            │
│     → Transcript with segments + word-level timing          │
│                                                             │
│  2. Detect Viral Clips (Ollama LLM)                        │
│     → CandidateClip list, snapped to boundaries            │
│                                                             │
│  3. Enrich Each Clip (parallel ThreadPoolExecutor)         │
│     ├─ Rank + Titles + Desc + B-roll (1 LLM call)        │
│     ├─ Captions (heuristic emphasis)                      │
│     ├─ Reframe (YOLO + MediaPipe trajectory)              │
│     └─ Render Preview (ffmpeg, 1080p)                     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  EXPORT (Optional)                                          │
├─────────────────────────────────────────────────────────────┤
│  export_clip_task: render_clip with user's format/res     │
│  → Final MP4/MOV/WebM at chosen resolution                │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. KEY REUSABLE COMPONENTS FOR CAMPAIGN STUDIO

### Functions/Services to Reuse

| Component | File | Exact Name | Purpose |
|-----------|------|-----------|---------|
| **Video Ingest** | `services/youtube.py` | `download(url, dest_path, on_progress)` | Download & metadata from any yt-dlp URL |
| | `workers/tasks.py` | `_probe_and_thumbnail(video_id)` | FFmpeg media analysis |
| **Transcription** | `services/transcription.py` | `transcribe(audio_path, model_size, language, on_progress)` | faster-whisper with progress |
| **Clip Detection** | `services/viral_detection.py` | `detect_viral_clips(segments, target_count, min_seconds, max_seconds, model)` | LLM-based selection |
| **Ranking** | `services/ranking.py` | `rank_clip(title, text, duration, model)` | Score one clip (5 dimensions) |
| **Consolidated Metadata** | `services/clip_meta.py` | `generate_clip_metadata(title, text, duration, model)` | Ranking + titles + desc + broll (1 call) |
| **Titles** | `services/titles.py` | `generate_titles(text, model)` | Platform-specific titles |
| **Descriptions** | `services/descriptions.py` | `generate_description(title, text, model)` | SEO description + hashtags |
| **B-roll** | `services/broll.py` | `suggest_broll(text, model)` | Suggestions with search terms |
| **Captions** | `services/captions.py` | `build_tokens(words)` + `heuristic_emphasis()` | Word-level tokens + emphasis |
| **Reframing** | `services/reframing.py` | `compute_trajectory(source_path, start, end, hq_detection, face_zoom, on_progress)` | Smart cropping trajectory |
| **Rendering** | `services/export.py` | `render_clip(source_path, output_path, start, end, aspect_ratio, resolution, ...)` | ffmpeg pipeline (cut→crop→scale→burn→encode) |
| **Hardware Accel** | `services/ffmpeg.py` | `ffmpeg.probe()`, `ffmpeg.extract_audio()`, encoder auto-detect | FFmpeg wrapper with hwaccel |
| **Ollama Client** | `services/ollama_client.py` | `OllamaClient.generate_json(prompt, model, system, schema, options)` | LLM calls with JSON extraction |
| **Progress Tracking** | `workers/progress.py` | `ProgressTracker(entity_type, entity_id)` | WebSocket progress updates |
| **Storage** | `services/storage.py` | `storage.open_write(key)`, `storage.commit(key)`, `storage.url(key)` | Backend-agnostic file I/O |

### ORM Models to Reuse
- `Clip` (schema + model) — entire clip structure
- `Transcript` — segments + timestamps
- `AIAnalysis` — audit trail for LLM calls
- `Export` — rendered variants

### Endpoints to Reference
- Video endpoints (upload, YouTube, get, status, process)
- Clips endpoints (list, get, patch, regenerate, render)
- Exports endpoints (create, list, get, download)

### Celery Task Patterns
- `_enrich_clip()` → template for per-item parallelized work
- `ProgressTracker` → live dashboard updates
- `session_scope()` → SQLAlchemy session management in workers
- ThreadPoolExecutor pattern → bounded parallelism with resource gating

---

## 10. CRITICAL GAPS & NOTES FOR CAMPAIGN STUDIO

### Missing or Partial Features
1. **No batch/bulk ingest** — `process_video_task` is 1:1 (one video → multiple clips). For a campaign studio ingesting 100 URLs, need a coordinator task.
2. **No video edit timeline** — `ClipUpdate` supports editing times + fields, but no full timeline UI exists.
3. **No clip export options in bulk** — exports are 1:1 clip. Campaign studio might want batch export.
4. **No preset/template UI** — caption config & aspect ratio come from ProcessOptions, but no preset library in the backend (StoryVault has presets, but for a different flow).
5. **Reframe is optional** — `enable_reframe` can be False (pure center crop fallback).
6. **No publish/social posting** — clips are rendered but not auto-posted (that's in the bot/automation layer).

### Environment Assumptions
- **Single Ollama instance** reachable at `OLLAMA_BASE_URL` (centralized)
- **No cloud LLM** — all calls are local Ollama
- **SQLite default** — scales fine for tens of thousands of clips, slower for 100k+
- **Filesystem storage default** — no S3 by default (S3 optional)
- **Celery filesystem broker** — no Redis (filesystem queue works, slower)

### Critical For CPU-Only Setup
1. Use `WHISPER_MODEL=base` (smallest, ~140MB)
2. Use `OLLAMA_DEFAULT_MODEL=qwen2:7b` or smaller (not 32b)
3. Set `WHISPER_CPU_THREADS=N` to match core count (don't oversub)
4. Set `CLIP_CONCURRENCY=1` (single video, single clip at a time)
5. Accept 8–24h render times for 60-min videos
6. Monitor worker memory; whisper + yolo can spike to 4–6GB



## Reusable
- app.services.youtube.download
- app.services.transcription.transcribe
- app.services.viral_detection.detect_viral_clips
- app.services.ranking.rank_clip
- app.services.ranking.normalize_ranking
- app.services.clip_meta.generate_clip_metadata
- app.services.titles.generate_titles
- app.services.titles.normalize_titles
- app.services.descriptions.generate_description
- app.services.descriptions.normalize_description
- app.services.broll.suggest_broll
- app.services.broll.normalize_broll
- app.services.captions.build_tokens
- app.services.captions.heuristic_emphasis
- app.services.captions.render_srt
- app.services.captions.render_vtt
- app.services.reframing.compute_trajectory
- app.services.reframing.build_crop_keyframes
- app.services.export.render_clip
- app.services.export.output_dimensions
- app.services.ffmpeg.ffmpeg.probe
- app.services.ffmpeg.ffmpeg.extract_audio
- app.services.ffmpeg.ffmpeg.extract_thumbnail
- app.services.ollama_client.OllamaClient
- app.services.ollama_client.ollama
- app.services.storage.storage
- app.services.storage.video_source_key
- app.services.storage.video_audio_key
- app.services.storage.clip_preview_key
- app.services.storage.clip_thumb_key
- app.workers.progress.ProgressTracker
- app.models.clip.Clip
- app.models.video.Video
- app.models.transcript.Transcript
- app.models.analysis.AIAnalysis
- app.models.export.Export
- app.schemas.clip.ClipOut
- app.schemas.video.VideoOut
- app.schemas.video.ProcessOptions
- app.schemas.export.ExportOut
- app.schemas.export.ExportCreate

## Gaps
- No batch video ingest coordinator — process_video_task is 1:1, need wrapper for multiple URLs
- No timeline UI in backend — ClipUpdate exists but no full graphical editor API
- No bulk export scheduling — exports are per-clip, no campaign-wide batch renders
- No preset management API — caption/aspect configs hardcoded in ProcessOptions, no campaign presets
- No auto-publish hooks — clips render but don't auto-post to social media (bot layer does this)
- No source validation for URLs — youtube.download will fail on non-yt-dlp URLs (Reddit, TikTok, etc.) without extra handling
- Reframe trajectory may fail silently — if YOLO/MediaPipe fail, falls back to center crop without alerting user
- No clip merge/stitch API — campaign studio may want to combine adjacent clips, not supported
- LLM model availability not enforced — if requested model isn't in Ollama, falls back to default without warning UI
- No watermark/branding system — campaign studio may want logos burned into clips (export.py has no overlay support)
- CPU-only render times unmanaged — no time estimates or queue prioritization (Celery FIFO only)
- No progress webhooks — progress only via WebSocket, no callback/webhook for external integrations

## Key files
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/api/v1/endpoints/videos.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/api/v1/endpoints/clips.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/api/v1/endpoints/exports.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/models/clip.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/models/video.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/models/export.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/schemas/clip.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/schemas/video.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/schemas/export.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/workers/tasks.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/youtube.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/transcription.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/viral_detection.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/clip_meta.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/ranking.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/titles.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/descriptions.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/broll.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/captions.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/reframing.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/export.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/ollama_client.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/ffmpeg.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/services/storage.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/core/config.py
- C:/Users/Anton/OneDrive/Desktop/OpenClip/backend/app/models/enums.py