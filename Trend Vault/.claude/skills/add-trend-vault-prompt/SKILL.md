---
name: add-trend-vault-prompt
description: Use this skill when the user wants to add a new story prompt to the Trend Vault studio's prompt library — the cards shown in the "STORY PROMPT" card under categories like Heartbreak / Ghosting / Obsession / Loyalty. Trigger on phrases like "add a prompt about X", "add another Scorpio prompt", "create a new ghosting prompt", "add a category", "let me add 10 prompts", "extend the prompt library".
---

# Add trend-vault prompts

The prompt library is **inline JSON** inside `frontend/trend-vault.html`, in the `INLINE_PROMPTS_DATA` constant (around line 1370). The studio fetches `/api/prompts` at boot but falls back to this inline data — so this is the single source of truth.

## Schema

```json
{
  "categories": [
    { "id": "kebab-case", "label": "Display Name", "emoji": "🌑" }
  ],
  "prompts": [
    {
      "id": <UNIQUE_INT>,
      "category": "<category.id>",
      "sign": "Scorpio | All | Aries | ... | Pisces",
      "prompt": "The on-screen hook line (under 80 chars ideally).",
      "angle": "The deeper psychological angle that flavors the AI-generated body.",
      "intensity": "medium | high | very high",
      "tags": ["scorpio","walls","love","fear"]
    }
  ]
}
```

## Adding a single prompt

1. Open `frontend/trend-vault.html`.
2. Locate `const INLINE_PROMPTS_DATA = {` (around line 1370).
3. The `prompts` array is one big inline JSON line. Find the highest existing `id` (currently 167 as of 2026-05) and use the next integer.
4. Add the new object inside the `prompts: [...]` array. Maintain comma punctuation.
5. If the category is new, add it to `categories: [...]` too.

## Adding a category

```json
{ "id": "new-category", "label": "Display Name", "emoji": "🎭" }
```

Pick an emoji that hints at the theme. The label is what users see in the chip grid.

## Adding many prompts at once

When the user wants to add 5+ prompts, batch them:
1. Read the file.
2. Find the closing `]` of the `prompts` array.
3. Insert the new objects right before it, comma-separated.
4. Save once.

Verify no trailing-comma errors by hard-refreshing the studio and confirming the category chip shows the new count.

## Writing prompts that perform

The `prompt` and `angle` fields drive the AI script generator. Strong prompts share these traits:

- **The prompt sounds like a hook** — past-tense or present-tense observation that promises insight. "Why Scorpios disappear when they care too much." > "Scorpio relationships."
- **The angle goes one psychological layer deeper** — explains the WHY behind the surface pattern. "Vulnerability terrifies them" > "they're confused."
- **The sign is specific or 'All'** — sign-specific prompts feel personalized; 'All' prompts work for any sign.
- **The tags are searchable** — lowercase, kebab-or-snake, single concept each.

## Display capitalization

The studio renders prompts in uppercase (CSS `text-transform: uppercase`). So write the JSON in normal case — the display layer handles the caps.

## Verify

Hard-refresh the studio. Click the category. The new prompt should appear in the list. Click it → the prompt display panel below should show the full text + angle.

If nothing appears, you likely have a JSON syntax error. Open browser DevTools console; a `SyntaxError: Unexpected token` at the bottom points to it.
