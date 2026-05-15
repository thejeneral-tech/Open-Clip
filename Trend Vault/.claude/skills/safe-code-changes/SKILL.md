---
name: safe-code-changes
description: Use this skill before making any code change to the Trend Vault Program — to understand which files are safe to edit, what the blast radius of a change is, and what to verify before and after. Use proactively whenever starting a Phase, fixing a bug, or adding a feature. Trigger on "is it safe to edit X", "what files can I change", "will this break anything", "what's the blast radius", "what should I check first".
---

# Safe Code Changes in the Trend Vault Program

## The file map — change risk levels

### HIGH RISK — changes here break many things
| File | What breaks if wrong |
|------|---------------------|
| `src/TrendVaultVideo.tsx` | Every single render output |
| `scripts/trend-vault-render.ts` | All renders fail silently |
| `server.ts` | Entire studio unusable |
| `frontend/trend-vault.html` | All UI interactions broken |

### MEDIUM RISK — isolated blast radius
| File | What breaks if wrong |
|------|---------------------|
| `scripts/tts/ttsService.ts` | Voice generation |
| `scripts/tts/audioPostProcess.ts` | Voice post-processing |
| `scripts/trend-vault-generate.ts` | Script generation + render timing |
| `scripts/ai-completion.ts` | All AI calls |
| `scripts/sync-worker.js` | Drive sync only |

### LOW RISK — data files, easy to revert
| File | What breaks if wrong |
|------|---------------------|
| `custom-presets.json` | Voice presets |
| `sync.config.json` | Sync paths only |
| `.env` | API keys / env vars |

## Before touching a HIGH RISK file

1. **Understand the full chain** — trace from the UI action → server endpoint → file change → render output
2. **Grep for all callers** of any function you're changing
3. **TypeScript check first**: `npx tsc --noEmit 2>&1 | grep "your-file"` — fix type errors before running
4. **Smallest possible change** — one prop, one function, one line

## Editing `trend-vault.html` safely
- It's a single 4800+ line file. Always use `Edit` with surrounding context to avoid wrong-line edits.
- The `state` object is the source of truth for all UI state — always update state AND call `updatePreview()` together
- Never break the `updatePreview()` function — every slider and control depends on it
- Never add `console.log` in production loops (the preview loop runs at 60fps)

## Editing `TrendVaultVideo.tsx` safely
- Adding a new prop: add to interface → destructure in main component → pass to child → use in child
- Never change `calculateMetadata` return shape without testing a render
- Remotion animations must never throw — wrap in try/catch or use `?? defaultValue`

## Editing `trend-vault-render.ts` safely
- Every new `TrendVaultVideoProps` field must be explicitly set in the `props` block
- The `ensurePublicLink` calls must stay at the top — Remotion needs assets before bundling

## Editing `server.ts` safely
- Never change an endpoint path — the frontend has hardcoded API URLs
- Never change the `TREND_VAULT_OUT` path — render outputs go here
- The SSE clients map (`trendVaultSseClients`) must be cleaned up after renders

## After any change
```bash
# 1. Type check (no new errors in your file)
npx tsc --noEmit 2>&1 | head -20

# 2. Server still starts
npm start &
sleep 3 && curl -s http://localhost:3001/trend-vault -o /dev/null -w "%{http_code}\n"

# 3. Quick API smoke test
curl -s -X POST http://localhost:3001/api/trend-vault/generate-prompts \
  -H "Content-Type: application/json" \
  -d '{"trendVaultSign":"Scorpio","count":4}' | grep -o '"ok":true'
```
