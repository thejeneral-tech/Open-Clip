---
name: debug-background-video
description: Use this skill when background videos are broken — the background picker shows no videos, a selected background doesn't appear in the preview, the background isn't in the render, a background video causes a render crash, or the video loops incorrectly. Trigger on "no backgrounds showing", "background not loading", "background picker empty", "background black in render", "background video crash", "looping issue".
---

# Debug Background Video System

## Files involved
- `server.ts` line ~87 — `app.use('/backgrounds', express.static(BACKGROUNDS))`
- `backgrounds/` folder — all background MP4/MOV files live here
- `frontend/zodiac.html` — background picker UI, `state.background`
- `src/ZodiacVideo.tsx` — `BackgroundVideo` component, `OffthreadVideo`
- `scripts/zodiac-render.ts` — `ensurePublicLink()` copies backgrounds to `public/`

## Files NOT to touch
- `scripts/sync-worker.js`
- `scripts/tts/` folder

## Decision tree

### 1. Verify files are served
```bash
curl -I http://localhost:3001/backgrounds/stock_pexels_14209304.mp4
# Expect: HTTP 200 or 206
```
If 404: the file doesn't exist in `backgrounds/` OR the static route is broken.

### 2. Check backgrounds folder contents
```
dir C:\Users\Anton\Desktop\Zodiac Program\backgrounds
```
All `.mp4` and `.mov` files here are served. Empty folder = empty picker.

### 3. Check how picker loads videos
In `zodiac.html`, find where backgrounds are fetched. The picker likely reads files listed by `GET /backgrounds/` or uses a known static list. If it's a static list hardcoded in the HTML, adding a new video won't show it until the list is updated.

### 4. Check preview display
In `zodiac.html`, `updatePreview()` sets the preview video src to `/backgrounds/<filename>`. If `state.background` is `'none'` or null, no video is shown (correct). If it's set but the video is black:
- The browser may block autoplay — check the preview video element has `muted` and `autoplay` attributes
- The video codec may not be browser-supported — use H.264 MP4 only

### 5. Check render pipeline
`scripts/zodiac-render.ts` calls `ensurePublicLink()` to copy `backgrounds/` → `public/backgrounds/` before rendering. Remotion uses `staticFile('backgrounds/<name>')` which resolves to `public/backgrounds/<name>`. If:
- The file is in `backgrounds/` but not in `public/backgrounds/` → `ensurePublicLink` ran before the file was added; re-render to trigger copy
- The file is a format Remotion can't decode (HEVC, VP9) → convert to H.264

### 6. Looping
`BackgroundVideo` in `ZodiacVideo.tsx` uses Remotion's `<OffthreadVideo loop>`. If the video is shorter than the total render duration, it loops automatically. If looping produces a hard cut: the video doesn't have a clean loop point — no code fix, use a different video.

## Quick check
```bash
# List served backgrounds
curl -s http://localhost:3001/backgrounds/
```
