---
name: add-cinematic-preset
description: Use this skill when the user wants to add a new cinematic visual preset to the Trend Vault studio — a one-click bundle of color grade, grain, blur, fog, vignette, and tone settings (the "Liminal Horror / VHS Nightmare / Storycore" style scrollable cards). Trigger on phrases like "add a preset called X", "make a Y aesthetic preset", "I want a 90s home video preset", "add another vibe to the strip", "create a cinematic look", or anything where the user describes a complete look-and-feel that should be one click.
---

# Add a new cinematic preset

A cinematic preset is a single object in `frontend/trend-vault.html`'s `CINEMATIC_PRESETS` constant + a card button in the scrollable strip. It bundles every visual setting so one click delivers a complete look.

## Step 1: Add the preset object

In `frontend/trend-vault.html`, find `const CINEMATIC_PRESETS = {` and add a new entry. The full schema is:

```js
'preset-id': {
  name: 'Display Name',          // shown in toast when applied
  colorGrade: 'analog',          // any grade in GRADE_FILTERS
  grainType: 'film',             // 'film' | 'digital' | 'vhs' | 'none'
  grainIntensity: 42,            // 0-100
  bgBlur: 6,                     // 0-20
  bgBrightness: 60,              // 20-100 (percent)
  fog:    true,                  // boolean
  rain:   false,
  vignette: true,
  zoom:     true,                // slow zoom toggle

  // Optional cinematic-narrator tone adjustments (composed on top of grade)
  saturation:  0,                // 0-200, 100 = no change
  contrast:    120,              // 50-200, 100 = no change
  exposure:    -10,              // -100 to +100
  highlights:  -15,
  shadows:     -25,

  // Optional text styling overrides — preset can dictate font + animation
  fontFamily:    "'Anton',sans-serif",
  fontSize:      96,
  textColor:     '#ffffff',
  textAnimation: 'word-drop',
  animSpeed:     1.0,
}
```

All optional fields fall back to whatever the user already had set if you omit them. Only specify what's distinctive about your preset.

## Step 2: Add the card button

In the same file, find `<div class="cin-presets-scroll" id="cinPresetsScroll">` and add:

```html
<button class="cin-preset-card" data-preset="preset-id" onclick="applyPreset('preset-id')">
  <span class="cin-preset-icon">🎬</span>
  <span class="cin-preset-name">Display Name</span>
</button>
```

Pick an emoji that hints at the aesthetic (🌑 dark, 🎞️ film, 📼 VHS, 🔮 mystical, 🩸 horror, 🌫️ foggy, etc.).

## Step 3: That's it

`applyPreset()` is already wired to read every field on the preset object, push the values to the right state keys + slider DOMs, and call `updatePreview()`. No additional code needed.

## Naming

- IDs are kebab-case: `liminal-horror`, `vhs-nightmare`, `cathedral-bloom`.
- Names are Title Case: "Liminal Horror", "VHS Nightmare".

## Style cookbook

| Look | Recipe |
|---|---|
| Grunge B&W | colorGrade `mono`, contrast 120, exposure -8, grainType `film`, grainIntensity 50, vignette on |
| Wet asphalt noir | colorGrade `analog`, bgBlur 4, fog on, rain on, shadows -30 |
| Neon dream | colorGrade `cyber`, saturation 140, exposure +10, vignette off, grain low |
| Cathedral memory | colorGrade `liminal`, bgBlur 6, fog on, slowZoom on, fontFamily Anton |

## Verify

After editing, hard-refresh the studio. The new card should appear at the end of the scrollable strip. Clicking it should:
1. Switch to the specified color grade
2. Apply all grain / blur / brightness values
3. Toggle overlays correctly
4. Update tone sliders (if specified)
5. Show toast "✨ Display Name applied"
