---
name: debug-tts-edge
description: Use this skill specifically for Edge TTS failures — timeouts, the voice preview button doing nothing, audio file not created, wrong voice ID, Edge TTS returning silence, or the preview audio not matching what was requested. Trigger on "edge TTS broken", "preview button nothing", "voice preview silence", "TTS timeout", "audio not playing in preview", "wrong voice in preview". For full voice pipeline issues use diagnose-voice-pipeline instead.
---

# Debug Edge TTS (Voice Preview)

## Files involved
- `server.ts` lines ~623–727 — `POST /api/zodiac/tts` endpoint
- `scripts/tts/ttsService.ts` — `generateVoice()`, engine routing
- `scripts/tts/localTtsAdapter.ts` — local engine wrapper
- `scripts/tts/audioPostProcess.ts` — FFmpeg post-processing
- `frontend/zodiac.html` — `previewVoice()` / preview button handler

## Files NOT to touch
- `src/ZodiacVideo.tsx`
- `scripts/zodiac-render.ts`
- `scripts/sync-worker.js`

## Decision tree

### 1. Test TTS endpoint directly
```bash
curl -X POST http://localhost:3001/api/zodiac/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Scorpio, your time has come.","edgeId":"en-US-AriaNeural"}' \
  -o /tmp/test_voice.mp3 -w "HTTP: %{http_code} SIZE: %{size_download}\n"
```
- HTTP 200 + SIZE > 5000 bytes → TTS working
- HTTP 200 + SIZE < 1000 bytes → silent audio (FFmpeg issue or empty buffer)
- HTTP 500 → server error, check stdout for stack trace
- HTTP 504 / curl timeout → Edge TTS network call timed out

### 2. Check Piper is not intercepting
`POST /api/zodiac/tts` tries Piper first if `piperId` is set. If `piperId` is in the request body but the model file is missing, it logs a warning and falls through to Edge TTS. Confirm the request body only sends `edgeId` for Edge TTS previews (not `piperId`).

### 3. Check Edge TTS availability
```
GET http://localhost:3001/api/zodiac/edge-tts-status
```
- `available: false` → openai-edge-tts server is not running (only needed for high-quality local Edge; standard Edge TTS still works via `node-edge-tts` package)
- If this returns `available: true`, the openai-edge-tts server is up at port 5050

### 4. Check `node-edge-tts` package
`server.ts` uses `node-edge-tts` for basic Edge TTS. If this package is missing:
```bash
npm list node-edge-tts
```
If missing: `npm install node-edge-tts`

### 5. Frontend preview button
In `zodiac.html`, find the voice preview button click handler. It should:
1. Call `POST /api/zodiac/tts` with `text`, `edgeId` from the selected preset
2. Create a `Blob` from the response buffer
3. Set `audioElement.src = URL.createObjectURL(blob)`
4. Call `audioElement.play()`

If step 3–4 fails silently, add a `console.error` to the catch block and check DevTools.

### 6. Voice preview vs render mismatch
Preview calls `/api/zodiac/tts`; render calls `generateVoice()` internally. Both use `ttsService.ts`. If they sound different, check that `getVoiceParams()` in the frontend collects the same slider values for both paths.

## Common quick fix
Most "preview does nothing" bugs are a missing `edgeId` on the selected preset. Check:
```bash
curl -s http://localhost:3001/api/zodiac/voice-presets | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const noEdge=d.presets.filter(p=>!p.edgeId);
console.log('Presets missing edgeId:',noEdge.map(p=>p.id));
"
```
