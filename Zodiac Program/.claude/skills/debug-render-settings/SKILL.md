---
name: debug-render-settings
description: Use this skill when render settings aren't being applied — the exported video has the wrong resolution, wrong FPS, wrong quality, captionBgStyle or captionRotate not showing in render, font/color wrong in render but correct in preview, or any setting that's visible in the preview but missing in the final MP4. Trigger on "render wrong resolution", "1080x1920 not applying", "render looks different from preview", "rotation not in render", "white box missing in render", "fps wrong in render".
---

# Debug Render Settings

## The render pipeline: settings flow

```
zodiac.html (state) 
  → POST /api/zodiac/render { settings, scriptLines }
    → server.ts: writes job file to zodiac-output/job_<id>.json
      → spawns: npx tsx scripts/zodiac-render.ts (reads job file)
        → builds ZodiacVideoProps
          → passes to Remotion renderMedia()
```

A setting missing at ANY step in this chain won't appear in the render.

## Files to check
- `frontend/zodiac.html` — `renderVideo()` function (builds `settings` object)
- `server.ts` line ~1047 — `POST /api/zodiac/render` (writes job file)
- `scripts/zodiac-render.ts` — reads job, builds `ZodiacVideoProps`
- `src/ZodiacVideo.tsx` — `ZodiacVideoProps` interface + destructuring

## Decision tree

### 1. Is the setting in the render request?
Open browser DevTools → Network → find `/api/zodiac/render` → Payload. Check if the setting is in `settings`. If missing: fix `renderVideo()` in `zodiac.html`.

### 2. Is the setting in the job file?
The job file is `zodiac-output/job_<id>.json`. After clicking Render, open it immediately:
```bash
# Find latest job file
dir C:\Users\Anton\Desktop\Zodiac Program\zodiac-output\*.json
type "zodiac-output\job_<latest>.json"
```
If setting is in request but not in job file: the server's `POST /api/zodiac/render` handler is dropping it (it passes `settings` directly from request body, so this shouldn't happen unless there's a sanitization step).

### 3. Is the setting in ZodiacVideoProps?
In `scripts/zodiac-render.ts`, look at the `props: ZodiacVideoProps = { ... }` block (~line 176). Every setting must be explicitly mapped:
```typescript
captionBgStyle: settings.captionBgStyle ?? 'none',
captionRotate:  settings.captionRotate  ?? 0,
```
Missing here = silently ignored.

### 4. Is the setting in ZodiacVideo.tsx?
In `src/ZodiacVideo.tsx`:
- `ZodiacVideoProps` interface must declare the prop as optional (`?`)
- Main component must destructure it from `props`
- The prop must be passed down to child components (e.g. `<ScriptLineComp captionBgStyle={captionBgStyle}>`)

### 5. Resolution / FPS issues
`settings.width`, `settings.height`, `settings.fps` must all be read in `zodiac-render.ts`. Resolution is passed to Remotion's `selectComposition` → `calculateMetadata`. FPS is passed as `(props as any).fps`. If the exported video is the wrong size, check the `selectComposition` call and `calculateMetadata` in `ZodiacVideo.tsx`.

## Quick audit checklist
Run through this for any broken setting:
- [ ] Present in `renderVideo()` settings object
- [ ] Present in job JSON file
- [ ] Mapped in `zodiac-render.ts` props block
- [ ] Declared in `ZodiacVideoProps` interface
- [ ] Destructured in main `ZodiacVideo` component
- [ ] Passed to relevant child component(s)
