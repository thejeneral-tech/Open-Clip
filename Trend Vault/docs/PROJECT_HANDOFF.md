# YouTube Clip Factory — Project Handoff

**Project:** Automated short-form clip generator for TikTok/Reels/Shorts  
**Stack:** Node.js · TypeScript · Remotion · FFmpeg · AssemblyAI · Anthropic Claude  
**Location:** `C:\Users\Anton\OneDrive\Desktop\Antonio Clip code proj\my-video\`

---

## What This Project Does

Takes a local MP4 video file, transcribes it, uses AI to pick the best moments, cuts them with FFmpeg, and renders each one as a **1080×1920 vertical TikTok-ready MP4** with:
- Blurred background fill (full frame, cinematic look)
- Centered original video (letterboxed)
- Large animated word-highlight captions (yellow when spoken, white otherwise)
- Hook text at the top in all-caps
- Clip title badge in the corner

One command does everything: `npm run clip`

---

## Folder Structure

```
my-video/
├── scripts/                  ← Pipeline TypeScript scripts
│   ├── types.ts              ← Shared interfaces (Word, ClipSelection, etc.)
│   ├── extract-audio.ts      ← FFmpeg: strip MP3 from video
│   ├── transcribe.ts         ← AssemblyAI: speech-to-text with word timestamps
│   ├── choose-clips.ts       ← Claude AI: pick best 10 clips from transcript
│   ├── choose-clips-heuristic.ts  ← Fallback: word-density scoring (no API needed)
│   ├── cut-clips.ts          ← FFmpeg: cut 10 raw clip files
│   ├── render-clips.ts       ← Remotion: render vertical captioned MP4s
│   └── clip.ts               ← Orchestrator: runs all steps in order
│
├── src/                      ← Remotion React components
│   ├── ClipVideo.tsx         ← Main vertical video composition with captions
│   ├── Root.tsx              ← Registers Remotion compositions
│   ├── Composition.tsx       ← Default Remotion placeholder
│   ├── index.ts              ← Remotion entry point
│   └── index.css             ← Global styles (Tailwind)
│
├── input/                    ← Auto-created. Stores extracted audio.mp3
├── transcripts/              ← Auto-created. Stores video.json (cached transcript)
├── output/
│   ├── clips.json            ← Cached Claude/heuristic clip selections
│   ├── raw/                  ← FFmpeg-cut clips (clip-01.mp4 … clip-10.mp4)
│   └── final/                ← Finished vertical TikTok clips (clip-01.mp4 … clip-10.mp4)
│
├── public/                   ← Remotion static assets (temp clips copied here during render)
├── .env                      ← API keys (never commit this)
├── .env.example              ← Template for .env
├── package.json
├── tsconfig.json
├── remotion.config.ts
└── PROJECT_HANDOFF.md        ← This file
```

---

## How the Pipeline Works

```
npm run clip [optional: path/to/video.mp4]
```

### Step 1 — Extract Audio (`extract-audio.ts`)
- Uses bundled FFmpeg (`@ffmpeg-installer/ffmpeg`) — no system FFmpeg needed
- Strips audio from the video into `input/audio.mp3`
- VBR MP3 at quality level 2 (~190 kbps)
- **Cached:** Skipped on re-run if `input/audio.mp3` exists

### Step 2 — Transcribe (`transcribe.ts`)
- Uploads `input/audio.mp3` to AssemblyAI
- Uses `universal-2` speech model
- Returns full text + every word with millisecond-precise start/end timestamps
- Saves result to `transcripts/video.json`
- **Cached:** Skipped on re-run if `transcripts/video.json` exists

### Step 3 — Choose Clips (`choose-clips.ts` or `choose-clips-heuristic.ts`)
- **Primary (Claude):** Sends a compact timestamped transcript to `claude-sonnet-4-6`
  - Prompts Claude to pick 10 clips of 60–120 seconds each
  - Prioritizes: strong hooks, complete comedic bits, surprising moments
  - Returns JSON array with title, start, end, hook text, reason
- **Fallback (Heuristic):** Used automatically if Claude API has no credits
  - Divides video into 10 equal sections
  - Scores every 90-second window by words-per-second (speech density = energy)
  - Picks the highest-scoring non-overlapping window from each section
- Saves result to `output/clips.json`
- **Cached:** Skipped on re-run if `output/clips.json` exists

### Step 4 — Cut Raw Clips (`cut-clips.ts`)
- Uses bundled FFmpeg to cut each clip from the original video
- Re-encodes with H.264 + AAC
- **Cached:** Each clip skipped individually if already exists in `output/raw/`

### Step 5 — Render Vertical Clips (`render-clips.ts`)
- Bundles the Remotion project once (webpack)
- Copies each raw clip into the bundle's public directory
- Renders 1080×1920 composition for each clip via headless Chrome
- Saves to `output/final/clip-01.mp4` … `clip-10.mp4`
- Cleans up temp files after each render
- **Cached:** Each clip skipped individually if already exists in `output/final/`

---

## Environment Variables

File: `.env` (project root)

```env
# AssemblyAI — transcription with word-level timestamps
# Get key at: https://www.assemblyai.com/
ASSEMBLYAI_API_KEY=your_key_here

