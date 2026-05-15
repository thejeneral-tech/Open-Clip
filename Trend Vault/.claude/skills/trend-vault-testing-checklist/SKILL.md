---
name: trend-vault-testing-checklist
description: Use this skill to run a full functional audit of the Trend Vault Program — verifying all 12 workflow steps work end to end. Use after any significant code change, before a release, or when the user says "test everything", "full audit", "does everything work", "check if it's broken", "run the checklist". Also use proactively after finishing a Phase.
---

# Trend Vault Program — Full Testing Checklist

Run each test in order. Stop and report the exact failure if anything fails.

## Pre-flight: server running?
```bash
curl -s http://localhost:3001/trend-vault -o /dev/null -w "%{http_code}"
# Must return: 200
```
If not: `npm start` (server.ts via tsx)

---

## Test 1 — Server starts correctly
```bash
curl -s http://localhost:3001/trend-vault -o /dev/null -w "HTTP: %{http_code}\n"
curl -s http://localhost:3001/api/trend-vault/engine-status
```
PASS: HTTP 200, engine-status returns JSON without 500.

## Test 2 — Story Prompt generates exactly 4
```bash
curl -s -X POST http://localhost:3001/api/trend-vault/generate-prompts \
  -H "Content-Type: application/json" \
  -d '{"trendVaultSign":"Scorpio","category":"general","count":4}'
```
PASS: `ok: true`, `prompts` array has exactly 4 items.

## Test 3 — Script Reframe preserves order
```bash
curl -s -X POST http://localhost:3001/api/trend-vault/regenerate-script \
  -H "Content-Type: application/json" \
  -d '{"trendVaultSign":"Scorpio","prompt":"test","angle":"","emotionalTone":"dark","existingLines":[{"text":"Line 1","type":"hook","durationSeconds":4},{"text":"Line 2","type":"observation","durationSeconds":5},{"text":"Line 3","type":"escalation","durationSeconds":5}]}'
```
PASS: `ok: true`, returned array has exactly 3 items in same order (hook → observation → escalation).

## Test 4 — Voice preview (TTS)
```bash
curl -s -X POST http://localhost:3001/api/trend-vault/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Scorpio, your time has come.","edgeId":"en-US-AriaNeural"}' \
  -o test_voice.mp3 -w "HTTP: %{http_code} BYTES: %{size_download}\n"
```
PASS: HTTP 200, file size > 5000 bytes.

## Test 5 — Voice preset save + delete
```bash
# Save
curl -s -X POST http://localhost:3001/api/custom-presets \
  -H "Content-Type: application/json" \
  -d '{"name":"AUDIT","edgeId":"en-US-AriaNeural","icon":"🧪"}'
# Returns { ok: true, preset: { id: "custom_..." } }
# Then delete using that ID:
curl -s -X DELETE http://localhost:3001/api/custom-presets/<id>
# Returns { ok: true }
```
PASS: Both return `ok: true`.

## Test 6 — Background selection
```bash
curl -I http://localhost:3001/backgrounds/stock_pexels_14209304.mp4
```
PASS: HTTP 200 or 206.

## Test 7 — Music selection
```bash
curl -I http://localhost:3001/music/stock_jamendo_1502537.mp3
```
PASS: HTTP 200 or 206.

## Test 8 — Preview editor (manual browser check)
Open http://localhost:3001/trend-vault. Verify:
- [ ] "▤ Layers & Transform ▾" button visible — click it → panel opens
- [ ] Rotate slider tilts captions in preview
- [ ] "⬜ TikTok" button applies white box to captions
- [ ] Ctrl+Z undoes the change
- [ ] Ctrl+Shift+Z redoes it

## Test 9 — Export preset TikTok 9:16
In the studio, click "TikTok 9:16" button. Verify:
- [ ] Resolution label updates to "1080×1920 (9:16)"
- [ ] `state.renderWidth === 1080`, `state.renderHeight === 1920`

## Test 10 — Render job submission
```bash
curl -s -X POST http://localhost:3001/api/trend-vault/render \
  -H "Content-Type: application/json" \
  -d '{"settings":{"trendVaultSign":"Scorpio","trendVaultSymbol":"♏","backgroundVideo":"none","fps":30,"width":1080,"height":1920,"durationSeconds":8,"voiceEngine":"auto","captionBgStyle":"none","captionRotate":0,"fontFamily":"Inter","fontSize":48,"textColor":"#ffffff","textAnimation":"fade","animSpeed":1,"grainType":"none","grainIntensity":0,"fogOverlay":false,"rainOverlay":false,"slowZoom":false,"colorGrade":"none","vignette":false,"musicVolume":0.5,"backgroundBlur":0,"backgroundBrightness":1,"colorGradeIntensity":100,"saturation":100,"contrast":100,"exposure":0,"highlights":0,"shadows":0},"scriptLines":[{"text":"Scorpio","type":"hook","durationSeconds":6}]}'
```
PASS: `{ ok: true, jobId: "...", folder: "..." }`

## Test 11 — Output folder exists
```bash
dir C:\Users\Anton\Desktop\Trend Vault Program\trend-vault-output
# Check at least one folder contains video.mp4 + meta.json
```

## Test 12 — Drive sync
```bash
npm run sync:test
# Must print: TEST PASSED — 18/18 checks passed
```

---

## Reporting format
```
PASSED: 1,2,3,4,5,6,7,9,10,11,12
FAILED: 8 (Layers panel not opening — toggleLayersPanel() not defined)
NEXT: Fix toggleLayersPanel in trend-vault.html
```
