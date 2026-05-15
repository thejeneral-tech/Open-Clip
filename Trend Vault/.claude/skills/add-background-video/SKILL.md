---
name: add-background-video
description: Use this skill when the user wants to add a new background video to the Trend Vault studio — from a local file, a URL, or by downloading stock footage. Trigger on "add background", "new background video", "add stock footage", "add my video as background", "download pexels video", "background not in picker".
---

# Add a Background Video

## Where files go
All background videos live in:
```
C:\Users\Anton\Desktop\Trend Vault Program\backgrounds\
```
They are served statically at `http://localhost:3001/backgrounds/<filename>`.
Remotion copies them to `public/backgrounds/` at render time via `ensurePublicLink()`.

## Supported formats
- **H.264 MP4** — preferred, works in browser preview AND Remotion render
- MOV (H.264 codec only) — works but prefer MP4
- HEVC/VP9 — NOT supported in Remotion OffthreadVideo; must convert first

## Steps to add a video

### Option A — Local file
1. Copy the file to `backgrounds/`
2. Rename using the `stock_pexels_XXXXXXXX.mp4` or `stock_SOURCENAME_ID.mp4` pattern (no spaces — spaces break spawn args)
3. The file is immediately served; refresh the browser to see it in the picker

### Option B — Paste URL in the studio
The studio has a URL input for background videos. If a download queue exists:
```
GET http://localhost:3001/api/trend-vault/download-queue
POST http://localhost:3001/api/trend-vault/import-url  { url: "..." }
```
Check `server.ts` for `import-url` endpoint implementation.

### Option C — Download from Pexels
```bash
# Using yt-dlp (if installed):
yt-dlp -f "bestvideo[ext=mp4][vcodec^=avc]" "https://www.pexels.com/video/XXXXX/" \
  -o "backgrounds/stock_pexels_XXXXX.mp4"
```

## Make it appear in the picker
The background picker in `trend-vault.html` reads available backgrounds from the server. Check how it fetches the list:
- If it calls a dynamic endpoint → restart server to pick up new files
- If it uses a hardcoded array in the HTML → add the filename to that array

## Name convention
```
stock_pexels_<pexels-id>.mp4      ← Pexels footage
stock_jamendo_<id>.mp4            ← Jamendo footage  
custom_<description>.mp4          ← your own clips
```
No spaces. Underscore only. Max 60 chars.

## Never put these in backgrounds/
- Audio files (mp3, wav) — use `music/` instead
- Large 4K files (> 500MB) — Remotion will OOM
- HEVC or VP9 videos — convert first
