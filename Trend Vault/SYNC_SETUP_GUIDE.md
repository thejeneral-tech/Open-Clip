# Trend Vault Program — Sync Setup Guide

This system lets your laptop hand jobs off to your home computer over Google Drive.
Your home computer does all the heavy work (script generation, TTS, Remotion rendering)
locally on its own SSD — Google Drive is only used to pass files back and forth.

---

## How It Works (Plain English)

```
YOUR LAPTOP                    GOOGLE DRIVE (bridge)         HOME COMPUTER
───────────                    ─────────────────────         ─────────────
Drop a job JSON     ──────→    requests/job.json   ──────→   Worker reads it
Drop source file    ──────→    uploads/video.mp4   ──────→   Copied to local SSD
(for clip jobs)                                              Runs the pipeline
                    ←──────    final/output.mp4    ←──────   Result put back
You see the result
```

Google Drive is a **mailbox only** — nothing runs inside it.

---

## Folder Reference

### Google Drive folders (the mailbox)

| Folder | What goes there |
|--------|----------------|
| `Trend Vault Program Sync/requests/` | You drop job JSON files here |
| `Trend Vault Program Sync/uploads/` | You drop source video files here (clip jobs only) |
| `Trend Vault Program Sync/final/` | Finished videos appear here |
| `Trend Vault Program Sync/logs/` | Log lines mirrored here |

### Home computer local folders (the real workspace)

