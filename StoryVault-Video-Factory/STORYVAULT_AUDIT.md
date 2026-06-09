# StoryVault Video Factory — Audit Report

**Date:** 2026-06-09
**Auditor:** senior full-stack / FFmpeg / DB review pass
**Method:** full read of every source file (server, config, schema, DB layer, all 26 services, all routes, all frontend JS/CSS/HTML), plus running the existing test suite and probing the runtime environment.

---

## 0. Verdict up front (honest)

StoryVault is **not a broken mockup**. It is a working v1 that genuinely renders a real
1080×1920 H.264/AAC MP4 end‑to‑end. `npm test` passes **24/24** and the suite invokes
real ffmpeg + SAPI. The environment on this machine is healthy:

| Tool | Result |
|------|--------|
| Node | v25.9.0 (has built‑in `node:sqlite`) |
| ffmpeg / ffprobe | 8.1.1 (Gyan build), on PATH |
| Python | 3.14.4 (for Odysseus) |
| Deps | `express`, `multer` installed |
| DB | `data/database/storyvault.sqlite` present (260 KB), backed up to `data/database/backups/` before this audit |
| Media folders | **all empty** — no footage uploaded, no renders on disk yet |

So the work requested is **not "repair a dead app"** — it is **"transform a functioning v1
into a high‑volume, reference‑matching factory."** The biggest items are *missing features*
(topic card, author intro, highlighted captions, accounts, templates, persistent jobs),
not broken ones. There is, however, a real shortlist of genuine bugs (§4).

---

## 1. System map

### Stack
- **Frontend:** vanilla JS single‑page app. Tiny hyperscript builder `el()` (`public/js/ui.js`),
  hash router + SSE live log (`public/js/app.js`), all pages in `public/js/pages.js` (725 lines),
  API client `public/js/api.js`, one stylesheet `public/css/styles.css`. **No framework, no build step.**
- **Backend:** Express 4 (`server.js`), 4 route modules under `src/routes/`.
- **DB:** SQLite via Node's built‑in `node:sqlite` (`DatabaseSync`) — `src/db/database.js`,
  schema in `src/db/schema.sql`. WAL mode. **Media is never stored in the DB** (paths only) — good.
- **Media tools:** ffmpeg/ffprobe via `spawn` argv (no shell) — `src/services/ffmpeg.js`. Safe on Windows.
- **TTS:** Windows SAPI via `scripts/sapi-tts.ps1`, which emits **real word‑boundary timings**
  (`src/services/tts.js`). Pluggable HTTP providers (Fish/Kokoro) behind `*_TTS_URL`.

### Routes (all under `/api`)
- `meta.js` — `/meta`, `/preferences`, `/system/status`, `/system/test`, `/system/resume-failed`, `/system/logs`, `/dashboard`, `/activity`, `/stream` (SSE).
- `discovery.js` — `/discovery/search|trending|related|import-urls|save`, `/stories…`, `/scripts…`.
- `library.js` — `/backgrounds…`, `/segments…`, `/import/file`.
- `production.js` — `/voices`, `/videos…`, `/review…`, `/batch…`, `/exports…`.

### Database tables (21)
`sources, stories, searches, categories, collections, fingerprints, scripts, backgrounds,
segments, segment_usage, narration, captions, videos, render_jobs, exports, batches,
batch_items, preferences, presets, errors, activity`. Indexed on status/category/external_id/
batch/fingerprint kind+hash. **Missing for the new spec:** `accounts`, `templates`,
`voices` (presets table is generic), and a granular `jobs`/`job_stages`/`workers` system.

### Composition pipeline (the heart)
`pipeline.createVideoForStory` → `scriptGenerator` → `tts` (narration + word timings) →
`captions` (ASS/SRT) → `composer.createVideo` (segment plan) → `composer.buildPreview`/`render`.
The ffmpeg graph (`composer.buildArgs`) is: per‑segment
`scale=W:H:force_original_aspect_ratio=increase,crop=W:H,setsar=1,fps,format=yuv420p` →
`concat` → `subtitles=<ass>` → map `[vout]` + narration audio → H.264/AAC, trimmed with `-t`
to narration length (no frozen tail). **Full‑screen 9:16 with no black bars already works,
and there is no music track** — both match your reference default.

### Story sources
Reddit (public `.json`, or official OAuth when `REDDIT_CLIENT_ID/SECRET` set), Reddit post URLs,
pasted text / Quora‑paste / website‑paste, `.txt/.csv/.json` import, RSS. **No anti‑bot / paywall bypass.**

