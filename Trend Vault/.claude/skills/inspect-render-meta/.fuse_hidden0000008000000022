---
name: inspect-render-meta
description: Use this skill when the user wants details about a recent render, asks "what was rendered", "show me the latest meta", "check the metadata", "what voice did I use", "what FPS was that", "look at the last render's settings", or any question that boils down to inspecting `meta.json` for a video output. Use proactively whenever the user references a render output by date, sign, or "the last one".
---

# Inspect render meta

Every render writes a `meta.json` to `trend-vault-output/<DATE>_<SIGN>_<JOBID>/meta.json`. It's the source of truth — if you want to know what was actually used, read this file.

## Step 1: Find the latest render folder

If the user didn't specify a folder, list `trend-vault-output/` and pick the most recent (folder names are date-prefixed, but mtime is more reliable):

```
Glob: C:\Users\Anton\Desktop\Trend Vault Program\trend-vault-output\*\meta.json
```

Pick the path with the latest modification time.

## Step 2: Read it

The schema (as of the cinematic-narrator pass):

```json
{
  "trendVaultSign": "Scorpio",
  "topic": "Scorpio",
  "createdAt": "2026-05-09T13:42:11.123Z",
  "durationSec": 87.33,
  "fps": 60,
  "width": 1080,
  "height": 1920,
  "renderQuality": "ultra",
  "lines": 17,
  "captionSyncMethod": "assemblyai-forced-alignment",
  "audioFile": "trend_vault_voice_<jobId>.mp3",
  "audioSampleRate": 44100,
  "musicFile": null,
  "visualStyle": "analog",
  "backgroundAsset": "stock_pexels_35806649.mp4",
  "outputFile": "video.mp4",
  "renderStatus": "done",
  "voicePreset": "ancient_king",
  "voiceEngine": "auto",
  "throatDepth": 85,
  "ancientRasp": 35,
  "royalPace": 70,
  "chamberSpace": 55,
  "punctuationMode": "royal-pace-driven"
}
```

## Step 3: Surface what matters

Don't dump the whole JSON unless the user asks. Lead with what likely matters:

- **Voice settings** — which preset, which engine actually ran (`voiceEngine` says `auto` but if Kokoro was reachable, the actual MP3 came from Kokoro; the engine field doesn't record that. Cross-check with the file itself if needed)
- **Caption sync** — `assemblyai-forced-alignment` means word-level timing; `heuristic-line-duration` means even-split fallback
- **Duration / FPS / quality** — for "is this actually 60fps" type questions
- **Visual style** — color grade + background asset

## When the user is debugging

If they say "the voice changed between renders", show them `voicePreset` + the 4 cinematic sliders for both renders side by side. The diff explains the audio difference.

If they say "captions are floating", check `captionSyncMethod`. If it's `heuristic-line-duration`, AssemblyAI either timed out or `ASSEMBLYAI_API_KEY` is missing.

If they say "the render is the wrong length", check `durationSec` vs the script's expected length — the server-side length-rescaling (rescales script-line durations to match actual voice audio length) might have kicked in.

## When meta.json is missing

The render didn't finish. Check the `outputFile` (`video.mp4`) — if it exists but `meta.json` doesn't, the render likely crashed in the post-write phase. Look at the server logs.