# Anthropic — Claude picks the best clips from the transcript
# Get key at: https://console.anthropic.com/
# If balance is zero, pipeline auto-falls back to heuristic selector
ANTHROPIC_API_KEY=your_key_here
```

**Important:** `dotenv` is loaded with `override: true` so these values always
take precedence over any system environment variables (e.g. Claude Code's own
internal key).

---

## Commands

| Command | What it does |
|---|---|
| `npm run clip` | Run the full pipeline on the default hardcoded video |
| `npm run clip "C:\path\to\video.mp4"` | Run pipeline on a specific video |
| `npm run dev` | Open Remotion Studio at http://localhost:3000 (preview compositions) |
| `npm run build` | Bundle Remotion project |
| `npm run lint` | ESLint + TypeScript type check |

---

## FFmpeg Settings

### Audio Extraction (`extract-audio.ts`)
| Setting | Value | Why |
|---|---|---|
| Codec | `libmp3lame` | MP3 for AssemblyAI upload |
| Quality | `-q:a 2` (VBR ~190 kbps) | High quality, small file |
| Video | stripped | Audio-only needed for transcription |

### Clip Cutting (`cut-clips.ts`)
| Setting | Value | Why |
|---|---|---|
| Video codec | `libx264` | H.264, universal compatibility |
| Audio codec | `aac` | Standard, TikTok-compatible |
| CRF | `18` | Near-lossless quality for source clips |
| Preset | `fast` | Good quality/speed balance |
| Keyframe interval | `-g 1` | **Every frame is a keyframe** — critical for Remotion to seek accurately to any frame without choppiness |
| Frame rate | `-r 30` | Locked at 30fps, matching Remotion composition |
| Faststart | `-movflags faststart` | moov atom at front for fast playback start |

> **Why `-g 1`?** Remotion renders by seeking to each frame position in a headless
> browser. Without all-keyframe encoding, seeking to a non-keyframe position
> requires decoding from the previous keyframe, which causes frame-timing errors
> and choppy output. `-g 1` makes every frame instantly seekable.

---

## Remotion Rendering Settings (`render-clips.ts`)

| Setting | Value | Why |
|---|---|---|
| Composition | `ClipVideo` | Vertical 1080×1920 TikTok layout |
| FPS | 30 | Standard TikTok/Reels frame rate |
| Width × Height | 1080 × 1920 | 9:16 vertical — native TikTok format |
| Codec | `h264` | Universal MP4 playback |
| Image format | `jpeg` | ~3–4× faster than PNG, imperceptible quality difference |
| JPEG quality | `90` | High quality intermediate frames |
| x264 Preset | `veryfast` | Fast encode; TikTok recompresses on upload anyway |
| CRF | `23` | Standard high-quality encode |
| Concurrency | `2` | ⚠️ Windows EMFILE limit — **do not raise above 2** |

> **Why concurrency 2?** Windows has a limit on simultaneously open file
> descriptors. With larger all-keyframe source files and multiple concurrent
> headless Chrome tabs each holding the video open, values above 2 reliably
> crash with `EMFILE: too many open files` around clip 5–8.
> On macOS/Linux this limit is much higher and you can safely use 4–8.

---

## Remotion Component (`src/ClipVideo.tsx`)

The main composition renders:

1. **Blurred background** — same `<Video>` scaled to fill frame with `filter: blur(28px) brightness(0.28) scale(1.15)`
2. **Main video** — centered `<Video>` at full width, `maxHeight: 62%`, letterboxed
3. **Hook text** — top of frame, yellow (`#FFE500`), Impact-style font, all-caps, black text-shadow
4. **Word-highlight captions** — bottom of frame, groups of 5 words shown at a time
   - Active word (currently being spoken) → yellow `#FFE500`
   - Other words in group → white `#FFFFFF`
   - Group advances automatically based on word timestamps