### Env vars referenced
`PORT`, `HOST`, `FFMPEG_PATH`, `FFPROBE_PATH`, `POWERSHELL_PATH`, `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `*_TTS_URL`. **No `.env.example` exists.**

---

## 2. Button / control test matrix (from your screenshots)

| Control | Wired? | Notes |
|---|---|---|
| Find Stories / Search Stories | ✅ | `POST /discovery/search`, renders results inline below controls. |
| Find Trending | ✅ | `runSearch({sort:'engaging',dateRange:'day'})`. |
| Find Related | ⚠️ | Frontend calls `runSearch({sort:'hidden_gems'})` (a re‑search), **not** the real `/discovery/related/:id` endpoint, which exists but is unused. |
| Search Again | ✅ | Re‑runs last search. |
| Review / Analyze / Save / Exclude | ✅ | All hit real endpoints. |
| Create Video | ✅ | `POST /videos` → full pipeline → Review Queue. |
| Upload footage | ✅ | `multer` + probe + thumbnail; real progress via XHR. |
| Segment Editor (split/loop/mark/delete) | ✅ | All real. |
| Generate Preview | ✅ | Real ffmpeg preview at 540×960. |
| Create & Run Batch | ✅ | Creates batch + items, runs sequentially. |
| Approve / Reject / Regenerate / Edit Script | ✅ | Real. Approve renders + exports. |
| Retry (batch item) | ✅ | Re‑queues item. |
| Export / Download | ✅ | `res.download`. |
| Save Preferences | ✅ | `PUT /preferences`. |
| Test All / Reconnect | ⚠️ | "Reconnect" just calls `/system/test` then reloads — it does **not** restart connections or resume jobs as the spec requires. |
| Open Logs | ✅ | Toggles SSE log panel. |
| Resume Failed Jobs | ⚠️ | Only re‑queues stuck **render_jobs**; does **not** resume interrupted **batches** or pipeline stages. |

**Conclusion:** almost every visible button is genuinely wired. The exceptions are
"Find Related" (calls the wrong path), "Reconnect", and "Resume Failed Jobs" (both shallow).

---

## 3. Does it match the reference video today? (gap analysis)

| Reference requirement | Status today |
|---|---|
| Full‑screen 9:16 gameplay, no black bars | ✅ already (`scale=increase,crop`) |
| No background music | ✅ already (no music input) |
| Gameplay audio muted | ✅ already (only narration mapped) |
| **Stage 1 — story topic card** (Reddit/Quora card) | ❌ **not implemented** |
| **Stage 2 — "Posted by u/username" yellow author intro** | ❌ **not implemented** |
| **Stage 3 — captions with current word highlighted yellow** | ⚠️ a `karaoke` ASS style exists but the **default is plain white `bold`** with no highlight |
| Reusable saved "Full‑Screen Story Gameplay" template | ❌ no template system at all |
| Gameplay categories incl. Fortnite / Rocket League / GTA | ❌ `BACKGROUND_TYPES` lacks them |
| Word‑accurate timing | ✅ SAPI emits real boundaries; ⚠️ non‑SAPI falls back to syllable estimate |

The three intro stages + a saved template are the **headline missing features** and are
Phase 2 work (started in this pass).

---

## 4. Genuine bugs found (not just missing features)

1. **`popularity` is computed but never counted in the overall score.**
   `src/services/scoring.js:153` sums engagement+quality+hook+conflict+ending+video+
   originality+recency. `popularityScore()` is calculated, stored, and shown in the UI bars,
   but **omitted from `overall`** — so a wildly popular post gets no overall credit for it.
   (Weights still sum to 1.0 only because popularity was left out.) → Fix in Phase 4 scoring rebuild.

2. **Reddit health is stuck on "Loading" forever in anonymous mode.**
   `src/services/systemStatus.js:37` returns `{status:'Loading'}` when no OAuth is set. The UI
   (`pages.js` system page + `app.js` mini‑status) renders 'Loading' as a perpetual spinner dot.
   This is exactly the "Reddit card stuck loading" you reported. → Should be a distinct
   `Limited`/`Anonymous` (yellow) state that reflects a real probe, never a forever‑spinner.

3. **Batches do not auto‑resume after an app restart.**
   `src/services/batch.js:15` tracks active batches in an in‑memory `Set`. On restart, items
   persist as `Waiting` but nothing drives them; `systemStatus.resumeFailedJobs()` only touches
   `render_jobs`, not batch items or pipeline stages. Acceptance #17 ("batches survive restarts")
   is only half‑met (data survives, processing doesn't). → Phase 5 persistent job system.

4. **"Find Related" button bypasses the real endpoint.**
   `pages.js` wires it to a generic re‑search instead of `POST /discovery/related/:id`. Cosmetic
   but misleading. → Phase 3.

5. **"Reconnect" / "Resume Failed Jobs" are shallow** (see matrix). → Phase 5/§26.

6. **No duplicate‑prevention at the *library display* layer.** Dedup fingerprints exist and
   the discovery service flags duplicates, but repeated discovery of the same post can still
   create multiple `stories` rows over time (only same‑batch dedup is enforced strongly). The
   "duplicate cards" you saw are most likely the same story re‑inserted across separate searches.
   → Phase 3: enforce upsert‑on‑`external_id`/url/text‑hash and add a "merge duplicates" action.

7. **No `.env.example`, no migration scripts, no accounts/templates/jobs tables, no docs**
   beyond README + the original completion report. → Phases 4–6.

8. **Non‑blocking, but worth noting:** caption fonts assume Arial; transitions are hard cuts
   (no crossfade); `estimateTimings` fallback is proportional (fine, but not forced‑aligned —
   Whisper/Odysseus alignment is the Phase 6 upgrade for non‑SAPI voices).

**Not found (good news):** no SQL injection (all parameterized), no shell‑string ffmpeg (argv only),
no media blobs in the DB, no obvious unhandled‑rejection crashers (server has top‑level guards),
hard‑coded paths are derived from `__dirname` (portable), port/host are env‑overridable.

---

## 5. Fix / build plan (mapped to your phases)

- **Phase 1 (this pass):** audit ✅, DB backup ✅, keep tests green, confirm one render works.
- **Phase 2 (started this pass):** topic card + author intro + yellow‑highlight captions as a
  saved **"Full‑Screen Story Gameplay"** template; real proof render.
- **Phase 3:** compact redesign + Command Center nav; library upsert/merge‑duplicates; rename
  Background→Footage; Video Studio; Batch Factory; fix Find Related.
- **Phase 4:** Reddit/Quora parity + Accounts page (secure tokens); rebuild scoring into the
  transparent 0–100 / 8‑category model with verified/estimated/unavailable labels.
- **Phase 5:** persistent stage‑based jobs (survive restart, resume from last stage), worker
  types, retries/backoff, dead‑letter, resource‑aware scheduling, throughput reporting.
- **Phase 6:** tests, output validation, docs deliverables, Odysseus integration
  (AI rewrite/scoring assist + expressive TTS + Whisper forced alignment).

---

## 6. Decisions taken (so we don't do a risky rewrite)

- **Keep the existing stack** (vanilla‑JS SPA + Express + `node:sqlite`) and evolve it in place.
  Your spec explicitly says "do not attempt a giant untested rewrite," and the base is healthy.
- **Everything additive & migration‑guarded.** New tables/columns via versioned migrations that
  never drop user data; DB backed up before each structural change.
- **Odysseus** is a separate large **Python** AI‑assistant platform (chat/research/RAG/TTS/STT/
  MCP). It is integrated as a **local service StoryVault calls over HTTP** (AI + voice + alignment),
  not merged into the Node app — pending your confirmation of scope (see chat).

---

## 7. Progress log — Phases 2–5 implemented & verified (2026-06-09)

This section records what has actually been built and proven since the audit above.

### Phase 2 — Reference template (DONE, verified with real renders)
- `src/services/overlays.js` — one ASS file renders all three intro stages: vector white
  rounded **topic card** (avatar + subreddit/author + title + red emphasis + real metrics),
  big yellow **author intro** ("Posted by / u/…", thick black outline, auto-fit), and
  **karaoke captions** (current word yellow). Zero new dependencies (burned via the existing
  `subtitles=` path).
- Template system: `src/services/templates-data.js` (8 built-ins, default **Full-Screen Story
  Gameplay**), `src/services/templates.js` (CRUD/resolve), `/api/templates` routes, Templates page.
- Wired into the real pipeline: `composer.applyTemplateIntro` + `pipeline.js` + `tts.synth`.
- Verified: stage frames inspected; the live `/videos` pipeline emits card → author → captions
  over full-screen 9:16 footage with **no music**.

### Phase 3 — Compact redesign (DONE)
- New nav groups (Workspace / Production / System), collapsible icon sidebar, **Command Center**
  with New Production Run + live stat tiles + clickable pipeline strip + measured throughput.
- Duplicate-card bug fixed: `stories.ingest` no longer inserts a row for a strong duplicate.

### Phase 4 — Scoring + Accounts + Reddit/Quora parity (DONE)
- **Scoring** already rebuilt to the transparent 8-category 0–100 model (`scoring.js`), persisted
  (`score_breakdown`/`score_label`/`metrics_provenance`/`score_reasons`) and rendered with a
  "Why this score?" panel. Engagement labelled verified/estimated/unavailable, never fabricated.
- **Accounts**: `accounts` table + `accounts.js` + AES-256-GCM token storage (`util/secrets.js`);
  Reddit OAuth connect/test/disconnect; Quora manual import. The "stuck on Loading" Reddit card
  now reports a yellow **Limited** state.
- **Quora parity (NEW)**: `src/services/sources/quora.js` — `fetchQuestion(url)` parses the PUBLIC
  Quora page's schema.org QAPage JSON-LD (no login / no scraping / no CAPTCHA bypass), extracts
  question + best answer + author + real upvote count, and falls back to manual paste with a clear
  message on a login wall. Wired into `discovery.js` (`source: 'quora'`) and the Story Finder UI
  (Quora question URLs source). Offline parser test (#27) green.

### Phase 5 — Persistent jobs (DONE, verified incl. integration proof)
- `src/services/jobs.js` — jobs + ordered `job_stages`; `checkpointer(jobId)` stores each stage's
  artefact **id** and reloads via getters on resume → resume-from-last-stage. Exponential backoff +
  dead-letter at `max_attempts`. `recoverOrphans()` on boot. (Ports Odysseus' DB-as-truth pattern.)
- `pipeline.createVideoForStory(story, overrides, { stage, jobId })` — checkpointing is **opt-in**;
  no `jobId` → byte-identical legacy path.
- `batch.js` — 1 job per item, retries resume from the failed stage, `stop()` / `resetInterrupted()`
  / `recoverInterrupted()`. `server.js` runs recovery on boot. Route `POST /api/batch/:id/stop`.
- **Exports**: structured naming `YYYY-MM-DD_platform_category_story_template_vN.mp4` + JSON
  **sidecar** with full provenance (story/url/score/script/narration/captions/footage/template).

### Test status
`npm test` → **28/28** (added #25 checkpoint-skip, #26 restart-reset, #27 Quora parser, #28
export-collision; extended #19 to assert structured naming + sidecar). Integration proof
`tests/restart-recovery-proof.js` confirms a batch crashed mid-stage resumes from its last
completed stage (script stage stayed at 1 attempt). All UI changes verified live in the browser
preview with zero console errors.

### Adversarial review pass (multi-agent) + fixes
A 3-lens review (correctness / restart-safety / spec) over the Phase 4/5 diff confirmed and we
fixed three real bugs: (1) **HIGH** export filename collision — two videos from the same
story/template/date overwrote each other; now the version bumps until unique on disk + in the
`exports` table (proven by test #28). (2) **HIGH** `resumeFailedJobs()` could start duplicate
concurrent renders of one video and swallowed errors; now guarded by a per-video Set, supersedes
duplicate jobs, and logs/marks failures. (3) **MEDIUM** a dead-lettered job's item could be
reprocessed once more after a crash; the batch loop now skips items whose job is `dead`.

### Still open (next)
- Story Library table view + merge-duplicates + bulk actions; Video Studio per-stage regen buttons;
  Settings template selector. Worker fleet across machines + resource-aware autoscaling (single-node
  works today). Optional Odysseus HTTP services (AI rewrite/scoring assist, expressive TTS, Whisper
  forced alignment) — current SAPI word-boundary timings already drive accurate captions.

### Footage Library — YouTube URL import (DONE, verified live)
- `src/services/sources/youtube.js` — downloads a PUBLIC YouTube video via the installed
  `python -m yt_dlp` module (≤1080p, merged to MP4, `--max-filesize` guard), then the file flows
  through the SAME `backgrounds.register()` pipeline as an upload (probe → thumbnail → DB), with
  optional auto-segmentation. Restriction errors (private / members-only / age-gated / rate-limit /
  too-large / yt_dlp-missing) are surfaced specifically (spec §22). No restriction bypass.
- Route `POST /api/backgrounds/import/youtube` ({url, category, tags, autoSegment}), with live
  download-percent streamed over the `youtube` progress channel.
- Footage Library UI: "Import gameplay from a YouTube URL" field + button + live progress bar.
- Verified end-to-end (direct service proof + real HTTP route) by importing "Me at the zoo"
  (19s) → registered 320×240 with thumbnail → auto-segmented into 2 clips; test artefacts removed.
  `python -m yt_dlp` is the invocation because the CLI isn't on PATH but the module is installed.