| Folder | Purpose |
|--------|---------|
| `C:\Trend Vault Program\incoming\` | Files land here after being copied from Drive |
| `C:\Trend Vault Program\working\` | Files move here during active processing |
| `C:\Trend Vault Program\cache\` | Render cache — never synced |
| `C:\Trend Vault Program\renders\` | Intermediate render files |
| `C:\Trend Vault Program\final\` | Completed outputs (also copied to Drive final) |
| `C:\Trend Vault Program\logs\` | Full worker logs |

---

## One-Time Setup (Home Computer Only)

### Step 1 — Confirm your paths in sync.config.json

Open `sync.config.json` in the project folder. Check three things:

```json
{
  "homeLocalRoot": "C:\\Trend Vault Program",
  "googleDriveRoot": "C:\\Users\\Anton\\Google Drive\\My Drive\\Trend Vault Program Sync",
  "projectRoot": "C:\\Users\\Anton\\Desktop\\Trend Vault Program"
}
```

- **homeLocalRoot** — where local working folders will be created (keep as-is)
- **googleDriveRoot** — where Google Drive lives on your home computer.
  To find it: open Google Drive app → gear icon → Preferences → Folder location.
  Common paths: `C:\Users\Anton\Google Drive\My Drive\...` or `G:\My Drive\...`
- **projectRoot** — the full path to this Trend Vault Program project folder on your home computer.

### Step 2 — Create all folders (run once)

```
npm run setup:sync
```

### Step 3 — Start the worker

```
npm run sync:worker
```

Leave this terminal window open. The worker checks Google Drive every 10 seconds.

### Step 4 — Test it

```
npm run sync:test
```

You should see `EXISTS ✓` for both local and Drive outputs at the end.

---

## Supported Job Types

| type | What it does | Requires |
|------|-------------|---------|
| `render` | Full pipeline: script gen + TTS + Remotion video | ANTHROPIC_API_KEY (or pre-written scriptLines) |
| `render` with scriptLines | TTS + Remotion video using your script | Nothing extra |
| `script-only` | Generates script JSON, no video | ANTHROPIC_API_KEY |
| `tts` | Generates MP3 voiceover from script lines | Nothing extra |
| `clip` | Extracts short clips from a long video | ASSEMBLYAI_API_KEY, source file in uploads/ |

---

## How to Send a Job

### For a full trend-vault video render

1. Create a job file like this and save it as `job-scorpio-001.json`:

```json
{
  "jobId": "scorpio-dark-001",
  "type": "render",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",

  "script": {
    "trendVaultSign":    "Scorpio",
    "emotionalTone": "dark",
    "prompt":        "why they go silent and pull away",
    "targetDuration": 100
  },

  "voice": {
    "presetId": "en-US-DavisNeural",
    "rate":     "-15%",
    "pitch":    "-5Hz"
  },

  "settings": {
    "backgroundVideo":      "stock_pexels_34837491.mp4",
    "colorGrade":           "dark",
    "grainType":            "film",
    "grainIntensity":       0.35,
    "backgroundBlur":       2,
    "backgroundBrightness": 0.65,
    "fogOverlay":           true,
    "rainOverlay":          false,
    "slowZoom":             true
  }
}
```

2. Drop it into:
   ```
   Google Drive → Trend Vault Program Sync → requests → job-scorpio-001.json
   ```

3. Wait for Google Drive to sync (tray icon stops spinning).

4. The home computer worker will:
   - Detect the `pending` job
   - Generate the script with Claude
   - Generate TTS voice audio
   - Run the Remotion renderer
   - Put the finished `.mp4` in `Google Drive → Trend Vault Program Sync → final`

### For a render using your own script (no Claude needed)

Same job file but replace the `"script"` block with `"scriptLines"`:

```json
{
  "jobId": "virgo-custom-001",
  "type": "render",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",

  "scriptLines": [
    { "text": "You notice things no one else sees.",  "type": "hook",        "durationSeconds": 3.0 },
    { "text": "The small inconsistencies.",           "type": "observation", "durationSeconds": 3.5 },
    { "text": "Virgo — your standards are not too high.", "type": "twist",  "durationSeconds": 3.5 },
    { "text": "The world has just never matched them.", "type": "ending",    "durationSeconds": 4.0 }
  ],

  "voice": { "presetId": "en-US-DavisNeural", "rate": "-12%", "pitch": "-3Hz" },

  "settings": {
    "trendVaultSign":  "Virgo",
    "colorGrade":  "ash",
    "backgroundVideo": "stock_pexels_35806649.mp4"
  }
}
```

### For a TTS voiceover only

```json
{
  "jobId": "tts-capricorn-001",
  "type": "tts",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",
  "voice": { "presetId": "en-US-DavisNeural", "rate": "-15%", "pitch": "-5Hz" },
  "scriptLines": [
    { "text": "You keep going when everyone else has stopped.", "type": "hook",    "durationSeconds": 3.5 },
    { "text": "That is not stubbornness.", "type": "twist",   "durationSeconds": 3.0 },
    { "text": "That is who you are.",      "type": "ending",  "durationSeconds": 3.0 }
  ]
}
```

### For extracting clips from a long video

```json
{
  "jobId": "clip-podcast-001",
  "type": "clip",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",
  "inputFile": "my-long-video.mp4"
}
```

Also drop `my-long-video.mp4` into `Google Drive → Trend Vault Program Sync → uploads/` before creating the job.

---

## Available Settings Reference

### script block
| Field | Values | Default |
|-------|--------|---------|
| trendVaultSign | Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces | required |
| emotionalTone | mysterious, dark, emotional, reflective, dramatic, intimate, melancholic, calm, motivational | dark |
| prompt | Any text describing the topic/angle | "" |
| targetDuration | Number of seconds (60–120) | 100 |

### voice block
| Field | Values | Default |
|-------|--------|---------|
| presetId | Any Edge TTS voice name — see list below | en-US-DavisNeural |
| rate | e.g. "-15%" (negative = slower) | -10% |
| pitch | e.g. "-5Hz" (negative = lower) | -3Hz |

**Recommended voices for dark trend-vault content:**
- `en-US-DavisNeural` — calm, slightly dark male
- `en-US-GuyNeural` — authoritative male
- `en-US-TonyNeural` — smooth, warm male
- `en-GB-RyanNeural` — British male, cinematic
- `en-US-AriaNeural` — expressive female

### settings block
| Field | Values | Default |
|-------|--------|---------|
| backgroundVideo | filename from `backgrounds/` folder | first available |
| colorGrade | none, dark, blue, warm, purple, teal, crimson, mono, analog, nightmare, liminal, bloom, sepia, cyber, neon, faded, vintage, dreamy, sunset, forest, lavender, cold, heat, toxic, bleach, frost, cherry, emerald, obsidian, peach, ash, dusk, ember | dark |
| colorGradeIntensity | 0–100 | 85 |
| grainType | film, digital, vhs, none | film |
| grainIntensity | 0.0–1.0 | 0.35 |
| backgroundBlur | 0–10 | 2 |
| backgroundBrightness | 0.0–1.0 | 0.65 |
| fogOverlay | true / false | false |
| rainOverlay | true / false | false |
| slowZoom | true / false | true |
| vignette | true / false | true |
| textAnimation | fade, slide-up, typewriter, scale, glow, blur-in, fade-typewriter, word-drop, rise, bounce, shimmer, cascade, dissolve, flicker, glitch-in | fade |
| fontSize | 40–100 | 68 |
| musicFile | filename from `music/` folder | "" (no music) |
| musicVolume | 0.0–1.0 | 0.25 |
| fps | 30 or 60 | 30 |

**Background videos available:**

```
stock_pexels_14209304.mp4
stock_pexels_34837491.mp4
stock_pexels_35806649.mp4
stock_pexels_36554100.mp4
Amazing_Rain_forest_#short_...mp4
44e0e29fd89dc7205408df0246dd8aca.mp4
```

---

## Monitoring Job Status

The worker updates the job JSON file in place. Open it to check progress:

```
Google Drive → Trend Vault Program Sync → requests → your-job.json
```

| status | Meaning |
|--------|---------|
| pending | Waiting to be picked up |
| processing | Home computer is working on it |
| complete | Done — check `final/` folder |
| failed | Something went wrong — read the `error` field |

When complete the job file also contains:
- `outputFile` — filename of the finished video in Drive `final/`
- `completedAt` — timestamp

---

## Ready-to-Use Example Files

The `example-jobs/` folder in your project contains copy-paste-ready job files:

| File | What it does |
|------|-------------|
| `render-scorpio.json` | Full dark Scorpio render with AI script |
| `render-with-script.json` | Render a pre-written Virgo script |
| `script-only-aries.json` | Generate a motivational Aries script only |
| `tts-only.json` | Generate a Capricorn voiceover MP3 |
| `clip-factory.json` | Extract clips from a long video |

To use one: copy it, rename it with a unique `jobId`, edit the fields, remove lines starting with `_`, and drop it in `Google Drive → Trend Vault Program Sync → requests/`.

---

## Troubleshooting

**Job stays at "pending" forever**
→ Worker isn't running on the home computer. Run `npm run sync:worker`
→ Check `googleDriveRoot` path in `sync.config.json`

**"Script generation failed"**
→ Check `ANTHROPIC_API_KEY` in your `.env` file on the home computer
→ Alternative: provide `scriptLines` directly instead of using `"script"` block

**"Render hangs at 0%"**
→ Remotion needs Chrome or Edge. Install one on the home computer.

**"TTS generation failed"**
→ Check internet connection — Edge TTS requires internet
→ Worker will continue without voice and render a silent video

**Clip job: "Source not in Drive uploads"**
→ Make sure the file name in `inputFile` exactly matches what you uploaded (case-sensitive)

**Output video in local final but not Drive final**
→ Google Drive is still uploading — wait a minute and check again

**How to retry a failed job**
→ Open the job JSON, set `"status": "pending"`, delete `"error"` and `"failedAt"`, save

---

## What NOT to Put in Google Drive

| DO NOT sync | Reason |
|-------------|--------|
| `C:\Trend Vault Program\cache\` | Render cache — huge, constantly changing |
| `C:\Trend Vault Program\working\` | Mid-flight processing files |
| `C:\Trend Vault Program\renders\` | Intermediate frames |
| `node_modules\` | Never sync these — re-run `npm install` on each machine |
| `.tmp`, `.uploading`, `.crdownload` | Incomplete files — the worker ignores these automatically |

---

## Commands Quick Reference

| Command | What it does | Run where |
|---------|-------------|----------|
| `npm run setup:sync` | Creates all folders | Home computer (once) |
| `npm run sync:worker` | Starts the worker | Home computer (keep running) |
| `npm run sync:test` | End-to-end test | Home computer |
| `npm start` | Starts the web UI | Either computer |
