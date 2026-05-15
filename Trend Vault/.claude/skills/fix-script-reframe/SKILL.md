---
name: fix-script-reframe
description: Use this skill when Script Reframe is broken — lines come back reordered, the wrong number of lines is returned, all lines are identical after reframe, AI rewrites instead of reframes, or the local fallback engine produces bad output. Trigger on phrases like "reframe broken", "lines out of order after reframe", "reframe scrambled my script", "wrong line count", "regenerate script not working".
---

# Fix Script Reframe

## Files involved
- `server.ts` lines ~1601–1656 — `POST /api/zodiac/regenerate-script`
- `server.ts` lines ~1470–1600 — `localReframe()` engine (zero-API fallback)
- `scripts/ai-completion.ts` — `aiComplete()`, `parseAIJson()`
- `frontend/zodiac.html` — `reframeScript()` or similar caller

## Files NOT to touch
- `scripts/zodiac-generate.ts` — script generator, separate concern
- `src/ZodiacVideo.tsx`
- `scripts/zodiac-render.ts`

## Decision tree

### 1. Confirm input is correct
The endpoint requires `existingLines` array — it must have at least one item.
```bash
curl -X POST http://localhost:3001/api/zodiac/regenerate-script \
  -H "Content-Type: application/json" \
  -d '{
    "zodiacSign":"Scorpio","prompt":"test","angle":"","emotionalTone":"dark",
    "existingLines":[
      {"text":"Line 1","type":"hook","durationSeconds":4},
      {"text":"Line 2","type":"observation","durationSeconds":5}
    ]
  }'
```
- `source: "claude"` or `"openai"` → AI reframe
- `source: "local"` → local engine fallback (no API)
- HTTP 400 → `existingLines` missing

### 2. Check order preservation
The AI prompt explicitly states: "Return lines in the EXACT same order as the input, line 1 stays line 1". If AI is reordering, the prompt may have regressed. Check the `aiPrompt` string in `server.ts` around line 1612. The instruction "do NOT reorder, move, or renumber them" must be present.

### 3. Check line count preservation
The AI prompt says "Keep the same number of lines (only merge two lines if they are near-identical duplicates)". If AI is dropping lines, the response JSON array has fewer items than input. Check `parseAIJson` result length vs `existingLines.length`.

### 4. Local engine validation
`localReframe()` at `server.ts` ~line 1470 rewrites each line in place using local string manipulation. It must:
- Return exactly `existingLines.length` items
- Preserve `type` field
- Not reorder

If local engine fails, read `localReframe` implementation and check the loop is `existingLines.map()` not `sort()`.

### 5. Frontend: what triggers reframe
Search `zodiac.html` for the function that calls `/api/zodiac/regenerate-script`. Confirm it passes `existingLines: state.script` (the current lines in order, not sorted or filtered).

## Key invariant
Input line count === output line count (unless near-duplicates merged). Always verify this in any fix.