5. **Gradient overlay** — bottom gradient for caption readability
6. **Title badge** — semi-transparent top-right corner label

**Caption timing logic:**
- All words for the clip have timestamps adjusted to start at `0ms` (relative to clip start)
- Words grouped into chunks of 5
- At each frame, current time in ms is compared against word start/end to find the active group and active word
- Group advances to next set of 5 when the next group's first word begins

---

## APIs Used

### AssemblyAI
- **Endpoint:** `POST https://api.assemblyai.com/v2/transcript`
- **Model:** `universal-2`
- **Returns:** Full text + array of every word with `start` (ms), `end` (ms), `confidence`
- **SDK:** `assemblyai` npm package
- **Cost:** ~$0.37/hour of audio (as of 2025)
- **Docs:** https://www.assemblyai.com/docs/api-reference/transcripts/submit

### Anthropic Claude
- **Model:** `claude-sonnet-4-6`
- **Purpose:** Reads transcript, returns 10 clip timestamps as JSON
- **Prompt style:** Role-based (expert TikTok editor), strict JSON-only output
- **Max tokens:** 4096
- **SDK:** `@anthropic-ai/sdk`
- **Fallback:** If account has no credits, `choose-clips-heuristic.ts` runs instead
- **Docs:** https://docs.anthropic.com

---

## Dependencies

### Runtime
| Package | Version | Purpose |
|---|---|---|
| `remotion` | 4.0.456 | Video composition framework |
| `@remotion/cli` | 4.0.456 | Remotion CLI (Studio, render) |
| `@remotion/renderer` | ^4.0.456 | Programmatic rendering API |
| `@remotion/bundler` | ^4.0.456 | Webpack bundler for Remotion |
| `@remotion/tailwind-v4` | 4.0.456 | Tailwind CSS integration for Remotion |
| `@anthropic-ai/sdk` | ^0.92.0 | Claude API client |
| `assemblyai` | ^4.32.1 | AssemblyAI transcription client |
| `@ffmpeg-installer/ffmpeg` | ^1.1.0 | Bundled FFmpeg binaries (no system install) |
| `fluent-ffmpeg` | ^2.1.3 | FFmpeg Node.js wrapper |
| `dotenv` | ^17.4.2 | `.env` file loading |
| `tsx` | ^4.21.0 | TypeScript execution (no compile step) |
| `react` / `react-dom` | 19.2.3 | Required by Remotion |
| `tailwindcss` | 4.0.0 | CSS utilities in Remotion component |

### Dev Only
| Package | Purpose |
|---|---|
| `typescript` 5.9.3 | Type checking |
| `@types/fluent-ffmpeg` | FFmpeg types |
| `@types/react` | React types |
| `eslint` | Linting |
| `prettier` | Code formatting |

---

## Where Outputs Are Stored

| File/Folder | Contents | Deletable? |
|---|---|---|
| `input/audio.mp3` | Extracted audio (~98 MB for 145-min video) | Yes — re-extracted on next run |
| `transcripts/video.json` | Full timestamped transcript (all words) | Yes — re-transcribed on next run (costs API credits) |
| `output/clips.json` | Claude's 10 clip timestamp selections | Yes — re-selected on next run |
| `output/raw/clip-NN.mp4` | Raw cut clips, H.264, all-keyframe | Yes — re-cut on next run |
| `output/final/clip-NN.mp4` | **Finished TikTok clips** — DO NOT DELETE | Only if you want to re-render |

**Cache system:** Every stage checks if its output already exists before running.
To force a stage to re-run, delete its output file(s).

---

## Startup Instructions (Fresh Machine)

1. **Install Node.js** — https://nodejs.org (v18+)
2. **Clone/copy project** to your machine
3. **Install dependencies:**
   ```bash
   cd "my-video"
   npm install
   ```
