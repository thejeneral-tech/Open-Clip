# OpenClip Frontend UI Mapping for OpusClip Integration

## Pages

### Project Detail: app/(app)/projects/[id]/page.tsx
- Grid of VideoCard components, responsive 2-4 columns
- Each card shows thumbnail, duration, status, title, clip count, and two buttons (Clips link, Generate)
- Real-time progress polling every 4000ms when any video is busy

### Video Clips Grid: app/(app)/videos/[id]/page.tsx
- Header with video title, duration, clip count, status
- Sort dropdown (score/time) + Generate/Reprocess button
- Processing banner showing real-time progress during generation
- Grid of ClipCard components, responsive 2-5 columns
- Real-time polling every 5000ms while processing

### Clip Editor: app/(app)/clips/[id]/page.tsx
- Two-column layout: Player/Edit panel (left) + Tabbed detail panel (right)
- Tabs: Captions (token editor), Score (ScoreRing + breakdown), Titles, Description, B-roll, Export
- Edit controls: Title input, Start/End time (seconds), Aspect ratio select, Caption style select
- Player shows video preview with processing overlay when busy

## Components

### ScoreRing
Props: score (0-100), size (default 56), label, className
Renders SVG circle with color-coded progress: green (>=80), amber (>=60), orange (>=40), rose (<40)
Center text shows rounded score + optional label

### StatusBadge
Props: status (JobStatus), className
Maps status to icon + label + color variant (secondary/warning/success/destructive)

### ClipCard
Props: clip (Clip object)
Renders: 9:16 thumbnail, ScoreRing (44px), duration badge, play hover overlay
Below: title (line-clamp-2), status badge + confidence%, or progress bar if busy

### VideoCard
Props: video (Video object), projectId
Renders: Aspect-video thumbnail, status badge, duration, title
Below: clip count, or progress bar if busy, or error if failed
Buttons: Clips link (if clips exist), Generate/Reprocess button
Dropdown menu for delete

### CaptionEditor
Props: clip (Clip object)
Renders word tokens as toggle buttons (emphasis = primary bg + bold)
Actions: Click to toggle emphasis, double-click to edit via prompt
Buttons: Save & re-render, AI regenerate, SRT/VTT download links

### ExportPanel
Props: clipId, defaultAspect
Renders: Resolution/Format/Aspect/Burn toggles, Export button
Lists all exports as ExportRow components (status + download link if completed)

### AddVideoDialog
Props: projectId
Tabs: Upload (file input) and URL import (text input for YouTube/Vimeo)
Calls api.uploadVideo or api.importYouTube on submit

### ProcessDialog
Props: videoId, open, onOpenChange
Sliders: target_clip_count (1-50), min/max length (5-90s / 10-120s)
Toggles: aspect ratios (9:16, 1:1, 4:5, 16:9)
Selects: preset template, caption style (karaoke/pop), model
Colors: text + highlight (swatches + custom picker)
Switches: enable_captions, enable_reframe, generate_titles, generate_descriptions, generate_broll

## Hooks

useVideos(projectId, poll?): Lists videos for project, polls every 4000ms if enabled
useVideo(id, poll?): Gets single video, polls every 4000ms if enabled
useClips(videoId, sort, poll?): Lists clips, polls every 5000ms if enabled
useClip(id): Gets single clip
useUpdateClip(): Mutates clip data (title, times, aspect, captions, etc), invalidates cache
useProcessVideo(): Starts clip generation, invalidates video + clips
useExports(clipId, poll?): Lists exports, polls every 3000ms if enabled
useSettings(): Gets user settings (default model, aspect, etc)
useModels(): Lists available LLM models
useSvTemplates(): Lists Story Vault templates (for seeding captions)

## API Methods

api.listVideos(projectId) → Video[]
api.getVideo(id) → Video
api.uploadVideo(projectId, file, title?) → Video (FormData POST)
api.importYouTube(projectId, url, title?) → Video
api.processVideo(id, options: ProcessOptions) → {task_id}
api.listClips(videoId, sort: 'score'|'time') → Clip[]
api.getClip(id) → Clip
api.updateClip(id, data: Partial<Clip>) → Clip
api.regenerateClip(id, opts: {key: true}) → {task_id}
api.listExports(clipId) → Export[]
api.createExport(clipId, data: {format, resolution, aspect_ratio, burn_captions}) → Export
api.exportDownloadUrl(id) → URL with token query param

