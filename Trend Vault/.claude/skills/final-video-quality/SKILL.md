---
name: final-video-quality
description: Use this skill to check the quality of a completed render — verify the video plays correctly, has audio, has correct dimensions, captions are readable, and the file is ready to post. Trigger on "check the render", "is the video good", "verify the output", "check video quality", "does the render look right", "ready to post", "video quality check", "something looks off in the render".
---

# Final Video Quality Check

## Find the latest render
```bash
# List most recent render folders
dir C:\Users\Anton\Desktop\Zodiac Program\zodiac-output /O-D
# Latest folder at top
```

## Inspect the meta.json
```bash
type "zodiac-output\<folder>\meta.json"
```
Check:
- `renderStatus: "done"` (not "error")
- `audioFile` not null/empty → voice was generated
- `settings.zodiacSign` matches what you intended
- `settings.colorGrade`, `settings.grainType` etc. are correct

## File size sanity check
```bash
dir "zodiac-output\<folder>\video.mp4"
```
Expected ranges for a typical 90-second 1080×1920 video:
- < 10 MB → suspiciously small, likely no audio or very short
- 15–60 MB → normal
- > 200 MB → unusually large, check if 60fps was used

## Check dimensions and duration with ffprobe
```bash
ffprobe -v quiet -print_format json -show_streams "zodiac-output\<folder>\video.mp4"
```
Check:
- `width: 1080`, `height: 1920` (for TikTok)
- `codec_name: "h264"` (video) and `codec_name: "aac"` (audio)
- Audio stream exists — if missing, TTS failed during render
- `duration` matches the expected length

## Visual quality checklist
Open the video in VLC or Windows Media Player:
- [ ] **Captions readable** — font large enough, no overflow
- [ ] **Caption timing** — lines appear in sync with voice
- [ ] **Background plays** — not black (check if background file was found)
- [ ] **Color grade applied** — if `dark` grade, video should have dark tone
- [ ] **No hard cuts mid-caption** — lines transition smoothly
- [ ] **Audio present** — narration is audible, not silent
- [ ] **Music present** (if enabled) — background music at correct volume
- [ ] **Grain/fog overlay** — subtle, not overwhelming
- [ ] **No watermarks** — Remotion trial watermark only appears if license unpaid
- [ ] **Correct sign** — the zodiac sign in script matches the folder name

## Common quality issues
| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Silent video | TTS failed silently | Check `meta.json.audioFile`, re-render with different voice engine |
| Black background | Background file missing or codec unsupported | Check `backgrounds/` folder, use H.264 MP4 |
| Captions too small | `fontSize` set too low | Increase in studio |
| Captions off-screen | `captionTopPct` near 0 or 100 | Use Center button |
| Color grade too strong | `colorGradeIntensity` at 100 with extreme grade | Reduce intensity |
| Video too short | Script duration much shorter than voice | Timing mismatch — re-render after alignment |
| Remotion watermark | No Remotion license | Expected for personal/dev use; purchase license for commercial |

## Upload-ready check
- [ ] File size < 287MB (TikTok limit)
- [ ] Duration < 10 minutes (TikTok limit)
- [ ] 1080×1920 (9:16 portrait — TikTok/IG Reels preferred)
- [ ] H.264 video + AAC audio (universal compatibility)
