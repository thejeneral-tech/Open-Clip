---
name: debug-music-system
description: Use this skill when music is broken — the music picker shows nothing, selected music doesn't play in preview, music is absent or too loud/quiet in the rendered video, or the music file upload fails. Trigger on "no music in picker", "music not playing", "music too loud", "music volume slider broken", "music not in render", "can't upload music".
---

# Debug Music System

## Files involved
- `server.ts` line ~87 — `app.use('/music', express.static(MUSIC_DIR))`
- `server.ts` ~108–114 — `musicUpload` multer config (50MB limit)
- `music/` folder — all MP3/WAV music files
- `scripts/zodiac-render.ts` — `ensurePublicLink()` copies music to `public/music/`
- `src/ZodiacVideo.tsx` — `<Audio src={staticFile('music/...')} volume={musicVolume}>`
- `frontend/zodiac.html` — music picker, `state.music`, `state.musicVolume`

## Files NOT to touch
- `backgrounds/` folder
- `scripts/tts/` folder
- `scripts/sync-worker.js`

## Decision tree

### 1. Verify music files are served
```bash
curl -I http://localhost:3001/music/stock_jamendo_1502537.mp3
# Expect: HTTP 200 or 206
```

### 2. Check music folder
```
dir C:\Users\Anton\Desktop\Zodiac Program\music
```
If empty: no music available. Add at least one MP3.

### 3. Music not playing in preview
The preview is a browser `<audio>` element, not Remotion. In `zodiac.html`:
- Find `state.music` — should be the filename (e.g. `stock_jamendo_1502537.mp3`)
- The preview sets `src="/music/<filename>"` on an audio element
- If the audio element plays but the wrong track: `state.music` is stale — check if picker updates `state.music` on selection

### 4. Volume slider broken
`state.musicVolume` (0–100 in UI, divided by 100 for render → 0.0–1.0). Check:
- Slider `oninput` updates `state.musicVolume`
- `updatePreview()` applies the volume to the preview audio element: `audioEl.volume = state.musicVolume / 100`
- `renderVideo()` sends `musicVolume: state.musicVolume / 100` in settings

### 5. Music absent in render
`zodiac-render.ts` calls `ensurePublicLink(ROOT+'music', 'music', publicDir)` — this copies music files into `public/music/` so Remotion's `staticFile('music/<name>')` resolves them.
- If music file was added AFTER the last render: the copy runs at start of each render, so a re-render will pick it up
- If `settings.musicFile` is empty string or `'none'`: render skips music (intended)
- Check `ZodiacVideo.tsx` — `musicFile` prop must be truthy for the `<Audio>` component to render

### 6. Music upload fails
Upload limit is 50MB. Files > 50MB → multer rejects with 413. Files must be MP3 or WAV.

## Quick check
```bash
# Confirm music file renders at correct volume
curl -s http://localhost:3001/api/zodiac/outputs | node -e "
process.stdin.resume();
let d='';process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const f=JSON.parse(d).folders[0];
  if(f) console.log('Last render music:',f.meta?.settings?.musicFile,'vol:',f.meta?.settings?.musicVolume);
});"
```
