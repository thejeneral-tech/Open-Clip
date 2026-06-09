# StoryVault Video Factory — Completion Report (spec §30)

## Files created (49 source files; nothing pre-existing was changed)

**Root**
`package.json`, `server.js`, `README.md`, `COMPLETION_REPORT.md`, `.claude/launch.json`

**Config & data layer**
`src/config.js`, `src/constants.js`, `src/db/schema.sql`, `src/db/database.js`

**Utilities**
`src/util/ids.js`, `src/util/text.js`, `src/util/rng.js`

**Services (24)**
`logger.js`, `fingerprint.js`, `safety.js`, `analysis.js`, `scoring.js`, `dedup.js`,
`categorizer.js`, `preferences.js`, `stories.js`, `discovery.js`,
`sources/reddit.js`, `sources/textImport.js`, `sources/rss.js`,
`scriptGenerator.js`, `variation.js`,
`ffmpeg.js`, `backgrounds.js`, `segments.js`, `tts.js`, `captions.js`, `composer.js`,
`pipeline.js`, `batch.js`, `review.js`, `systemStatus.js`, `dashboard.js`

**HTTP routes**
`src/routes/helpers.js`, `meta.js`, `discovery.js`, `library.js`, `production.js`

**Frontend**
`public/index.html`, `public/css/styles.css`,
`public/js/api.js`, `public/js/ui.js`, `public/js/app.js`, `public/js/pages.js`

**Scripts & tests**
`scripts/sapi-tts.ps1`, `scripts/init-db.js`, `scripts/seed.js`, `scripts/reset.js`,
`tests/run-tests.js`

## Database tables (21, SQLite via Node's built-in `node:sqlite`)
`sources, stories, searches, categories, collections, fingerprints, scripts,
backgrounds, segments, segment_usage, narration, captions, videos, render_jobs,
exports, batches, batch_items, preferences, presets, errors, activity`
Large media is **never** stored in the DB — rows hold file paths + metadata.

## API routes (REST, all under `/api`)
- **Meta/system:** `GET /meta`, `POST /categories`, `GET/PUT /preferences`,
  `GET /system/status`, `POST /system/test`, `POST /system/resume-failed`,
  `GET /system/logs`, `GET /dashboard`, `GET /activity`, `GET /stream` (SSE)
- **Discovery/stories:** `POST /discovery/search|trending|related/:id|import-urls|save/:id`,
  `GET /discovery/searches`, `GET /stories`, `GET /stories/:id`,
  `POST /stories/:id/status|analyze|script`, `GET /stories/:id/scripts`,
  `POST /stories/bulk`, `GET /stories/export/csv`, `POST /scripts/:id/remix`
- **Library:** `POST /backgrounds/upload`, `GET/PATCH/DELETE /backgrounds/:id`,
  `POST /backgrounds/:id/segments`, `POST/PATCH/DELETE /segments…`,
  `POST /segments/:id/split`, `POST /segments/select`, `POST /import/file`
- **Production:** `GET /voices`, `POST /videos`, `GET /videos[/:id]`,
  `POST /videos/:id/preview|render|variation`,
  `GET /review/queue`, `POST /review/:id/approve|reject|regenerate|edit-script`,
  `POST /batch`, `GET /batch[/:id]`, `POST /batch/:id/run|pause|resume`,
  `POST /batch/items/:id/cancel|retry`, `GET /exports`, `GET /exports/:id/download`

## Pages added (11, single-page app with hash routing)
Dashboard, Story Discovery, Story Library, Background Library, Segment Editor,
Video Composer, Batch Studio, Review Queue, Exports, Preferences, System Status.

## Story sources supported
Reddit communities & post URLs (official OAuth API when `REDDIT_CLIENT_ID/SECRET`
set, else anonymous public JSON + manual fallback), Quora/website paste, pasted
text, `.txt/.csv/.json` file import, RSS/Atom feeds, saved collections.
**No auth/anti-bot/paywall bypass.**

## Scoring formula (0–100, spec §5)
`overall = 0.20·engagement + 0.15·quality + 0.15·hook + 0.15·conflict +
0.10·ending + 0.15·video + 0.05·originality + 0.05·recency`
Popularity & engagement are **log-scaled and normalised per-community** (50%
within-community relative + 50% global anchor) so a small sub isn't out-ranked by a
massive one on raw upvotes. Signals: upvotes, comments, comment/upvote ratio,
awards, age, length, conflict presence, update presence, ending strength, dialogue
presence, controversy (upvote ratio).

## Background upload limits
Per file ≤ **4 GB**; types `.mp4 .mov .mkv .webm .m4v`; up to 20 files per upload
request; stored under `data/backgrounds/{minecraft|nature|custom}/` with a unique
filename (originals never overwritten).

