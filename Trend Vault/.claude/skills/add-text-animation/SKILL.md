---
name: add-text-animation
description: Use this skill when the user wants to add a new text/caption animation effect — entry animations like pop-ins, fades, glitches, reveals, scale, slide, shimmer, dissolves, or any new way for script text to appear on the rendered video. Trigger on phrases like "add a glitch text animation", "make a typewriter effect", "I want text that pixelates in", "add another animation to the dropdown", "create a new caption entrance".
---

# Add a new text animation

Text animations live in **two synchronized places** — `src/ZodiacVideo.tsx` (for the actual Remotion render) and `frontend/zodiac.html` (for the live preview). Both must produce visually-equivalent motion or preview ≠ render.

## Step 1: Add to `textAnimation` type union

Both files reference a type union. Add the new id to:

1. `src/ZodiacVideo.tsx` — `textAnimation` on `ZodiacVideoProps`
2. `scripts/zodiac-render.ts` — `textAnimation` on `RenderJob.settings`

Example: append `| 'NEW_NAME'` to the existing chain.

## Step 2: Remotion implementation in `ScriptLineComp`

Find `ScriptLineComp` in `src/ZodiacVideo.tsx`. The animation pattern is:

```tsx
} else if (textAnimation === 'NEW_NAME') {
  // Compute per-frame transforms / opacity / etc. using:
  //   localFrame      — frames since this line started
  //   lineDuration    — total frames this line is on screen
  //   FADE_IN/FADE_OUT — defaults
  //   spd             — animSpeed multiplier
  //   interpolate(...) — frame-locked transforms (deterministic, never CSS)
  //   Easing.out(...)  — easing functions

  // Examples of how to drive things:
  //   - Per-character spans (like shimmer / cascade / dissolve)
  //   - Whole-text transform (like rise / bounce / glitch-in)
  //   - Per-word spans (like word-drop)

  return (
    <div style={{ ...containerCss, opacity, transform, filter }}>
      <p style={getTextStyle(line.type, fontFamily, fontSize, textColor, extraStyle)}>
        {/* content */}
      </p>
    </div>
  );
```

Critical rules:
- **Frame-locked, deterministic** — every value derived from `localFrame`, never random or time-based.
- **Use `containerCss`** for the outer wrapper — it handles the user's `captionTopPct` drag position and centering.
- **Per-character animation** — split `line.text.split('')`, map to `<span>`s with their own opacity/transform. Spaces stay; they preserve word breaks.
- **Per-word animation** — split `line.text.split(' ')`, map with `display:inline-block` on each span so transforms work.
- **Deterministic randomness** — if you want pseudo-random order (like dissolve), seed an LCG with `line.text.split('').reduce((a,c)=>a+c.charCodeAt(0),17)`. Same seed → same order across the render and preview.

## Step 3: HTML preview implementation in `playCaptionAnim`

In `frontend/zodiac.html`, find `function playCaptionAnim(cap, text, anim, lineDurMs, speed)`.

Two paths:

**Path A — CSS keyframe animation** (good for whole-text animations):
1. Add a `@keyframes capNEW_NAME { ... }` block in the `<style>` section
2. Add a `.cap-anim-NEW_NAME { animation: capNEW_NAME var(--anim-dur,.5s) ease forwards }` rule
3. Add `'NEW_NAME'` to `ANIM_CLASSES` array
4. Add `'NEW_NAME': baseDurInMs` to `ANIM_BASE_DUR` map
5. Add `'NEW_NAME'` to the list in `if(['fade','slide-up',...].includes(anim))` so the CSS branch fires for it

**Path B — JS-driven per-char animation** (good for per-character effects):
Add a new `else if(anim === 'NEW_NAME')` branch following the pattern of `shimmer` / `cascade` / `dissolve`:
- Split text into chars/words
- Create spans, append to `cap`
- Use `_twTimeouts.push(setTimeout(...))` to stagger opacity/transform changes
- Speed scales via `spd` variable (already in scope)

## Step 4: Register in the UI dropdown

In the HTML, find the `<select id="textAnimSelect">` element. Add an `<option>` under an existing `<optgroup>` or create a new one:
```html
<option value="NEW_NAME">⚡ Display Name</option>
```

## Step 5: Include in random pool

Update the `anims` array inside `randomTextAnimation()` so the new animation can be picked by ⚡ RANDOM ANIM.

## Verify

1. Run `npx tsc --noEmit --skipLibCheck` — zero errors expected
2. Hard-refresh studio
3. Pick the new animation from the dropdown
4. Confirm preview matches what a render would produce (the math must be the same on both sides)
