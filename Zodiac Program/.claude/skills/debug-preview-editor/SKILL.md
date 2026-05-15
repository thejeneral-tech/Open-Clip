---
name: debug-preview-editor
description: Use this skill when the preview editor is broken — the Layers panel doesn't open, undo/redo doesn't work, caption rotation has no effect, the TikTok white-box preset does nothing, the caption position slider doesn't move captions, or the preview doesn't update after changing settings. Trigger on "layers panel not opening", "undo broken", "redo not working", "rotate does nothing", "caption not moving", "preview not updating", "white box not showing", "Ctrl+Z doesn't work".
---

# Debug Preview Editor

## Files involved
- `frontend/zodiac.html` — ALL preview editor logic lives here
  - `state` object (line ~1510) — `captionTopPct`, `captionRotate`, `captionBgStyle`, `fontSize`
  - `updatePreview()` — applies state to the preview DOM
  - `undo()`, `redo()`, `pushUndo()`, `_applyUndo()` — undo engine
  - `toggleLayersPanel()` — shows/hides the layers panel
  - `UNDO_KEYS` — list of state keys tracked by undo

## Files NOT to touch
- `src/ZodiacVideo.tsx` — Remotion render component
- `scripts/zodiac-render.ts` — server-side render script
- `server.ts`

## Component map
| Feature | Where in zodiac.html |
|---------|---------------------|
| Layers panel toggle button | `id="layersTabBtn"` |
| Layers panel container | `id="layersPanel"` |
| Rotate slider | `id="captionRotateSlider"` |
| Scale (font) slider | `id="layerFontSlider"` |
| Move Y slider | updates `state.captionTopPct` |
| Center button | `onclick="state.captionTopPct=50;updatePreview()"` or similar |
| Undo button | `id="undoBtn"` |
| Redo button | `id="redoBtn"` |
| TikTok preset | button with `onclick` setting `state.captionBgStyle='white'` |

## Decision tree

### 1. Layers panel doesn't open
Check `toggleLayersPanel()` exists and targets `id="layersPanel"`. The panel has `display:none` initially — the toggle should set it to `display:flex` or remove the `display:none`.

### 2. Rotate/scale sliders do nothing
Both sliders must call `updatePreview()` on `oninput`. Check:
- `captionRotateSlider` `oninput` updates `state.captionRotate` AND calls `updatePreview()`
- `layerFontSlider` `oninput` updates `state.fontSize` AND calls `updatePreview()`
- `updatePreview()` applies `transform: rotate(${state.captionRotate}deg)` to the caption element

### 3. Caption style buttons do nothing
Buttons for Default / TikTok / Dark / Yellow call code like:
`state.captionBgStyle = 'white'; updatePreview();`
If `updatePreview()` doesn't handle `captionBgStyle`, the preview won't change. Look for the `switch(state.captionBgStyle)` block in `updatePreview()`.

### 4. Undo/Redo not working
- `UNDO_KEYS` must include the key you're trying to undo (e.g. `captionRotate`, `captionBgStyle`)
- `pushUndo()` must be called BEFORE the change (not after)
- Slider changes: a global `pointerdown` listener on `type=range` calls `pushUndo()` except for excluded sliders. Confirm `captionRotateSlider` is in the exclusion list (it has its own undo logic).
- `_applyUndo(snap)` must call `updatePreview()` at the end

### 5. Ctrl+Z not working
The keyboard handler is in the `keydown` event listener. Check:
- `e.ctrlKey && !e.shiftKey && e.code === 'KeyZ'` → calls `undo()`
- `e.ctrlKey && e.shiftKey && e.code === 'KeyZ'` → calls `redo()`
- The listener must be on `document`, not on a specific element

### 6. Undo buttons always greyed out
`_syncUndoBtns()` must be called after every `pushUndo()`, `undo()`, and `redo()`. It sets `undoBtn.disabled = _undoStack.length === 0`.