4. **Create `.env`** (copy from `.env.example` and fill in keys):
   ```
   ASSEMBLYAI_API_KEY=your_key
   ANTHROPIC_API_KEY=your_key
   ```
5. **Place your video** somewhere on disk (any path works)
6. **Run the pipeline:**
   ```bash
   npm run clip "C:\path\to\your\video.mp4"
   ```
   Or edit the default `VIDEO_PATH` in `scripts/clip.ts`

No system FFmpeg, Chrome, or other tools need to be installed — all binaries
are bundled via npm packages.

---

## Current Known Issues / Bugs

### 1. EMFILE — Too Many Open Files (Windows)
- **Symptom:** Crash around clip 5–8 with `EMFILE: too many open files`
- **Cause:** Windows file descriptor limit hit when many concurrent headless Chrome tabs hold all-keyframe video files open simultaneously
- **Current fix:** `CONCURRENCY = 2` in `render-clips.ts`
- **If it crashes:** Re-run `npm run clip` — it resumes from where it left off
- **Better fix (future):** On macOS/Linux raise to 4–8; on Windows use `--max-old-space-size` or restructure to close handles explicitly

### 2. Heuristic Clip Selection (No Claude Credits)
- **Symptom:** Clips are evenly distributed but not necessarily the funniest moments
- **Cause:** Anthropic API account has zero credits — falls back to word-density heuristic
- **Fix:** Add credits at https://console.anthropic.com → Plans & Billing, then delete `output/clips.json` and re-run

### 3. Clips 1–3 May Be Slightly Choppy
- **Cause:** Rendered during early testing with concurrency 8 before the all-keyframe (`-g 1`) fix was applied to the raw source clips
- **Fix:** Delete `output/raw/clip-01.mp4` through `clip-03.mp4` and `output/final/clip-01.mp4` through `clip-03.mp4`, then re-run to re-cut and re-render those three

### 4. `npx remotion skills add` Not Available
- **Cause:** Command does not exist in `@remotion/cli` 4.0.456
- **Workaround:** Skills are installed globally via `npx skills@latest add remotion-dev/skills -g`

---

## Future Improvements

### High Priority
- [ ] **Re-render clips 1–3** with the all-keyframe fix for full consistency
- [ ] **Add Anthropic credits** so Claude selects clips instead of the heuristic

### Quality Improvements
- [ ] **Speaker detection** — Use AssemblyAI `speaker_labels: true` to show different caption colors per speaker
- [ ] **Animated captions** — Add word-pop animation (scale up when active) for more TikTok energy
- [ ] **B-roll / zoom** — Auto-zoom on the video at key moments using Remotion's `interpolate()`
- [ ] **Vertical crop mode** — Option to crop 9:16 from center of wide video instead of letterbox + blur

### Pipeline Improvements
- [ ] **yt-dlp integration** — Accept YouTube URLs directly (install yt-dlp and wire into `clip.ts`)
- [ ] **Batch processing** — Accept a folder of videos and process all
- [ ] **Progress UI** — A simple web dashboard showing pipeline status instead of terminal output
- [ ] **Windows EMFILE fix** — Implement explicit file handle cleanup between renders to allow concurrency > 2

### Platform
- [ ] **macOS/Linux test** — Raise `CONCURRENCY` to 4–6 on non-Windows for 2–3× faster rendering
- [ ] **GPU acceleration** — Use `h264_nvenc` codec on NVIDIA GPUs for dramatically faster rendering
  ```typescript
  // In render-clips.ts, replace:
  codec: 'h264',
  // with:
  codec: 'h264',
  encoderName: 'h264_nvenc',  // requires NVIDIA GPU + drivers
  ```

---

## Timing Reference (145-min source video, Windows)

| Stage | Time |
|---|---|
| Audio extraction | ~4 min |
| AssemblyAI transcription | ~6 min |
| Claude clip selection | ~30 sec |
| FFmpeg cutting (10 clips) | ~3 min |
| Remotion rendering (per clip, concurrency 2) | ~15–20 min |
| **Total for 10 clips** | **~3–4 hours** |

Rendering dominates total time. Each clip is ~90 seconds × 30fps = 2,700 frames
rendered individually by headless Chrome.
