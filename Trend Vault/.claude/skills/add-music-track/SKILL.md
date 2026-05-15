---
name: add-music-track
description: Use this skill when the user wants to add a new music track or background audio to the Trend Vault studio — from a local file, a URL, or by naming a Jamendo/royalty-free track. Trigger on "add music", "new music track", "add background music", "upload music", "music not showing", "add audio track".
---

# Add a Music Track

## Where files go
```
C:\Users\Anton\Desktop\Trend Vault Program\music\
```
Served at `http://localhost:3001/music/<filename>`.  
Remotion copies to `public/music/` at render time.

## Supported formats
- **MP3** — preferred
- WAV — works but large file sizes
- Upload limit: **50MB** (enforced by server multer config)

## Steps

### Option A — Upload via the studio UI
Use the music upload button in the studio (Music section). Files are stored in `music/` automatically.

### Option B — Drop file manually
1. Copy MP3 to `music/` folder
2. Use kebab or underscore naming, no spaces: `stock_jamendo_1502537.mp3`
3. Reload browser — picker will include it on next page load (or the next time the picker refreshes its list)

### Option C — Download from URL
```bash
# Using yt-dlp for YouTube / SoundCloud:
yt-dlp -x --audio-format mp3 "https://..." -o "music/custom_%(title)s.%(ext)s"
# Then rename to remove spaces:
# custom_my_track.mp3
```

## Name convention
```
stock_jamendo_<id>.mp3        ← Jamendo royalty-free
stock_freemusicarchive_<id>.mp3
custom_<description>.mp3      ← your own or downloaded
```
No spaces. Underscores only.

## After adding
1. Refresh browser
2. Open Music section in the studio
3. New file should appear in the picker
4. If not: check if the picker fetches a dynamic list from the server (may need server restart) or uses a hardcoded array in `trend-vault.html`

## Volume note
Music volume is set in the studio UI (0–100%) and stored in `state.musicVolume`. It is passed to Remotion as `musicVolume: state.musicVolume / 100` (0.0–1.0 range). A good starting point for background music is 15–25%.
