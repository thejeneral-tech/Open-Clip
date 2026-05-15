---
name: debug-story-prompts
description: Use this skill when the Story Prompt panel is broken — clicking Generate Prompts returns the wrong number, always returns the same prompts, returns empty, or crashes. Trigger on phrases like "prompts not generating", "always 4 same prompts", "story prompts broken", "generate prompts error", "wrong number of prompts".
---

# Debug Story Prompt Generation

## Files involved
- `server.ts` lines ~1684–1722 — `POST /api/trend-vault/generate-prompts`
- `server.ts` lines ~1658–1682 — `FALLBACK_PROMPTS` bank + `_fallbackPrompts()`
- `scripts/ai-completion.ts` — `aiComplete()`
- `frontend/trend-vault.html` — prompt panel UI + caller function

## Files NOT to touch
- `scripts/trend-vault-generate.ts`
- `src/TrendVaultVideo.tsx`
- `scripts/sync-worker.js`

## Decision tree

### 1. Test the endpoint directly
```bash
curl -X POST http://localhost:3001/api/trend-vault/generate-prompts \
  -H "Content-Type: application/json" \
  -d '{"trendVaultSign":"Scorpio","category":"general","count":4}'
```
Expected: `{ ok: true, prompts: [...4 items...], provider: "fallback"|"claude"|"openai" }`

### 2. Verify exactly 4 prompts are returned
The server clamps: `const n = Math.min(Math.max(count || 4, 1), 20)`.
- `count` not sent → defaults to 4 ✓
- `count: 0` → clamps to 1 (not 4) — check frontend sends `count: 4` explicitly
- Response `prompts.length !== 4` when `count=4` → `_fallbackPrompts` pool is too small for the sign

### 3. Check fallback pool size
`FALLBACK_PROMPTS` in `server.ts` has arrays per sign. Each sign has 8 entries. `_fallbackPrompts()` shuffles and slices to `n`. If `exclude` array contains 5+ items from the pool, the filtered list may be smaller than 4 — the function then falls back to the full (unfiltered) pool. This should always return 4.

### 4. Check AI returning wrong count
If `provider: "claude"` or `"openai"`, the AI was called. The prompt asks for a JSON array of `n` strings. `parseAIJson` returns the array. The response is then `.slice(0, n)`. If AI returns fewer than `n`, the response will have fewer prompts — this is an AI compliance issue, not a code bug.

### 5. Frontend: exclude list growing too large
The frontend may send `exclude` (already-shown prompts) to avoid repeats. If the exclude list grows beyond the pool size, all prompts may repeat anyway. The server handles this with the fallback to full pool — but check `frontend/trend-vault.html` to confirm `exclude` is being capped or reset.

## Quick test (no API key needed)
```bash
curl -X POST http://localhost:3001/api/trend-vault/generate-prompts \
  -H "Content-Type: application/json" \
  -d '{"trendVaultSign":"Scorpio","count":4}'
# Must always return exactly 4 prompts regardless of API key status
```
