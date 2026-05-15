---
name: add-motivational-script
description: Use this skill when the user wants to write or add a new motivational / cinematic zodiac script — including replacing one of the 12 built-in sign scripts, adding scripts for a different topic, or contributing a brand new sign-agnostic motivational story. Trigger on phrases like "write a motivational script for Scorpio", "add a Pisces grow-after-heartbreak script", "swap the Aries script", "give me a new cinematic narration", "build me a passionate script for [sign]", or "add this script to the library".
---

# Add a motivational script

Scripts live in `scripts/motivational-scripts.ts` inside `MOTIVATIONAL_SCRIPTS` (a `Record<sign, GeneratedLine[]>`). Each entry is an array of `GeneratedLine` objects with `text`, `type`, and `durationSeconds`.

## The 7-section structure

Every motivational script follows this skeleton:

1. **HOOK** — `type: 'hook'`, 1–2 short lines that stop the scroll
2. **OBSERVATION** — `type: 'observation'`, 2–4 lines about an emotional pattern
3. **ENERGY SHIFT** — `type: 'escalation'`, 2–3 lines about the new phase
4. **STRENGTH** — `type: 'observation'`, 2–3 lines praising a real trait
5. **MOTIVATION** — `type: 'twist'`, 1–2 lines that push forward
6. **DEEP TRUTH** — `type: 'truth'`, 1–2 lines revealing the underlying meaning
7. **ENDING** — `type: 'ending'`, 1–3 lines that land calmly + powerfully

Total: ~15–18 lines, ~50–65 seconds at slow narrator pacing.

## Duration heuristic

Pick `durationSeconds` per line based on word count:

| Line type | Words | Seconds |
|---|---|---|
| Short hook | ≤6 | 2.5 |
| Medium statement | 7–12 | 3.5–4.0 |
| Long reflective line | 13–18 | 4.5–5.5 |
| Very long | 19+ | 6.0 |

## Editing pattern

Use the `L()` helper that's already imported at the top of the file:

```ts
L = (text, type, durationSeconds): GeneratedLine
```

Add or replace an entry in `MOTIVATIONAL_SCRIPTS`:

```ts
Capricorn: [
  L("The years you spent climbing in silence are about to speak.", 'hook', 5.0),
  L("Capricorn — the harvest is real.", 'hook', 3.5),
  // ... 13 more lines
],
```

## Writing rules (do NOT break)

- **Positive only.** No fear, no fake promises, no "they hate you" energy.
- **No emojis, no hashtags.**
- **One sentence per line.** Multi-sentence lines hurt the per-line caption pipeline.
- **No second-person presumption that sounds judgmental.** "You are allowed to choose yourself first" > "You always shrink yourself for others".
- **Use the sign's name once in HOOK and once near ENDING** for caption-card placement.
- **Use em-dashes deliberately** — they become cinematic breath pauses in the TTS preprocessor.

## After adding

The script is automatically picked up by `getMotivationalScript(sign)` and `generateFallbackScript()` when the tone is `'motivational' | 'positive' | 'cinematic'` or no prompt is supplied. No other code edits needed.

Run a TypeScript check:
```
npx tsc --noEmit --skipLibCheck
```

## Verifying in the app

The motivational scripts are NOT exposed in the UI (intentionally — they're a silent library). To trigger one, either:
- Generate a script via the AI Generate button without a custom prompt
- Or call `/api/zodiac/generate-zodiac-script` server-side with `emotionalTone: 'motivational'`

The output of `generateFallbackScript()` is automatically uppercased for TikTok caption style.
