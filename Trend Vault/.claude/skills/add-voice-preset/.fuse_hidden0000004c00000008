---
name: add-voice-preset
description: Use this skill when the user wants to add a new voice preset, narrator character, voice variant, or TTS preset to the Trend Vault studio. Trigger on phrases like "add a voice called Witch Queen", "create a new narrator preset", "I want a Russian villain voice", "make a young heroine voice", "add another preset to the voice grid", or any time the user describes a vocal character/persona that should be selectable.
---

# Add a new voice preset

Voice presets live in `scripts/tts/voicePresets.json` as a JSON array. The studio loads them at startup; no code changes elsewhere are needed for a new preset to appear.

## Schema

```json
{
  "id": "snake_case_id",
  "name": "Display Name",
  "icon": "🎙️",
  "description": "Short • dot-separated • adjectives",
  "category": "ancient_medieval",
  "favorite": false,
  "edgeId": "en-US-DavisNeural",
  "defaults": { "pitch": -3, "rate": -10, "speed": 0.90, "volume": 2, "intensity": 30 },
  "sliders": { "throatDepth": 70, "ancientRasp": 40, "royalPace": 60, "chamberSpace": 50 },
  "eq": "velvet",
  "reverb": true,
  "robot": false,
  "tags": ["narrator","cinematic"],
  "energyRating": 7,
  "realismRating": 10,
  "retentionRating": 9,
  "contentType": ["dark_storytelling","narrator"],
  "exampleLine": "A short representative line that shows the voice's character.",
  "pacing": "slow",
  "emotionalIntensity": "high"
}
```

## Field guidance

- **id** — lowercase snake_case. Used as the identifier in state. If it matches a regex like `cinematic`, `narrator`, `ancient`, etc., the cinematic preprocessor enables longer pause defaults (good for storytellers).
- **edgeId** — picks the underlying voice. The Kokoro server maps these to its own voice IDs in `kokoro-tts/kokoro_server.py` `VOICE_MAP`. If you use a NEW edge voice not in the map, Kokoro falls back to `af_bella` — add it to the map if it matters.
- **defaults** — applied to the 5 base sliders (Pitch / Rate / Speed / Volume / Intensity) when the preset is selected.
- **sliders** — the 4 cinematic-narrator sliders. Defaults apply when the user hasn't manually moved them.
- **eq** — `'broadcast' | 'warm' | 'dark' | 'bright' | 'thin' | 'velvet' | 'clear' | 'none'`.
- **reverb** — boolean; when on, the FFmpeg chain adds an aecho layer keyed off `intensity`.

## Slider value cookbook

| Vibe | throatDepth | ancientRasp | royalPace | chamberSpace |
|---|---|---|---|---|
| Old wise narrator | 60 | 50 | 65 | 35 |
| Deep king | 85 | 35 | 70 | 55 |
| Cave prophet | 75 | 55 | 80 | 90 |
| Light young | 20 | 10 | 30 | 15 |
| Heroic knight | 75 | 70 | 50 | 35 |
| Cathedral monk | 60 | 20 | 70 | 85 |
| Witch / occult | 70 | 65 | 60 | 70 |

## Edge voice cheat sheet (deepest → lightest)

- `en-US-DavisNeural` — deep, gravelly-leaning, best for raspy/king
- `en-US-EricNeural` — deep, smooth, best for cave/oracle
- `en-US-AndrewNeural` — clear, polished narrator
- `en-US-GuyNeural` — neutral male
- `en-US-SteffanNeural` — warm professorial
- `en-US-TonyNeural` — energetic/fast
- `en-US-ChristopherNeural` — broadcast/news
- `en-US-RogerNeural` — older male timbre
- `en-US-AriaNeural` — female, can do smoky-cinematic with deep pitch
- `en-US-JennyNeural` — female, polished narrator

## Add the preset

1. Open `scripts/tts/voicePresets.json`.
2. Insert the new object before the closing `]`.
3. Make sure the comma punctuation is correct — JSON requires a comma after the previous entry, none after the new one if it's last.
4. Save. No restart required for the next render — the file is read on every `generateVoice` call. (The frontend list is loaded at studio init though, so hard-refresh to see the new preset chip.)

## Verify

- Hard-refresh the studio.
- Find the new preset card in the Voice Preset grid.
- Click TEST on its card. Should hear the example line at the configured slider settings.
- Slider sliders should snap to your declared `sliders` values when the preset is selected.
