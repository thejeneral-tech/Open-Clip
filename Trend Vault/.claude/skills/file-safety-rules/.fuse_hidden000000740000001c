---
name: file-safety-rules
description: Use this skill before editing any file in the Trend Vault Program to understand what is safe to touch, what must never be deleted, what is auto-generated, and what rules prevent data loss. Trigger on "can I delete this", "is it safe to edit X", "what's in this folder", "will deleting X break anything", "what files should I never touch", "what auto-generates".
---

# File Safety Rules

## NEVER delete
| Path | Why |
|------|-----|
| `trend-vault-output/*/video.mp4` | Rendered videos — irreplaceable, no trash bin |
| `trend-vault-output/*/meta.json` | Render settings log |
| `custom-presets.json` | User's saved voice presets |
| `backgrounds/*.mp4` | Background library — re-downloading takes time |
| `music/*.mp3` | Music library |
| `.env` | API keys — losing this breaks all AI features |
| `piper/voices/` | Offline TTS models — re-downloading takes time |

## NEVER edit these files directly (auto-generated / runtime state)
| Path | Why |
|------|-----|
| `trend-vault-output/job_*.json` | Active render jobs — server reads/deletes these |
| `public/` | Assembled at render time by `ensurePublicLink()` |
| `node_modules/` | npm managed |
| `output/active-job.json` | Clip tool job state |

## Safe to edit freely
| Path | Notes |
|------|-------|
| `frontend/trend-vault.html` | All UI logic — changes reflect immediately on refresh |
| `src/TrendVaultVideo.tsx` | Remotion composition — changes require re-render |
| `server.ts` | Restart server after changes |
| `scripts/*.ts` | Restart server after changes |
| `sync.config.json` | Sync paths — restart sync worker after changes |
| `.env` | API keys — restart server after changes |

## Safe to add files to
| Folder | What to add |
|--------|-------------|
| `backgrounds/` | MP4 files (H.264 only, no spaces in name) |
| `music/` | MP3/WAV files (no spaces in name) |
| `custom-audio/` | MP3/WAV voiceovers |
| `data/drafts/` | Draft JSON files |

## Folder purposes at a glance
```
backgrounds/       ← background video library (laptop + home computer)
music/             ← background music library
custom-audio/      ← user voiceovers + TikTok sounds
uploads/           ← multer temp uploads (safe to clear if not rendering)
trend-vault-output/     ← render outputs (NEVER clear)
output/            ← clip tool outputs
public/            ← auto-assembled at render time (safe to clear)
piper/             ← offline TTS binary + voice models
data/drafts/       ← saved studio drafts
scripts/           ← all server-side logic
src/               ← Remotion React components
frontend/          ← browser UI (trend-vault.html)
C:\Trend Vault Program\ ← home computer SSD (incoming/working/cache/renders/final/logs)
```

## Name rules for new files
- **No spaces** in filenames anywhere — spaces break `spawn()` args on Windows
- Use underscores: `my_background_video.mp4` ✓, `my background video.mp4` ✗
- Stick to ASCII: no special chars, no Unicode in filenames
