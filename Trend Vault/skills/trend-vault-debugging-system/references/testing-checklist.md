# Testing Checklist

Use this after every bug fix to confirm the fix actually worked and the system
is healthy. Run only the tests relevant to what you changed — you do not need
to run everything every time.

---

## Quick Health Check (run any time something feels off)

```bash
# 1. Are all required folders present?
npm run setup:sync

# 2. Is the config valid?
node -e "const c=JSON.parse(require('fs').readFileSync('sync.config.json','utf8')); console.log('Config OK:', JSON.stringify(c,null,2))"

# 3. Is the .env file present?
type .env

# 4. Does node_modules exist?
dir node_modules /b | findstr remotion

# 5. Does the end-to-end worker test pass?
npm run sync:test
```

---

## Test 1 — Worker End-to-End (most important)

**When to run:** After any change to `sync-worker.js`, `sync.config.json`,
or any script it calls.

**Command:**
```bash
npm run sync:test
```

**What it does:** Creates a fake `script-only` job (no Claude or Remotion
needed), runs it through the full worker pipeline, and checks that the output
file appears in both local `final/` and Drive `final/`.

**Success looks like:**
```
[INFO] Local out  : C:\Trend Vault Program\final\test-..._script.json — EXISTS ✓
[INFO] Drive out  : ...\Trend Vault Program Sync\final\test-..._script.json — EXISTS ✓
[INFO] Test PASSED — pipeline is working correctly.
```

**If it says MISSING ✗:** Something in the worker pipeline failed. Read the
log lines above for the error.

---

## Test 2 — Web App Startup

**When to run:** After any change to `server.ts` or `package.json`.

**Command:**
```bash
npm start
```

**Success looks like:** Something similar to:
```
Server running on http://localhost:3001
```
No red error text. The app loads in a browser.

**Common failure:** `EADDRINUSE` — a previous instance is still running.
Kill it:
```bash
# Find the process using the port (replace 3001 with your port)
netstat -ano | findstr :3001
taskkill /PID <pid-number> /F
```

---

## Test 3 — JSON Validation for Job Files

**When to run:** Any time you hand-edit a job JSON file before dropping it
into Drive.

**Command:**
```bash
node -e "JSON.parse(require('fs').readFileSync('example-jobs/render-scorpio.json','utf8')); console.log('JSON valid')"
```
Replace the filename with your actual job file path.

**Success looks like:** `JSON valid`

**Failure looks like:** `SyntaxError: Unexpected token ...` with a line/column
number. Open the file and fix the syntax at that position.

---

## Test 4 — Script Generation Only (no render)

**When to run:** After changing `trend-vault-generate.ts` or fixing a
`ANTHROPIC_API_KEY` issue.

**Step 1 — Create a script-only job:**
```json
{
  "jobId": "test-script-001",
  "type": "script-only",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",
  "script": {
    "trendVaultSign": "Leo",
    "emotionalTone": "motivational",
    "prompt": "why they never give up",
    "targetDuration": 30
  }
}
```

**Step 2 — Drop it in Drive `requests/` and watch the worker log.**

**Success looks like:**
```
[INFO] Generating script: Leo / motivational / "why they never give up"
[INFO] Script ready: 6 lines, ~30s
[INFO] Job complete: test-script-001
```
And a `test-script-001_script.json` file appears in Drive `final/`.

---

## Test 5 — TTS Only

**When to run:** After fixing a TTS-related error.

**Create a TTS job:**
```json
{
  "jobId": "test-tts-001",
  "type": "tts",
  "status": "pending",
  "createdAt": "2026-05-11T12:00:00Z",
  "voice": { "presetId": "en-US-DavisNeural", "rate": "-10%", "pitch": "-3Hz" },
  "scriptLines": [
    { "text": "This is a test.", "type": "hook", "durationSeconds": 3 }
  ]
}
```

**Success:** An MP3 file appears in Drive `final/` and has a size greater than 0.

---

## Test 6 — Remotion Preview (not a full render)

**When to run:** After changing anything in `src/` (Remotion components).

**Command:**
```bash
npm run dev
```

**Success:** Remotion Studio opens in the browser. You can preview compositions
without rendering a full video. This is much faster than running a full render job.

---

## Test 7 — Folder Existence Check

**When to run:** After running `npm run setup:sync` or if you suspect a folder
is missing.

**Command (PowerShell):**
```powershell
$dirs = @(
  "C:\Trend Vault Program\incoming",
  "C:\Trend Vault Program\working",
  "C:\Trend Vault Program\cache",
  "C:\Trend Vault Program\renders",
  "C:\Trend Vault Program\final",
  "C:\Trend Vault Program\logs",
  "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\requests",
  "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\uploads",
  "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\final",
  "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\logs"
)
foreach ($d in $dirs) {
  if (Test-Path $d) { Write-Host "EXISTS ✓  $d" -ForegroundColor Green }
  else              { Write-Host "MISSING ✗  $d" -ForegroundColor Red }
}
```

**Success:** All lines say `EXISTS ✓`.
Any `MISSING ✗` line means `npm run setup:sync` needs to be run (or the Drive
path in `sync.config.json` is wrong).

---

## After Tests Pass — Final Checks

Before considering the bug "done":

- [ ] Remove any temporary `console.log` debug lines added during investigation
- [ ] If the fix involved a new folder or file, verify `npm run setup:sync`
      creates it correctly for a fresh setup
- [ ] If the bug was a missing API key, confirm `.env.example` documents it
- [ ] If the bug was a path mismatch, confirm `SYNC_SETUP_GUIDE.md` explains
      how to find the right path
- [ ] Check the worker log one more time for any lingering `[ERROR]` or
      `[WARN]` lines after the fix was applied
