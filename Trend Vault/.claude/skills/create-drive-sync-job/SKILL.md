---
name: create-drive-sync-job
description: Use this skill when the user wants to send a render job to the home computer via Google Drive — creating a job JSON, dropping it into the Drive requests folder, or building a batch of jobs. Trigger on "send job to home computer", "create a Drive job", "render on home PC", "submit to Drive", "batch render via Drive", "drop job in Drive".
---

# Create and Submit a Google Drive Sync Job

## How the pipeline works
1. **Laptop**: Create a job JSON file → drop into `Google Drive/Zodiac Program Sync/requests/`
2. **Drive syncs** the file to home computer
3. **Home computer**: sync-worker sees the file, processes it, renders the video
4. **Drive syncs** `video.mp4` back to `Google Drive/Zodiac Program Sync/final/`
5. **Laptop**: file appears in `final/` within minutes

## Job JSON format
```json
{
  "id": "my-job-001",
  "type": "render",
  "zodiacSign": "Scorpio",
  "scriptLines": [
    { "text": "Scorpio, your time has come.", "type": "hook", "durationSeconds": 4 },
    { "text": "The transformation begins now.", "type": "escalation", "durationSeconds": 5 }
  ],
  "settings": {
    "zodiacSign": "Scorpio",
    "zodiacSymbol": "♏",
    "backgroundVideo": "stock_pexels_14209304.mp4",
    "colorGrade": "dark",
    "grainType": "film",
    "grainIntensity": 35,
    "fogOverlay": true,
    "rainOverlay": false,
    "slowZoom": true,
    "fps": 30,
    "width": 1080,
    "height": 1920,
    "fontFamily": "Anton",
    "fontSize": 68,
    "textColor": "#FFFFFF",
    "textAnimation": "fade",
    "animSpeed": 1.0,
    "voiceEngine": "auto",
    "captionBgStyle": "none",
    "captionRotate": 0
  }
}
```

## Script-only job (no render, just generate + save script)
```json
{
  "id": "script-001",
  "type": "script-only",
  "zodiacSign": "Scorpio",
  "scriptLines": [
    { "text": "Scorpio, your power is rising.", "type": "hook", "durationSeconds": 4 }
  ]
}
```

## Drop the job
```
Drive requests folder: C:\Users\Anton\Google Drive\My Drive\Zodiac Program Sync\requests\
```
Save the file as `<job-id>.json`. The home computer sync-worker picks it up within `pollIntervalSeconds` (default 10 seconds).

## Check output
```
Drive final folder: C:\Users\Anton\Google Drive\My Drive\Zodiac Program Sync\final\
```
Completed videos appear here as `<job-id>.mp4` or `<folder>/video.mp4`.

## Verify the sync worker is running (on home computer)
```bash
node scripts/sync-worker.js
```
Watch for `[PENDING] Job <id>` → `[PROCESSING]` → `[COMPLETE]`.

## Test the full pipeline (laptop-only, no home computer needed)
```bash
npm run sync:test
# Must print: TEST PASSED — 18/18 checks passed
```
