---
name: add-color-grade
description: Use this skill when the user wants to add a new color grade, look, color preset, filter, tone, mood, or visual color treatment to the Trend Vault video pipeline. Trigger on phrases like "add a color grade called X", "I want a new look", "make a vintage 70s preset", "add a sepia variant", "create a new color filter", "add another grade chip". Use proactively whenever the user describes a visual aesthetic and implies it should be a reusable preset.
---

# Add a new color grade

A color grade lives in **three files** and they must stay in sync — picking a chip in the UI must produce the exact same filter both in the live preview and in the rendered video.

## File 1: `src/TrendVaultVideo.tsx` — Remotion render

Two edits in this file:

1. Add the grade name to the `colorGrade` type union on the `TrendVaultVideoProps` interface:
   ```ts
   colorGrade: 'none' | 'dark' | ... | 'NEW_NAME';
   ```

2. Add an entry to the `GRADE_FILTERS` table. Each entry lists fully-applied filter values; intensity 0–100 lerps from neutral toward these. Available knobs:
   - `brightness` (1 = neutral)
   - `contrast` (1 = neutral)
   - `saturate` (1 = neutral, 0 = B&W)
   - `sepia` (0 = neutral, 1 = full sepia)
   - `invert` (0 = neutral, 1 = full invert)
   - `hueRotate` (0 = neutral, in degrees)

   Example:
   ```ts
   NEW_NAME: { brightness:0.8, contrast:1.2, saturate:0.6, hueRotate:30 },
   ```

## File 2: `frontend/trend-vault.html` — live preview + UI chip

Three edits in this file:

1. Add the same entry to the JS `GRADE_FILTERS` table (same shape, near the top of the script block).

2. Add a chip button to `#colorGradeGrid`:
   ```html
   <button class="grade-chip" data-grade="NEW_NAME" onclick="setColorGrade('NEW_NAME',this)"
     style="background:rgba(R,G,B,A);color:#XYZ;border-color:#XYZ">Display Name</button>
   ```
   Pick the chip colors so they hint at the look (warm grades use orange/amber, cold grades use blues, etc.).

3. Add a fallback gradient overlay entry in `updatePreview()`'s `filters` object — used when no background video is selected:
   ```js
   NEW_NAME: 'linear-gradient(to top, rgba(...) 0%, ... 100%)',
   ```

## File 3: `scripts/trend-vault-render.ts` — type union for render job

Update the `colorGrade` type union in the `RenderJob.settings` interface to include the new name. Otherwise TypeScript won't compile the render script when the new grade is sent.

## After editing

Run a TypeScript check:
```
npx tsc --noEmit --skipLibCheck
```

Zero errors means it's wired correctly. Then have the user hard-refresh the studio and click the new chip — the preview filter and the render filter must be visually identical.

## Naming + values guidance

- Keep grade ids lowercase, single word: `vintage`, `noir`, `acid`, `cyberpunk`.
- Display names can be richer: "Vintage Film", "Noir Dream".
- Saturation 0 = B&W. 0.3 = bleach bypass. 1.5+ = oversaturated/neon.
- Contrast 1.4+ starts to crush blacks. 0.85– is a faded film look.
- HueRotate 180° is the inverse hue. 30° is warm shift. -30° is cool shift.
- Always keep one of brightness/contrast in the chain, otherwise the grade has no visible effect at intensity > 0.
