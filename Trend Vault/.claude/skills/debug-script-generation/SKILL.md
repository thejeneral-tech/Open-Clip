---
name: debug-script-generation
description: Use this skill when script generation is broken — the Generate Script button does nothing, returns an error, returns empty lines, uses the wrong fallback, or the AI key is exhausted. Trigger on phrases like "script not generating", "generate script broken", "no lines returned", "Anthropic error", "fallback script always used", "OpenAI fallback not working".
---

# Debug Script Generation

## Files involved
- `server.ts` lines ~540–613 — `POST /api/zodiac/generate-script`
- `scripts/zodiac-generate.ts` — `generateZodiacScript()`, `generateFallbackScript()`
- `scripts/ai-completion.ts` — `aiComplete()`, `parseAIJson()`
- `frontend/zodiac.html` — `generateScript()` function, caller of the endpoint

## Files NOT to touch
- `src/ZodiacVideo.tsx` — render component, unrelated
- `scripts/sync-worker.js` — Drive worker, unrelated
- `scripts/zodiac-render.ts` — render pipeline, unrelated

## Decision tree

### 1. Check which provider is active
```
GET http://localhost:3001/api/zodiac/engine-status
```
If `anthropicOk: false` AND `openaiOk: false` → both keys missing/exhausted → fallback is expected.

### 2. Test the endpoint directly
```bash
curl -X POST http://localhost:3001/api/zodiac/generate-script \
  -H "Content-Type: application/json" \
  -d '{"zodiacSign":"Scorpio","prompt":"Why Scorpio never forgets","emotionalTone":"dark","targetDuration":90}'
```
- `source: "claude"` → Anthropic worked
- `source: "openai"` → OpenAI fallback worked
- `source: "fallback"` → both AI providers failed; script is template-generated
- HTTP 400 → `zodiacSign` or `prompt` missing from request

### 3. Check fallback script quality
`generateFallbackScript()` in `scripts/zodiac-generate.ts` builds from a static template. If the fallback is returning garbage lines, the template logic is broken. Check the function signature: `{ zodiacSign, prompt, angle }`.

### 4. Check `parseAIJson`
If AI returned something but parsing failed, `aiComplete` logs a warning. Check server stdout for `[Zodiac] Anthropic script error:` lines. Common causes: AI returned markdown fences around the JSON, or returned extra prose.

### 5. Frontend call
In `zodiac.html`, search for `generate-script` — the fetch call. Confirm it sends `zodiacSign` and `prompt` (both required). If `state.sign` is null when the user clicks, the request body is missing `zodiacSign` → server returns 400.

## Quick test
```bash
# Returns fallback immediately (no API key needed):
curl -X POST http://localhost:3001/api/zodiac/generate-script \
  -H "Content-Type: application/json" \
  -d '{"zodiacSign":"Scorpio","prompt":"test"}'
# Expect: {"ok":true,"script":{...},"source":"fallback"}
```
