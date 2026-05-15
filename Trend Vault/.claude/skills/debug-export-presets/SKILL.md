---
name: debug-export-presets
description: Use this skill when export presets are broken — the TikTok 9:16 button doesn't change anything, the wrong resolution is sent to the renderer, the IG Square preset produces a 9:16 video, or the resolution label doesn't update. Trigger on "export preset not working", "wrong resolution in render", "TikTok preset broken", "1080x1080 not applying", "resolution not changing", "export button does nothing".
---

# Debug Export Presets

## Files involved
- `frontend/zodiac.html` — `RENDER_PRESETS` object, `selectRenderPreset()`, `state.renderWidth/Height`
- `frontend/zodiac.html` — `renderVideo()` — sends `width/height` in settings
- `scripts/zodiac-render.ts` — reads `settings.width/height/fps`
- `src/ZodiacVideo.tsx` — `calculateMetadata` uses `fps` prop

## Files NOT to touch
- `server.ts` (the server passes settings through untouched)
- `scripts/sync-worker.js`
- `scripts/tts/`

## Preset definitions (in zodiac.html)
```javascript
const RENDER_PRESETS = {
  'tiktok':    { w:1080, h:1920, label:'1080×1920 (9:16)', fps:30 },
  'ig-reel':   { w:1080, h:1920, label:'1080×1920 (9:16)', fps:30 },
  'ig-square': { w:1080, h:1080, label:'1080×1080 (1:1)',  fps:30 },
  'yt-short':  { w:1080, h:1920, label:'1080×1920 (9:16)', fps:30 },
  'yt-wide':   { w:1920, h:1080, label:'1920×1080 (16:9)', fps:30 },
};
```

## Decision tree

### 1. Preset button click does nothing
Check `selectRenderPreset(id)` in `zodiac.html`:
- It must set `state.renderWidth = p.w` and `state.renderHeight = p.h`
- It must update `#exportResLabel` text
- It must highlight the active button

If the function isn't being called: check the button `onclick` attribute matches exactly `selectRenderPreset('tiktok')` (correct string, no typo).

### 2. Resolution label updates but render uses wrong size
`renderVideo()` in `zodiac.html` must include:
```javascript
width:  state.renderWidth  ?? 1080,
height: state.renderHeight ?? 1920,
```
If `state.renderWidth` is undefined (preset was never selected), defaults to 1080×1920. Confirm defaults are correct.

### 3. Render script ignores width/height
In `zodiac-render.ts`, check that `settings.width` and `settings.height` are passed to Remotion's `selectComposition()` and `calculateMetadata()`. In `ZodiacVideo.tsx`, `calculateMetadata` must return `{ width, height, fps, durationInFrames }` using the values from props.

### 4. FPS not applying
`settings.fps` → `zodiac-render.ts` reads it as `const FPS = settings.fps === 60 ? 60 : 30`. The `fps` is passed in the props bag: `(props as any).fps = FPS`. `ZodiacVideo.tsx` `calculateMetadata` reads `(inputProps as any).fps ?? 30`.

### 5. CapCut export note
The TikTok 9:16 button in the export panel is NOT the CapCut button. The CapCut button (`export-to-capcut` skill) requires a running Python server at `localhost:9001`. The TikTok 9:16 preset just sets dimensions for the Remotion render.

## Quick test
```bash
# Confirm render uses 1080x1920:
curl -X POST http://localhost:3001/api/zodiac/render \
  -H "Content-Type: application/json" \
  -d '{"settings":{"zodiacSign":"Scorpio","zodiacSymbol":"♏","width":1080,"height":1920,"fps":30,"durationSeconds":8,"voiceEngine":"auto","captionBgStyle":"none","captionRotate":0},"scriptLines":[{"text":"Test","type":"hook","durationSeconds":6}]}'
# Check zodiac-output/<folder>/video.mp4 dimensions with ffprobe
```
