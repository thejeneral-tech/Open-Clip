---
name: debug-voice-preset-save
description: Use this skill when saving or deleting a voice preset fails — the Save button returns an error, the preset doesn't appear after saving, a deleted preset reappears, the custom presets file is corrupt, or the preset grid doesn't refresh. Trigger on "can't save preset", "preset not saving", "save preset error", "deleted preset came back", "preset grid not updating", "custom preset disappeared".
---

# Debug Voice Preset Save / Delete

## Files involved
- `server.ts` lines ~674–726 — `POST /api/custom-presets`, `DELETE /api/custom-presets/:id`
- `custom-presets.json` — persisted custom presets (project root)
- `frontend/trend-vault.html` — `saveCurrentVoiceAsPreset()`, `deleteCustomPreset()`

## Files NOT to touch
- `scripts/tts/ttsService.ts` — voice generation, unrelated
- `src/TrendVaultVideo.tsx`

## Decision tree

### 1. Test save directly
```bash
curl -X POST http://localhost:3001/api/custom-presets \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Preset","edgeId":"en-US-AriaNeural","icon":"🧪"}'
# Must return: { ok: true, preset: { id: "custom_...", ... } }
```
- `error: "name and edgeId required"` → the UI is not sending both fields. Check `saveCurrentVoiceAsPreset()` — `base.edgeId` must exist on the selected preset.
- HTTP 500 → file write failed (check disk space, permissions on `custom-presets.json`)

### 2. Check `custom-presets.json`
```bash
# View current contents
type custom-presets.json    # Windows
# or
cat custom-presets.json
```
- File missing → will be created on first save (normal)
- File contains invalid JSON → `readCustomPresets()` returns `[]` and the file gets overwritten on next save (data loss). Fix: delete the corrupt file before saving.

### 3. Test delete
```bash
curl -X DELETE http://localhost:3001/api/custom-presets/<id>
# Must return: { ok: true }
```
If the preset reappears after delete, the UI is re-fetching from a stale cache. Check `buildPresetGrid()` is called after delete and re-fetches from `/api/trend-vault/voice-presets`.

### 4. Preset not appearing in grid
After save, the UI calls `GET /api/trend-vault/voice-presets` which merges custom + built-in. Check:
- The freshly-saved preset has `category: "custom"` — the grid filters/groups by category
- `VOICE_PRESETS` (the JS array in `trend-vault.html`) is updated after the fetch: look for `VOICE_PRESETS = ld.presets`
- `buildPresetGrid()` is called after updating `VOICE_PRESETS`

### 5. Base preset has no edgeId
Some built-in presets might use Piper voice IDs instead of Edge IDs. If `base.edgeId` is undefined when the user clicks Save, the endpoint returns 400. The fix is in `saveCurrentVoiceAsPreset()` — fall back to a default Edge ID if `base.edgeId` is empty:
```js
edgeId: base.edgeId || 'en-US-AriaNeural',
```
