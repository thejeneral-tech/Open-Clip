---
name: debug-render-worker
description: Use this skill when the home computer render worker fails — the Remotion render crashes, the video is produced but has no audio, the render process hangs, the browser can't be found, or the render exits with a non-zero code. Trigger on "render worker crashed", "render failed on home computer", "no audio in render", "remotion error", "browser not found", "render hangs", "render exit code 1".
---

# Debug Home Computer Render Worker

## Files involved
- `scripts/zodiac-render.ts` — main render script (spawned by server or sync worker)
- `scripts/tts/ttsService.ts` — TTS audio generation
- `src/ZodiacVideo.tsx` — Remotion composition
- `public/` — assets copied here before render
- `zodiac-output/<folder>/` — output location

## Files NOT to touch
- `scripts/sync-worker.js` — the watcher, not the renderer
- `frontend/zodiac.html`

## Common failures

### 1. Browser not found / Remotion sandbox error
`zodiac-render.ts` runs `findSystemBrowser()` to locate Chrome or Edge. If none found, Remotion uses its bundled headless shell which may fail on Windows with sandbox restrictions.
```
Fix: Install Chrome or Edge on the home computer.
Check: dir "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

### 2. No audio in rendered video
The TTS step generates voice first, copies it to `public/custom-audio/`. If TTS fails silently, the render continues with no audio.
Check the render log for:
- `✓ Voice audio saved (X KB)` — TTS worked
- `⚠ TTS generation failed` — TTS silently failed, render continued

If TTS fails:
- Edge TTS requires internet access — check home computer is online
- Piper voices must be installed at `piper/voices/`
- Check `voiceEngine` setting: `'auto'` tries local first then Edge; `'edge'` forces Edge

### 3. Render hangs at bundling
Remotion bundles the Remotion app on each render. This takes 30–60s on first run (cache cold) and 5–10s after (warm). If it hangs > 5 minutes:
- Kill the process, check for zombie `npx` processes
- Check `node_modules/` is installed: `npm install`
- Check `src/Root.tsx` and `src/ZodiacVideo.tsx` have no TypeScript errors that prevent bundling

### 4. Exit code non-zero
```bash
# Run manually to see full error:
ZODIAC_JOB_FILE="zodiac-output/job_<id>.json" npx tsx scripts/zodiac-render.ts
```
Full error will print to stdout/stderr.

### 5. Output folder missing video.mp4
Server checks `zodiac-output/<folder>/video.mp4` exists after render. If missing:
- Remotion render failed silently — check exit code
- Output path mismatch — `outputFolder` in job file must match the folder `zodiac-render.ts` writes to

### 6. Memory / OOM crash
4K backgrounds or very long videos (> 3 min) can OOM. Check:
- Background video resolution: keep to 1080p max
- Total render duration: keep under 3 minutes
- Concurrency: `zodiac-render.ts` uses `os.cpus().length / 2` threads, max 8

## Quick manual render test
```bash
# On the home computer, in the project folder:
node -e "
const fs=require('fs');
const job={jobId:'manual-test',outputFolder:'manual-test-output',
  scriptLines:[{text:'Test line',type:'hook',durationSeconds:4}],
  settings:{zodiacSign:'Scorpio',zodiacSymbol:'♏',backgroundVideo:'none',
  backgroundBlur:0,backgroundBrightness:1,grainIntensity:0,grainType:'none',
  fogOverlay:false,rainOverlay:false,slowZoom:false,colorGrade:'none',
  fps:30,width:1080,height:1920,fontFamily:'Inter',fontSize:48,
  textColor:'#ffffff',textAnimation:'fade',animSpeed:1,voiceEngine:'auto',
  vignette:false,durationSeconds:6,captionBgStyle:'none',captionRotate:0,
  musicVolume:0.5,musicFile:'',audioFile:''}};
fs.mkdirSync('zodiac-output/manual-test-output',{recursive:true});
fs.writeFileSync('zodiac-output/job_manual.json',JSON.stringify(job));
console.log('Job written. Run: ZODIAC_JOB_FILE=zodiac-output/job_manual.json npx tsx scripts/zodiac-render.ts');
"
```
