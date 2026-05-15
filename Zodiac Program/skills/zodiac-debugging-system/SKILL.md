---
name: zodiac-debugging-system
description: >
  Structured, safe debugging system for the Zodiac Program. Activate this skill
  any time something breaks, errors, produces wrong output, or behaves
  unexpectedly in the Zodiac Program — including the web app, video render
  pipeline, TTS generation, Remotion renderer, Google Drive sync worker, cache
  folders, clip factory, script generation, or TikTok export workflow.

  Trigger whenever the user says: "it's broken", "I'm getting an error", "the
  video didn't render", "the worker crashed", "sync isn't working", "TTS failed",
  "the app won't start", "something is wrong with my Zodiac code", "help me
  debug", "why is this failing", or any description of unexpected behavior.

  This skill forces Claude to declare its exact scope before touching anything,
  fix only the broken part, never rewrite unrelated files, and always tell the
  user exactly what to run and what success looks like. Use it aggressively —
  if there is any hint of a bug or unexpected behavior in the Zodiac Program,
  load this skill.
---

# Zodiac Debugging System

This skill turns Claude into a careful, scoped debugger for the Zodiac Program
— a Node.js / TypeScript / React video generation system that includes a web
app (`server.ts`), a Remotion video renderer, an Edge TTS voiceover system,
an AssemblyAI clip factory, and a Google Drive sync worker.

Bugs can appear in many layers. This skill keeps debugging surgical: one issue,
the smallest possible fix, and no collateral damage to working code.

---

## MANDATORY FIRST STEP — Declare Scope Before Anything Else

Before reading a single file or suggesting any fix, Claude must output a
**Scope Declaration**. This is not optional. It must appear at the top of
every debugging response.

Use this exact format:

```
## Scope Declaration

**I will inspect:**
- [list only the files/folders the stack trace or error points to]
- [maximum 4–5 items — if more are needed, list the most likely ones first]

**I will NOT touch:**
- [list every major part of the project NOT involved in this error]
- Examples: TikTok uploader, UI components, unrelated scripts, cache folders

**My working hypothesis:**
- [one sentence explaining the likely cause in plain language]
```

This declaration keeps Claude honest and gives the user a chance to say
"wait, you're looking in the wrong place" before any work begins.

**Example of a correct Scope Declaration:**

```
## Scope Declaration

**I will inspect:**
- scripts/sync-worker.js (line 185 — where the error was thrown)
- sync.config.json (to verify the working folder path)
- C:\Zodiac Program\working\ (to check if the folder exists)

**I will NOT touch:**
- TikTok uploader or export workflow
- src/ React/Remotion components
- server.ts web app
- zodiac-generate.ts script generator
- Any cache, renders, or final output folders

**My working hypothesis:**
- The temp script file was written to PATHS.working but that folder does not
  exist yet because setup:sync was never run on this machine.
```

---

## Reference files — read these when relevant

| File | When to read it |
|------|----------------|
| `references/zodiac-debug-flow.md` | Every session — the full step-by-step process |
| `references/render-worker-debugging.md` | Errors from sync worker, Remotion, TTS, render jobs |
| `references/drive-sync-debugging.md` | Jobs stuck pending, Drive not syncing, file not found |
| `references/safe-code-change-rules.md` | Before making ANY code change |
| `references/testing-checklist.md` | After the fix — to confirm it actually worked |

Always read `zodiac-debug-flow.md` first. Then read whichever reference file
matches the broken area.

---

## The 10-Step Debugging Order

Work through these in order. Do not skip steps.

**Step 1 — Read the exact error**
Get the full error message. Do not paraphrase. Look for: error type, file
name, line number, exit code, and any "caused by" chain below it.

**Step 2 — Find the command that caused it**
What did the user run? Which job type was involved (`render`, `tts`,
`script-only`, `clip`)? What were they trying to do?

**Step 3 — Declare scope** ← this is where the Scope Declaration goes

**Step 4 — Read only the files in scope**
Open only the files listed in the Scope Declaration. Do not wander into
the rest of the project.

**Step 5 — Explain the likely cause in plain words**
One or two sentences a beginner can understand. If uncertain, say so and
offer to add a single diagnostic log to confirm before changing anything.

**Step 6 — Add one focused log if the cause is unclear**
Add ONE `console.log` at the exact point of failure. Do not scatter logs
across multiple files.

**Step 7 — Suggest a debugger step if useful**
For hard-to-trace errors: `node --inspect scripts/sync-worker.js` and where
to set the breakpoint.

**Step 8 — Make the smallest working fix**
Change only the lines that are broken. Do not refactor, rename, or "clean up"
anything else while fixing the bug.

**Step 9 — Suggest a guard test**
What is the simplest command or check that proves the fix worked and guards
against this bug reappearing?

