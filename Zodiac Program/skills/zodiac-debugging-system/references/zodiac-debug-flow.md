# Zodiac Debug Flow — Step-by-Step Reference

Use this every session, regardless of which part of the Zodiac Program is broken.
Work through the stages in order. Do not skip ahead.

---

## Stage 0 — Get the Full Error First

Before writing a single word of analysis, get the raw error from the user.

Ask for:
1. The complete terminal output — not a summary, the raw text
2. Which command they ran (`npm start`, `npm run sync:worker`, etc.)
3. What they were trying to do (drop a job? open the app? run the test?)

**What a useful error looks like:**
```
[2026-05-11 12:00:01] [ERROR] Job FAILED: scorpio-001
Script generation failed (exit 1): Cannot find module './scripts/zodiac-generate'
    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1039:15)
    at /Users/Anton/Desktop/Zodiac Program/scripts/sync-worker.js:185:24
```

From this you can read: file = `sync-worker.js`, line = 185, problem =
module `zodiac-generate` not found.

---

## Stage 1 — Write the Scope Declaration (mandatory)

This is the most important discipline in this skill. Before opening any file,
write out exactly what you will and will not look at.

**Template:**
```
## Scope Declaration

**I will inspect:**
- [file name + why — e.g., "scripts/sync-worker.js line 185 — where the error was thrown"]
- [at most 4–5 items]

**I will NOT touch:**
- [every major subsystem NOT related to this error]
- Be specific: name the TikTok uploader, UI, cache folders, etc.

**My working hypothesis:**
- [one plain-language sentence about the likely cause]
```

**Why this matters:** Writing the scope declaration forces a decision about what
the actual problem is before any code is opened. It gives the user a chance to
redirect ("actually, check the Drive sync, not the render script") before
wasted effort. It also prevents the most common debugging mistake: opening the
whole project and making changes in multiple places at once.

**Example — render worker crash:**
```
## Scope Declaration

**I will inspect:**
- scripts/sync-worker.js (lines around 185 — generateScript function)
- C:\Zodiac Program\working\ (check if this folder exists)
- sync.config.json (verify homeLocalRoot path)

**I will NOT touch:**
- TikTok uploader or any export workflow
- src/ React/Remotion composition files
- server.ts Express app
- zodiac-generate.ts or zodiac-render.ts
- Any output, cache, or render folders

**My working hypothesis:**
- The temp script file was written to PATHS.working, but that folder does not
  exist because setup:sync was never run on this machine.
```

---

## Stage 2 — Identify the Subsystem

Use this table to match the error to the right reference file.

| Error contains... | Problem area | Reference file to read |
|-------------------|-------------|----------------------|
| `sync-worker.js` | Sync worker | `render-worker-debugging.md` |
| `zodiac-render.ts` / Remotion | Render pipeline | `render-worker-debugging.md` |
| `zodiac-generate.ts` / generateZodiacScript | Script gen | `render-worker-debugging.md` |
| `edge-tts` / TTS / voice | TTS system | `render-worker-debugging.md` |
| `clip.ts` / AssemblyAI | Clip factory | `render-worker-debugging.md` |
| `server.ts` / Express / port | Web app | (inline — usually a port conflict) |
| `ENOENT` / "no such file" | Missing folder | `drive-sync-debugging.md` |
| `requests/` / `final/` / Drive | Drive bridge | `drive-sync-debugging.md` |
| `ANTHROPIC_API_KEY` | API key missing | `render-worker-debugging.md` §6 |

---

## Stage 3 — Read Only the Scoped Files

Open only the files listed in the Scope Declaration. Do not open:
- `node_modules/` — almost never where the real bug is
- The entire `src/` Remotion components — only if the stack trace points there
- Files mentioned as "will NOT touch"

**Pattern:**
1. Open the file named in the error
2. Go to the line number
3. Read 10–20 lines of context around it
4. Look for: wrong variable name, missing `await`, wrong path, uncaught promise

---

## Stage 4 — Confirm or Update the Hypothesis

After reading the scoped files, either confirm the hypothesis or update it.

Write: "The hypothesis is confirmed — the `working/` folder does not exist."
Or: "The hypothesis was wrong — the folder exists but the path in PATHS.working
resolves to `C:Zodiac Program/working` (missing backslash) on this machine."

If still uncertain: add ONE diagnostic log at the exact point of failure and
ask the user to run it and share the output.

```js
// Temporary — remove after debugging
console.log('[DEBUG] PATHS.working =', PATHS.working, '| exists:', fs.existsSync(PATHS.working));
```

---

## Stage 5 — Make the Smallest Fix

Once the cause is confirmed:
- Change only the broken lines
- Show before/after or diff format
- State in one line why this change fixes the specific problem
- Follow every rule in `safe-code-change-rules.md`

**If the fix is "a folder is missing":**
```bash
npm run setup:sync
```
This is always safe — it creates folders without overwriting anything.

---

## Stage 6 — Verify the Fix

Give the user the exact command to run, then describe what they should see.

| Changed area | Test command | Success output |
|-------------|-------------|----------------|
| `sync-worker.js` | `npm run sync:test` | `[INFO] Test PASSED` |
| `server.ts` | `npm start` | Express listening on port |
| Drive paths | See `drive-sync-debugging.md` §6 | All paths `EXISTS ✓` |
| Script gen | Drop a `script-only` job | Job shows `complete` in Drive |
| TTS | Drop a `tts` job | MP3 appears in Drive `final/` |

---

## Stage 7 — Prevent Recurrence

After the fix works, do at least one of:

- Add a startup check (warn early instead of crashing silently)
- Verify `npm run sync:test` covers this scenario
- Add a note to `.env.example` if the bug was a missing key
- Add a comment to the code explaining a non-obvious workaround
- Update `SYNC_SETUP_GUIDE.md` if the fix involves a setup step

---

## Quick Diagnostic Checklist (run when confused)

```bash
# 1. Create all required folders
npm run setup:sync

# 2. Validate sync.config.json
node -e "JSON.parse(require('fs').readFileSync('sync.config.json','utf8')); console.log('Config OK')"

# 3. Check .env keys
node -e "require('dotenv').config(); console.log('ANTHROPIC_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING')"

# 4. Run end-to-end worker test
npm run sync:test

# 5. Check Drive folder exists
node -e "const c=JSON.parse(require('fs').readFileSync('sync.config.json','utf8')); console.log('Drive exists:', require('fs').existsSync(c.googleDriveRoot))"
```

---

## How to Reset a Stuck Job

Job is stuck at `processing` after a crash:

1. Open `Google Drive → Zodiac Program Sync → requests → your-job.json`
2. Change `"status": "processing"` → `"status": "pending"`
3. Delete `"startedAt"`, `"error"`, `"failedAt"` lines if present
4. Save the file
5. Google Drive syncs within a few seconds
6. Worker picks it up on the next 10-second poll
