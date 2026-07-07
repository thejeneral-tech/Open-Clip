# Campaign Studio — implementation contract

A new **Studio** inside the Whop Campaigns stack: an OpusClip-style flow that turns a long
video into scored vertical clips **for a chosen campaign**, then submits a finished clip back
to the campaign. It REUSES the existing OpenClip clip engine (yt-dlp ingest → faster-whisper
transcribe → ollama viral detection + scoring → ffmpeg reframe/caption/render → exports). We do
NOT reimplement clipping.

Read these first: `.claude/whop-analysis/studio-backend.md`, `studio-frontend.md`,
`studio-integration.md`, and the original `DESIGN.md` (Whop stack). Follow house style exactly
(see frontend.md/backend.md). Every contract name below is used across agents in parallel —
match them verbatim; note deviations in "concerns", never silently rename.

## Architecture decision

Videos require a `project_id` (NOT NULL). So each campaign gets ONE auto-provisioned OpenClip
Project as its clip workspace; the Studio drives the existing video/clip/export endpoints
against that project and tags nothing else. Link stored as `whop_campaigns.studio_project_id`.

Flow: pick campaign → ensure studio project → drop link / upload → (auto) process → clips grid
with virality scores → open clip (modal: player + score + scene analysis + actions) → Export /
Submit to campaign (creates a WhopSubmission).

## Backend