**Step 10 — Give exact commands + describe success**
Full terminal command(s) to run. Then exactly what the user should see if
it worked.

---

## Zodiac Program — Project Map

Claude must know this structure to write accurate scope declarations.

```
C:\Users\Anton\Desktop\Zodiac Program\        ← projectRoot
  server.ts                                    ← Express web app + render API
  sync.config.json                             ← homeLocalRoot / googleDriveRoot / projectRoot
  package.json
  .env                                         ← ANTHROPIC_API_KEY, ASSEMBLYAI_API_KEY
  scripts/
    sync-worker.js                             ← Google Drive polling worker (main worker)
    zodiac-render.ts                           ← Remotion render orchestrator
    zodiac-generate.ts                         ← Claude AI script generation
    clip.ts                                    ← AssemblyAI clip factory
    setup-sync.ps1                             ← One-time folder setup (PowerShell)
  src/                                         ← Remotion React components (video layout)
  backgrounds/                                 ← Source background videos
  music/                                       ← Music tracks
  zodiac-output/                               ← Active render job outputs
  example-jobs/                                ← Ready-to-use job JSON files

C:\Zodiac Program\                             ← homeLocalRoot (local SSD — never synced)
  incoming\   working\   cache\
  renders\    final\     logs\

C:\Users\Anton\Google Drive\My Drive\Zodiac Program Sync\   ← googleDriveRoot
  requests\   uploads\   final\   logs\
```

### Key npm commands

| Command | What it does |
|---------|-------------|
| `npm start` | Express web app |
| `npm run sync:worker` | Google Drive polling worker |
| `npm run sync:test` | End-to-end worker test (no Claude or Remotion needed) |
| `npm run setup:sync` | Creates all required folders (run once on each machine) |
| `npm run dev` | Remotion Studio for visual preview |

### Job lifecycle

`pending` → `processing` → `complete` / `failed`

The job JSON in `requests/` is updated in place. A job stuck at `processing`
after a crash will not be picked up again automatically — it must be manually
reset to `pending`.

### Error → subsystem quick map

| Error contains... | Look at... |
|-------------------|-----------|
| `sync-worker.js` | Google Drive sync worker |
| `zodiac-render.ts` / `Remotion` | Video render pipeline |
| `zodiac-generate.ts` / `generateZodiacScript` | AI script generation |
| `edge-tts` / TTS / voice | Text-to-speech system |
| `clip.ts` / AssemblyAI | Clip factory |
| `server.ts` / Express / port | Web app |
| `ENOENT` / "no such file" | Missing folder — run `setup:sync` |
| `ANTHROPIC_API_KEY` | Missing key in `.env` |
| `ASSEMBLYAI_API_KEY` | Missing key in `.env` |
| `Cannot find module` | Missing npm package or wrong import path |
| `EADDRINUSE` | Port already in use by another process |

---

## What Claude must NEVER do

These are hard stops — not guidelines.

- **Never skip the Scope Declaration.** If Claude has not declared what it
  will and will not touch, it has not started yet.
- **Never open files not listed in the Scope Declaration** unless the error
  leads there with clear justification.
- **Never rewrite a whole file** when only specific lines are broken.
- **Never "clean up" unrelated code** while fixing a bug.
- **Never make multiple simultaneous changes** — one fix, verify, then the next.
- **Never delete or clear** `cache/`, `working/`, `renders/`, `backgrounds/`,
  or `zodiac-output/` without explicit user confirmation.
- **Never change `sync.config.json` paths** without asking the user to verify
  the new paths first.
- **Never assume the cause** without reading the actual error.
- **Never skip Step 10.** Always describe what success looks like.
- **Never commit or save** changes that have not been tested at least once.

---

## Required Output Format

Every debugging response must follow this structure — in this order:

```
## Scope Declaration
[see format above — always first]

## What the error says
[quote the relevant part — do not paraphrase]

## Likely cause
[1–2 sentences in plain language]

## The fix
[before/after or diff — only the changed lines]

## Commands to run
[exact terminal commands, one per line]

## What success looks like
[describe the exact output or behavior the user should see]
```

If the fix is uncertain: say so. Show the diagnostic log you would add to
confirm the cause before touching any code.

---

## Example prompts this skill handles

- "The sync worker crashed — here's the error: [paste]"
- "My render job is stuck at processing"
- "TTS generation failed and I don't know why"
- "The Remotion render hangs at 0%"
- "npm run sync:test shows MISSING ✗ on both lines"
- "The app won't start — port already in use?"
- "Drive sync isn't picking up my job JSON"
- "Script generation returns empty output"
- "The clip factory says AssemblyAI key is invalid"
- "I made a small change and now something is broken — help me find what"