## Video formats / presets
**1080×1920, 9:16, MP4, H.264 (yuv420p) + AAC 160k/48k, 30 fps**, `+faststart`.
Presets: TikTok / YouTube Shorts / Instagram Reels (all 1080×1920). Preview renders
at 540×960 for speed.

## TTS engines connected
Local **Windows SAPI** (default; emits real word-boundary timings for caption sync;
voices: Microsoft David, Microsoft Zira). Pluggable HTTP providers for **Fish
Speech / Kokoro / Trend Vault** via `*_TTS_URL` env vars. Narration is **not**
regenerated when script + voice settings are unchanged (settings-hash cache).

## Render pipeline
ffmpeg argv (no shell): per-segment `scale=…:force_original_aspect_ratio=increase,
crop,setsar,fps,format` → `concat` → `subtitles` (burned ASS captions) → map
`[vout]` + narration audio → H.264/AAC → trimmed with `-t` to the narration length
(fills audio exactly, **no frozen final frame**). Output is re-probed to verify it is
playable and has audio.

## Duplicate-prevention method (spec §9)
Per artefact fingerprints stored in `fingerprints`: exact SHA-256 of source
URL / post id / title / full text, plus a **32-permutation MinHash** signature over
word trigrams for semantic near-duplicate detection (Jaccard ≥ 0.62 ⇒ flagged).
Also fingerprints hooks, endings, background sequences, voice, caption style and
the final render. The Batch Studio + Variation Engine accumulate used segment ids so
no two videos share the same footage sequence; recently-used opening hooks are
auto-rotated.

## Tests completed & results — **24 / 24 passed** (`npm test`, on a clean DB)
Each test runs against the real services; the render tests invoke ffmpeg/SAPI for real.

| # | Test | Result |
|---|------|--------|
| 1+3 | Import pasted Quora-style story | ✓ |
| 2 | Import several stories (`---` separated) | ✓ |
| 4 | Reddit post normalization (offline) | ✓ |
| 5 | Rank stories by engagement | ✓ |
| 6 | Filter by category | ✓ |
| 7 | Reject duplicate stories | ✓ |
| 8 | Upload one MP4 (probe + thumbnail) | ✓ |
| 9 | Upload ten MP4 files | ✓ |
| 10 | Generate thumbnails | ✓ |
| 11 | Divide long video into segments, skip black | ✓ |
| 12 | Avoid previously used segments | ✓ |
| 13 | Generate a 60-second script | ✓ |
| 14 | Generate a 3-minute script | ✓ |
| 15 | Generate narration (with word timings) | ✓ |
| 16 | Synchronize captions | ✓ |
| 17 | Combine five background segments | ✓ |
| 18 | Preview a completed video | ✓ |
| 19 | Render a vertical 1080×1920 MP4 (verified playable + audio) | ✓ |
| 20 | Create projects in a batch | ✓ |
| 21 | Resume a failed project | ✓ |
| 22 | Projects persist across restart | ✓ |
| 23 | Variation does not repeat story + footage combo | ✓ |
| 24 | Original uploaded videos remain unchanged | ✓ |
| + | System status reports all subsystems | ✓ |

A full **browser-driven** run was also verified end-to-end: upload footage → create
segments → generate a video (script→narration→captions→footage→preview) in ~5.7 s →
Review Queue → Approve → render → **exported 1080×1920, 23 s, ~18 MB TikTok MP4**.

## Remaining limitations (honest)
- **Reddit anonymous access is often blocked** from data-center/cloud IPs (HTTP 403).
  Set `REDDIT_CLIENT_ID/SECRET` for the official API, or paste URLs/text. (Works as
  designed — we do not bypass anti-bot protection.)
- **Script rewriting is heuristic** (anonymise, compress, restructure, vary) rather
  than full creative paraphrase. It deliberately does not invent facts, so very short
  source stories yield short scripts; the offline path needs no API key. An AI
  provider can be slotted into `scriptGenerator.js` for richer rewrites.
- **Narration emotion** is approximated via SAPI rate/style mapping (SAPI has no true
  emotion control). External TTS providers can be wired in for expressive voices.
- **"Unusable" footage detection** covers black + frozen sections (ffmpeg
  `blackdetect`/`freezedetect`); detecting game menus/deaths semantically requires
  manual marking in the Segment Editor (supported).
- **Transitions** between segments are clean cuts; crossfades are not yet applied.
- Caption fonts rely on Arial being present (it ships with Windows).

## Exact startup instructions
```powershell
cd C:\Users\Anton\OneDrive\Desktop\StoryVault-Video-Factory
npm install            # express + multer (pure JS; SQLite is built into Node)
npm run init-db        # optional — DB auto-creates on first boot
npm run seed           # optional — adds 5 example stories
npm start              # → http://127.0.0.1:4400
```
Verify the whole pipeline at once with `npm test` (renders a real MP4).