### `backend/app/models/whop.py` (edit WhopCampaign)
Add one additive nullable FK (SQLite db_init auto-adds it):
```python
studio_project_id: Mapped[int | None] = mapped_column(
    ForeignKey("projects.id", ondelete="SET NULL"), index=True, nullable=True, default=None
)
```
(Import Project isn't needed — FK is by table name. Keep import list unchanged.)

### `backend/app/schemas/whop.py`
Add to `WhopCampaignOut`: `studio_project_id: int | None = None`.
New schema: `class WhopStudioOut(BaseModel): project_id: int; campaign_id: int`.

### `backend/app/api/v1/endpoints/whop.py`
- In `_campaign_out`, pass through `studio_project_id` (model_validate already carries it).
- New route:
```
POST /whop/campaigns/{campaign_id}/studio  -> WhopStudioOut
```
Ensures the campaign has a workspace Project. Logic in an `_ensure_studio_project(db, user, campaign)`
helper: if `campaign.studio_project_id` is set AND that Project still exists and is owned by the
user, reuse it; else create `Project(owner_id=user.id, name=f"Whop · {campaign.name}"[:255],
description="Clip workspace for the Whop campaign.")`, flush, set `campaign.studio_project_id`,
commit. Return `WhopStudioOut(project_id=..., campaign_id=campaign.id)`. Import `Project` from
`app.models`. Idempotent: second call returns the same project_id.

### `backend/alembic/versions/0018_whop_studio_project.py`
Hand-written, revision `0018_whop_studio_project`, down_revision `0017_whop`, docstring noting
SQLite gets it via app.db_init. `op.add_column("whop_campaigns", sa.Column("studio_project_id",
sa.Integer(), sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True))` +
`op.create_index("ix_whop_campaigns_studio_project_id", "whop_campaigns", ["studio_project_id"])`.
downgrade drops index then column.

### `backend/app/tests/test_whop_api.py` (append)
Test: create campaign → `POST /whop/campaigns/{id}/studio` returns a project_id; the campaign GET
now echoes the same `studio_project_id`; calling studio again returns the SAME project_id
(idempotent). Do NOT run the heavy clip pipeline in tests.

## Frontend

House style mandatory (shadcn ui, sonner, Loader2, no oc-* classes). Reuse existing engine hooks
from `hooks/use-api.ts` — they already exist: `useProjects`, `useCreateProject`, `useVideos(projectId, poll)`,
`useVideo(id, poll)`, `useProcessVideo()`, `useClips(videoId, sort, poll)`, `useClip(id)`,
`useUpdateClip()`, `useExports(clipId, poll)`, `useModels()`, `useSettings()`. And api methods:
`api.importYouTube(projectId, url, title?)`, `api.uploadVideo(projectId, file, title?)`,
`api.processVideo(id, options)`, `api.listClips`, `api.getClip`, `api.createExport(clipId, {format,resolution,aspect_ratio,burn_captions})`,
`api.exportDownloadUrl(id)`. Reuse components: `ScoreRing` (`@/components/score-ring`, props `{score,size?,label?,className?}`),
`StatusBadge` (`@/components/status-badge`, `{status}`). Whop bits: `RatePill`, `BudgetBar`,
`PlatformIcons`, `platformLabel`, `WHOP_PLATFORMS` from `@/components/whop/platform-meta`.

Types already present: `Video`, `Clip`, `Export`, `ProcessOptions`, `AspectRatio`, `CaptionStyle`
in `lib/types.ts`. Clip has: `id, video_id, start_time, end_time, duration, title, reasoning,
transcript_text, description, viral_score, ranking_score, confidence, score_breakdown{hook_strength,
emotional_intensity,curiosity_gap,retention_likelihood,platform_suitability,explanation}, aspect_ratio,
caption_style, preview_path, thumbnail_path, status, progress, ...`. Video has `id, project_id,
title, duration_seconds, thumbnail_path, status, progress, clip_count, stage, error`.
NOTE: `preview_path`/`thumbnail_path` on Clip and Video are already enriched to `/media/...` URLs
by the backend Out schema (usable directly as `<img src>`/`<video src>`).

### `lib/types.ts`
Add `studio_project_id: number | null` to `WhopCampaign`. Add
`export interface WhopStudio { project_id: number; campaign_id: number }`.

### `lib/api.ts`
Add `whopEnsureStudio: (campaignId: number) => request<WhopStudio>(\`/whop/campaigns/${campaignId}/studio\`, { method: "POST" })`.

### `hooks/use-api.ts`
Add `useWhopEnsureStudio()` — a mutation `(campaignId:number)=>api.whopEnsureStudio(campaignId)`,
onSuccess invalidates `["whop-campaign"]`. Returns the WhopStudio ({project_id}).

### `components/layout/Sidebar.tsx`
Add a 5th item to the `whop` section, BETWEEN Campaigns and Review:
`{ href: "/whop/studio", label: "Studio", icon: Scissors }`. Import `Scissors` from lucide-react.

### Env note (not a code change, but the studio must handle it)
The configured ollama model `qwen3:32b` may not be installed. The Studio's process call MUST pass
an explicit `model` from `useModels()` (default to the first available model name) so "Get clips"
works on this machine. If `useModels()` returns empty, omit model (backend default).

### `components/whop/studio-shared.tsx` (new) — shared studio pieces
Export:
- `scoreGrade(n: number): string` — 0-100 → letter ("A+"≥93,"A"≥85,"A-"≥80,"B+"≥75,"B"≥68,"B-"≥60,"C"≥45,"D"<45).
- `videoStageLabel(v: Video): string` — friendly pipeline label from status/stage/progress:
  queued/ingest→"Downloading…", processing+stage transcribe→"Transcribing…", stage detect→"Finding viral moments…",
  stage/render→"Rendering clips…", completed→"Ready", failed→"Failed". Keep it a simple switch on
  status+stage with sensible fallbacks.
- `StudioClipCard({ clip, onOpen }: { clip: Clip; onOpen: (c: Clip) => void })` — mirrors ClipCard
  visuals (9:16 thumbnail, ScoreRing size 44 top-right using `clip.ranking_score || clip.viral_score`,
  duration badge, hover play) but is a `<button>` calling `onOpen(clip)` (NOT a Link). Title line-clamp-2,
  StatusBadge + confidence when idle, Progress bar when busy (status processing/queued).
- `ClipDetailModal({ clip, campaign, open, onOpenChange, onSubmit }: { clip: Clip | null; campaign: WhopCampaign;
  open: boolean; onOpenChange: (o:boolean)=>void; onSubmit: (clip: Clip)=>void })` — OpusClip-style Dialog
  (`DialogContent className="sm:max-w-4xl"`). Layout: three columns on lg (`grid gap-4 lg:grid-cols-[auto_1fr_1fr]`):
    (1) left rail: big `ScoreRing score={clip.ranking_score||clip.viral_score} size={72}`, then grade rows
        Hook/Flow/Value/Trend mapping score_breakdown → {hook_strength, retention_likelihood, emotional_intensity,
        platform_suitability}, each `label + scoreGrade(value)` (— when breakdown missing).
    (2) center: `<video src={clip.preview_path} controls className="aspect-[9/16] w-full rounded-lg bg-black" />`
        (fallback muted "Preview still rendering…" when no preview_path), duration + time range under it.
    (3) right: "Scene analysis" heading, `clip.reasoning` paragraph, then `clip.transcript_text` in a
        scrollable `max-h-64 overflow-y-auto` muted block; hashtags as chips if present.
  Footer action rail: "Download HD" (creates a 1080p mp4 export via createExport then opens
  exportDownloadUrl in a new tab — show Loader2 while the export is queued/rendering; poll useExports),
  "Edit clip" (link to `/clips/${clip.id}` — the full existing editor), and primary "Submit to campaign"
  (calls `onSubmit(clip)`). Keep the rail simple and clean.
- `SubmitClipDialog({ clip, campaign, open, onOpenChange }: {...})` — Dialog (`sm:max-w-md`) that creates a
  WhopSubmission via `useWhopCreateSubmission()`. Fields: Title (prefilled `clip.title`), Platform
  (Select from WHOP_PLATFORMS, default first of `campaign.platforms` or "tiktok"), Post URL (Input,
  required, placeholder "https://www.tiktok.com/@you/video/… (your posted clip)", helper "Paste the link
  to your posted clip once it's live."), Views (number, default 0), Notes (Textarea, optional). On submit:
  `createSubmission.mutateAsync({ campaignId: campaign.id, data: { platform, post_url, title, views, notes } })`,
  toast.success("Submitted to campaign"), close. Errors via toast. Busy Loader2.

### `app/(app)/whop/studio/page.tsx` (new) — Studio home / campaign picker  [Segment 1]
"use client". Container `mx-auto max-w-6xl space-y-6`. Header "Studio" / "Turn long videos into
viral clips for your campaigns — pick a campaign to start." `useWhopCampaigns()`.
- Loading Loader2; empty state Card (Scissors icon, "No campaigns yet. Create a campaign first, then
  clip for it." + Button link to /whop/campaigns).
- Grid `md:grid-cols-2 lg:grid-cols-3` of campaign preview cards (reuse the marketplace card look):
  thumbnail (9x9 rounded, img or amber gradient + Megaphone), name, RatePill, description line-clamp-2,
  BudgetBar, PlatformIcons, and a footer row: `whop_url` → external "Open on Whop" link
  (`ExternalLink`, target _blank, only when set) + primary Button "Start clipping" → `router.push(\`/whop/studio/${c.id}\`)`
  (or Link). Card itself (excluding the external link) navigates to the studio on click.

### `app/(app)/whop/studio/[campaignId]/page.tsx` (new) — the OpusClip studio  [Segments 2 & 3]
"use client". `useParams()` → `Number`. `useWhopCampaign(campaignId, true)`.
Ensure workspace: on mount `useWhopEnsureStudio().mutateAsync(campaignId)` once → store `projectId`
in state (guard with a ref so it fires once). While projectId unknown → Loader2.
`useModels()` for the model list; `defaultModel = models[0]?.name`.
`useVideos(projectId, true)` (poll) once projectId known. `useProcessVideo()`.

Layout (`mx-auto max-w-5xl space-y-6`):
1. Back link → `/whop/studio` ("← Studio").
2. Campaign header row: thumbnail 12x12, h1 name + status Badge, RatePill, and (if whop_url)
   "Open on Whop" external link. Requirements as compact chips (max ~6, "+N more") so the clipper
   sees the rules while clipping. Subtle.
3. **The drop card** (OpusClip look): a Card, centered content, `max-w-2xl mx-auto`:
   - Tabs "Paste link" / "Upload".
   - Paste link: Input with a Link icon and placeholder "Drop a video link (YouTube, Vimeo, …)",
     helper line "Supports YouTube, Vimeo, Twitch, and most public video links.".
   - Upload: file Input `accept="video/*"`.
   - A compact settings Popover/row ("Clip settings"): number of clips (Input 1–30, default 10),
     aspect ratio (Select default 9:16), captions on/off (Switch, default on), and a Model Select
     from `useModels()` (default `defaultModel`). Keep it small and optional — sensible defaults so
     users can ignore it.
   - Big primary Button "Get clips in 1 click" (full width). Disabled while a submit is in flight or
     projectId unknown.
   On submit (the "1 click"):
     - link tab: `const v = await api.importYouTube(projectId, url)`; upload tab: `const v = await
       api.uploadVideo(projectId, file)`. (Use the mutation-style with try/catch + toast. You may call
       `api.*` directly and invalidate `["videos", projectId]` via `useQueryClient`, matching AddVideoDialog.)
     - Mark `v.id` as "awaiting auto-process" (a `Set<number>` in a ref/state).
     - toast.success("Downloading & analyzing… clips will appear below.").
   - **Auto-process on ready**: a `useEffect` on the videos list — for any video whose id is in the
     awaiting set AND `status === "completed"` AND `clip_count === 0`: call `processVideo.mutateAsync({
     id, options: { target_clip_count, aspect_ratios:[aspect], enable_captions, model: chosenModel } })`,
     then remove it from the awaiting set (guard against double-fire with the set). This gives the
     one-click ingest→clip feel. Wrap in try/catch (toast on error, still drop from set).
4. **Videos & clips**: for each video in `useVideos` (newest first), a section:
   - Row: video title (or "Source video #id"), `videoStageLabel(v)` + a Progress bar when busy
     (`v.status` processing/queued → `Math.round((v.progress||0)*100)`), and a manual "Generate clips"
     Button (calls the same processVideo with chosen options) shown when status completed AND
     clip_count === 0 AND not currently awaiting (fallback if auto-process didn't fire), plus a small
     "Reprocess" affordance is optional. `v.error` shown as text-destructive when failed.
   - Clips grid: `useClips(v.id, "score", true)` → `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3`
     of `StudioClipCard` with `onOpen={openClip}`. (It's fine to call useClips per video via a small
     child component `<VideoClips video onOpen />` so hooks aren't in a loop.)
   - Empty (video ready, 0 clips, not processing): muted "No clips yet — hit Generate clips."
5. Global empty state (no videos at all yet): a friendly muted note under the drop card ("Paste a
   link above to get your first set of clips.").
6. `ClipDetailModal` (openClip state) with `onSubmit={(c)=>{ setClipDetailOpen(false); setSubmitClip(c); }}`
   and `SubmitClipDialog` (submitClip state). Both from studio-shared.tsx.

Keep it visually clean and simple (Segment 3): generous spacing, the drop card is the hero, clips
grid reads like OpusClip. No dense tables.

## Verification
Backend: from `backend/`, `.venv/Scripts/python.exe -m pytest app/tests/test_whop_api.py -q` and the
full suite; `.venv/Scripts/python.exe -m ruff check app`. Frontend: `npm run typecheck`, `npm run lint`,
`npm run test`. Fix until green. (Live pipeline smoke test is done separately by the main agent with
the Celery worker running + an installed model.)
