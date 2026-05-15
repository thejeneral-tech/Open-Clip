---
name: extract-custom-audio
description: Use this skill when working with custom audio — uploading a voiceover, extracting audio from a video file, using a TikTok sound as custom audio, or debugging the custom audio upload system. Trigger on "upload custom audio", "extract audio from video", "use my own voice", "TikTok sound upload", "custom audio not working", "voiceover upload".
---

# Custom Audio Extraction and Upload

## Files involved
- `server.ts` lines ~116–122 — `audioUpload` multer config (50MB limit → `custom-audio/`)
- `custom-audio/` folder — uploaded voiceovers and TikTok sounds
- `public/custom-audio/` — mirrored by server at render time so Remotion can find them
- `src/ZodiacVideo.tsx` — `audioFile` prop → `<Audio src={staticFile('custom-audio/...')}>`
- `frontend/zodiac.html` — custom audio upload UI, `state.customAudio`

## Files NOT to touch
- `music/` folder (that's for background music, different from voiceover/custom audio)
- `scripts/tts/` folder

## How it works
1. User uploads an MP3/WAV via the studio's Custom Audio section
2. File lands in `custom-audio/` with its original name (spaces → underscores)
3. At render time, server copies `custom-audio/` → `public/custom-audio/` via `ensurePublicLink()`
4. Remotion uses `staticFile('custom-audio/<name>')` to play it in the video
5. `state.customAudio` in the frontend holds the filename

## Extract audio from a video file
```bash
# Using ffmpeg — extract audio track from MP4/MOV to MP3
ffmpeg -i "input_video.mp4" -vn -acodec mp3 -ab 192k "custom-audio/my_voiceover.mp3"

# Or extract and normalize volume:
ffmpeg -i "input_video.mp4" -vn -af "loudnorm" -acodec mp3 -ab 192k "custom-audio/my_voiceover_normalized.mp3"
```

## Download audio from TikTok/YouTube
```bash
# Using yt-dlp:
yt-dlp -x --audio-format mp3 --audio-quality 192k \
  "https://www.tiktok.com/@user/video/..." \
  -o "custom-audio/tiktok_%(id)s.%(ext)s"
```

## Troubleshooting: custom audio not playing in render
1. Check file is in `custom-audio/` (not `music/` or `uploads/`)
2. Check `state.customAudio` matches exact filename
3. Check render settings include `audioFile: state.customAudio`
4. Check `public/custom-audio/<filename>` exists after render starts (ensurePublicLink runs first)
5. In `ZodiacVideo.tsx`, `audioFile` is used as: `staticFile('custom-audio/' + audioFile)` — confirm the path pattern hasn't changed

## Upload limit
50MB per file. For longer recordings, compress first:
```bash
ffmpeg -i "big_file.wav" -acodec mp3 -ab 128k "compressed.mp3"
```
