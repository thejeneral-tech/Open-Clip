# 🎬 StoryVault Video Factory

Discover, rank, rewrite, and turn popular Reddit-style and Quora-style stories into
short-form vertical videos (TikTok / YouTube Shorts / Instagram Reels and optional
1–3 minute story videos) using **your own** uploaded background footage.

The system is built to produce a **genuinely different video every time** — it tracks
fingerprints of every story, hook, script, voice, caption style, and background
segment, and actively avoids repeats.

---

## Requirements

| Tool | Why | Notes |
|------|-----|-------|
| **Node.js ≥ 22.5** | App runtime + built-in SQLite | `node --version` |
| **FFmpeg + FFprobe** | Video probe / segment / render | Must be on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`) |
| **Windows** | Local SAPI narration | Other OSes work but need an external TTS (see below) |

Everything else (database, web server, multipart uploads) ships with the app —
SQLite is Node's built-in `node:sqlite`, so there is **no native compilation**.

---

## Easiest way: the desktop launcher

Double-click **`StoryVault Launcher.bat`**. A small dark window opens with three buttons:

| Button | What it does |
|--------|--------------|
| **⬇ Install dependencies** | First-run setup. Checks for **Node.js** and **FFmpeg** and installs them if missing (via `winget`, or a portable download into `bin\` as a fallback — no admin needed), then runs `npm install` and seeds example stories. |
| **▶ Start** | Launches the server and opens your browser at http://127.0.0.1:4400. |
| **■ Stop** | Stops the server (and any in-progress render). |

The window also shows a live dependency check (`Node ✓  FFmpeg ✓  npm packages ✓`)
and streams the server log. On first run, click **Install** once, then **Start**.
Closing the window stops the server automatically.

> The launcher is pure Windows PowerShell + WinForms — it needs nothing pre-installed
> to run *itself*. `launcher.ps1` is the GUI; the `.bat` just opens it.

---

## Manual startup (command line)

```powershell
# 1. from the project folder
cd C:\Users\Anton\OneDrive\Desktop\StoryVault-Video-Factory

# 2. install the two pure-JS dependencies (express, multer)
npm install

# 3. (optional) create the DB explicitly — it is also auto-created on first boot
npm run init-db

# 4. (optional) seed a few example stories so the library isn't empty
npm run seed

# 5. start the app
npm start
```

Then open **http://127.0.0.1:4400** in your browser.

> Change the port with `set PORT=5000 && npm start` (PowerShell: `$env:PORT=5000; npm start`).

### First run, end-to-end

1. **🎮 Background Library** → drag in one or more MP4s (e.g. Minecraft parkour). Click **✂ Create Segments**.
2. **🔍 Story Discovery** → pick a source and **Search Stories** (or paste a story directly).
3. On a story card → **✦ Create Video** → choose duration/voice/captions → **Generate Preview**.
4. **✅ Review Queue** → watch the preview → **✓ Approve & Export**.
5. **📤 Exports** → download the finished 1080×1920 MP4.

---

## Story sources

* **Reddit communities & post URLs** — via the official/public Reddit API.
  For reliable access set up a free "script" app at <https://www.reddit.com/prefs/apps>
  and export credentials before starting:
  ```powershell
  $env:REDDIT_CLIENT_ID="xxxx"; $env:REDDIT_CLIENT_SECRET="yyyy"; npm start
  ```
  Without credentials the app uses anonymous JSON (often blocked from data-center
  IPs) and otherwise asks you to paste the URL or text. **It never bypasses auth,
  paywalls, or anti-bot systems.**
* **Quora / arbitrary website URLs** — paste the text (these sites disallow scraping).
* **Pasted text**, **.txt / .csv / .json file import**, **RSS feeds**, **saved collections**.

## Narration providers

* **Local Windows SAPI** (default) — real, with accurate word-boundary timings used
  for caption sync. Two system voices (David, Zira).
* **Fish Speech / Kokoro / Trend Vault / any HTTP TTS** — set
  `FISH_TTS_URL`, `KOKORO_TTS_URL`, or `HTTP_TTS_URL` to a server that accepts
  `{text, voice, speed}` and returns WAV bytes.

## Optional AI rewriter

The script rewriter works fully offline with a heuristic engine. If you set
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) the System Status page reflects it; the
rewriter interface in `src/services/scriptGenerator.js` is structured so an AI
provider can be dropped in per-step.

---

## Project layout

```
server.js                 HTTP entry point
src/
  config.js  constants.js
  db/        schema.sql + node:sqlite layer
  services/  reddit, rss, textImport, scoring, analysis, dedup, scriptGenerator,
             variation, backgrounds, segments, tts, captions, composer, pipeline,
             batch, review, systemStatus, dashboard, safety, ...
  routes/    meta, discovery, library, production (Express routers)
public/      index.html + css/styles.css + js/{api,ui,app,pages}.js
scripts/     init-db, seed, reset, sapi-tts.ps1
tests/       run-tests.js  (the §29 test list)
data/        database/ stories/ backgrounds/ segments/ narration/ captions/
             previews/ renders/ thumbnails/ logs/   (originals never overwritten)
```

## Useful commands

```powershell
npm start          # run the app
npm run dev        # run with --watch (auto-restart on file changes)
npm test           # run the §29 automated test suite (renders a real MP4)
npm run reset      # wipe all generated data back to empty
npm run seed       # add example stories
```

## Safety & content rules

Usernames and obvious PII are removed by default; stories are labelled as
user-submitted/internet stories; the source URL is kept for internal reference;
content filters flag sexual content, graphic violence, minors, self-harm and
private information. Footage must be uploaded by you or used with permission.
**No video is ever published automatically — you approve every export.**
