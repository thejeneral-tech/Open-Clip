---
name: export-to-capcut
description: Use this skill when the user wants to export the current Zodiac project to a CapCut draft, hand off to CapCut for manual editing/finishing, generate a CapCut .json draft, or any time they mention CapCut export, the 📤 button, or "I want to finish this in CapCut". Use also when CapCut export fails and the user needs help diagnosing why.
---

# Export to CapCut

The CapCut export pipeline runs alongside (NOT instead of) the Remotion render. It produces a CapCut draft folder that the user opens in CapCut desktop to finish editing or add features the studio doesn't support.

## Required: CapCutAPI Python server

Without this Python service, export is impossible. It speaks HTTP on **port 9001** and is separate from Node and Kokoro.

### Starting it

```
cd C:\Users\Anton\Downloads\CapCutAPI-extracted\CapCutAPI-main
python capcut_server.py
```

(Assumes the Python deps from its `requirements.txt` are already installed: `pip install -r requirements.txt`.)

Verify with:
```
http://localhost:9001/
```

Or check the studio's engine-status endpoint:
```
http://localhost:3001/api/zodiac/engine-status
```

`capcut.ok` should be `true`.

## How export works under the hood

The Node server endpoint is `POST /api/zodiac/export-capcut`. It orchestrates:

1. `/create_draft` — creates a 1080×1920 draft
2. `/add_video` — adds the chosen background (must be HTTP-fetchable by CapCutAPI, so Node exposes it at `http://localhost:3001/backgrounds/...`)
3. `/add_audio` — adds the most recent generated narration if `state.customAudio` exists
4. `/add_text` × N — one text segment per script line, using word-aligned timings from AssemblyAI if available
5. `/save_draft` — writes a `dfd_<id>/` folder to CapCutAPI's working directory

## How the user finishes the draft

CapCutAPI writes `dfd_<draftId>` to its server's working directory by default. To make it openable in CapCut:

1. Copy `dfd_<draftId>` into the user's CapCut Drafts folder. Typical locations:
   - Windows: `C:\Users\<user>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft\`
2. Open CapCut. The new draft appears in the project list.

To skip the manual copy: set `CAPCUT_DRAFT_FOLDER` in `.env` to the full path of the CapCut Drafts folder. Then `/save_draft` writes directly there and CapCut sees it immediately.

## Common failures + fixes

| Error | Cause | Fix |
|---|---|---|
| `CapCutAPI server not reachable at http://localhost:9001` | Python server not running | Start `python capcut_server.py` |
| `add_video → HTTP 4xx` | Background URL not reachable from CapCutAPI's process | Verify `http://localhost:3001/backgrounds/<file>` resolves in a browser |
| `Empty draft / no audio` | No narration generated yet OR `state.customAudio` not set | Render once first, or click voice Preview to generate audio |
| Words misaligned in CapCut | AssemblyAI didn't run (no `ASSEMBLYAI_API_KEY`), so even-split fallback was used | Add the key to `.env` and regenerate |

## When user asks "did it work"

`/api/zodiac/export-capcut` returns:
```json
{ "ok": true, "draftId": "dfd_cat_...", "message": "..." }
```

Show the user the `message` field — it tells them exactly where the draft was saved and what to do next.