## Types

Video: id, project_id, source, title, duration_seconds, thumbnail_path, status, progress, clip_count, ...
Clip: id, video_id, start_time, end_time, title, viral_score, ranking_score, confidence, score_breakdown, aspect_ratio, caption_style, captions: CaptionToken[], preview_path, thumbnail_path, status, progress, ...
ScoreBreakdown: hook_strength, emotional_intensity, curiosity_gap, retention_likelihood, platform_suitability (0-100 each), explanation
CaptionToken: word, start, end, emphasis, emoji
BrollSuggestion: start, end, search_terms, scene_description
Export: id, clip_id, format ('mp4'|'mov'), resolution ('720p'|'1080p'|'1440p'|'4k'), aspect_ratio, burn_captions, status, progress, ...
ProcessOptions: target_clip_count, min/max_clip_seconds, aspect_ratios[], caption_style, caption_config (style, primary, highlight), template_id, generate_*, enable_*, model
AspectRatio: '9:16' | '1:1' | '4:5' | '16:9'
CaptionStyle: 'hormozi' | 'modern_tiktok' | 'minimal' | 'gaming' | 'podcast'
JobStatus: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

## Media & Display

Thumbnails: Use .thumbnail_path as &lt;img src&gt;, fallback to Film icon
Preview video: Use clip.preview_path as &lt;video src controls&gt;, fallback text
ScoreRing colors: &gt;=80 green, &gt;=60 amber, &gt;=40 orange, &lt;40 rose
Aspect ratio CSS: 9:16→aspect-[9/16], 1:1→aspect-square, 4:5→aspect-[4/5], 16:9→aspect-video
Progress calculation: Math.round((progress || 0) * 100) for percentage display

## Real-time Updates

useProgress(scope: 'video'|'clip'|'export', id, enabled) returns {status, progress, message, data}
WebSocket URL: wsUrl(scope, id) → wss://host/api/v1/ws/{scope}/{id}?token={token}
Polling intervals: video 4000ms, clip 5000ms, export 3000ms
Invalidate cache on completion to fetch latest snapshot
"

## Reusable
- ScoreRing({ score: number, size?: 56, label?: string, className?: string })
- StatusBadge({ status: JobStatus, className?: string })
- ClipCard({ clip: Clip })
- VideoCard({ video: Video, projectId: number })
- CaptionEditor({ clip: Clip })
- ExportPanel({ clipId: number, defaultAspect: AspectRatio })
- AddVideoDialog({ projectId: number })
- ProcessDialog({ videoId: number, open: boolean, onOpenChange: (v: boolean) => void })
- useVideos(projectId: number, poll?: boolean)
- useVideo(id: number, poll?: boolean)
- useClips(videoId: number, sort?: 'score' | 'time', poll?: boolean)
- useClip(id: number)
- useUpdateClip()
- useProcessVideo()
- useExports(clipId: number, poll?: boolean)
- useSettings()
- useModels()
- useSvTemplates()
- api.listVideos(projectId: number)
- api.getVideo(id: number)
- api.uploadVideo(projectId: number, file: File, title?: string)
- api.importYouTube(projectId: number, url: string)
- api.processVideo(id: number, options: Partial<ProcessOptions>)
- api.listClips(videoId: number, sort: 'score' | 'time')
- api.getClip(id: number)
- api.updateClip(id: number, data: Partial<Clip>)
- api.regenerateClip(id: number, opts: Record<string, boolean>)
- api.listExports(clipId: number)
- api.createExport(clipId: number, data: ExportRequest)
- ProcessOptions type with caption_config, template_id, and feature toggles
- Video type with duration_seconds, thumbnail_path, status, progress
- Clip type with viral_score, ranking_score, confidence, score_breakdown, captions, preview_path
- CaptionToken type with word, start, end, emphasis, emoji
- Export type with format, resolution, aspect_ratio, burn_captions

## Gaps


## Key files
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/app/(app)/videos/[id]/page.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/app/(app)/clips/[id]/page.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/app/(app)/projects/[id]/page.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/clip-card.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/video-card.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/score-ring.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/status-badge.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/clip-editor/export-panel.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/clip-editor/caption-editor.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/add-video-dialog.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/components/process-dialog.tsx
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/hooks/use-api.ts
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/lib/api.ts
- C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src/lib/types.ts