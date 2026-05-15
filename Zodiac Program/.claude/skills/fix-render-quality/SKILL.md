---
name: fix-render-quality
description: Use this skill when the user complains about render quality issues — choppy motion, low bitrate, banding, color shifts, audio/video desync, frame skipping, captions floating, the render looking different than the preview, or any "the rendered video looks bad" complaint. Trigger proactively on phrases like "render is choppy", "captions are off", "audio is out of sync", "video looks low quality", "60fps render glitches", "frame motion isn't smooth", "this doesn't match what I saw in preview".
---

# Fix render quality issues

The render pipeline has several quality knobs. Map the user's complaint to the right one before changing anything.

## Symptom → likely cause map

| Symptom | First place to look |
|---|---|
| Choppy motion / frame skipping | `fps` in render settings — is it 30 or 60? Is `slowZoom` enabled? |
| Low bitrate / blocky video | `renderQuality` — `standard` / `high` / `ultra` map to CRF 23 / 18 / 14 |
| Banding in dark areas | `renderQuality: 'ultra'` + check that `colorGrade` isn't crushing levels too hard |
| Audio/video desync | Voice was regenerated mid-render OR `captionTopPct` got reset |
| Captions floating / out of sync with words | AssemblyAI either timed out or wasn't called; `meta.json.captionSyncMethod` will say `heuristic-line-duration` if so |
| Preview ≠ render | Filter chain mismatch in HTML vs ZodiacVideo.tsx — see `diagnose-voice-pipeline` for audio side |
| Background video stutters | Source clip is 24fps; Remotion can't reframe-interpolate it at 60fps |
| Text glitches in mid-frame | Animation references something non-deterministic (date/random); should be `frame`-locked |

## How render quality is configured

Two settings in the studio:

1. **FPS selector** — `state.renderFps` (30 or 60). Sent in render request as `settings.fps`. Read by `zodiac-render.ts` line ~140.
2. **Quality selector** — `state.renderQuality` (`standard | high | ultra`). Sent as `settings.renderQuality`. Mapped to FFmpeg CRF inside the render script.

Both default to safe values (30fps / high). 60fps + ultra is the heaviest combo and uses ~3× more CPU/disk.

## When choppiness is real

If the user genuinely has frame skipping at 60fps, check:

1. **Background video frame rate.** Many stock videos are 24/30fps. Remotion plays them at native rate — so a 24fps source on a 60fps render shows the same frame ~2.5 times. That's not "skipping", it's source-limited. Solutions:
   - Pick a 60fps source video (search "60fps" in the stock browser)
   - Drop render fps to 30 (matches most source content)

2. **Concurrency.** `zodiac-render.ts` sets `concurrency = Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2)))`. On low-core machines, this can cause stutter under load. Lower it to 2 for cleaner rendering.

3. **Browser executable.** Remotion uses Chrome Headless Shell by default on Windows, which has a sandbox bug. The render script falls back to system Chrome/Edge via `findSystemBrowser()`. If THAT fails too, renders can produce missing frames silently. Confirm via the log line "Using system browser: Chrome".

## Caption sync fix

If `captionSyncMethod` in `meta.json` is `heuristic-line-duration` instead of `assemblyai-forced-alignment`:

1. Check `.env` has `ASSEMBLYAI_API_KEY=<real_key>`. Without it, the pipeline falls back to even-split timing.
2. AssemblyAI sometimes times out on >2 min audio. If renders >2min are misaligned, this is the cause — consider trimming the script.
3. Even with AssemblyAI, very fast voices (Speed >1.1x) can have ±100ms wobble. That's the engine limit.

## After fixing

Rerender and re-inspect `meta.json`. Compare `fps`, `renderQuality`, `captionSyncMethod` between the broken render and the fixed one — the changes should be obvious in the diff.
