---
name: debug-drive-sync
description: Use this skill when the Drive sync is broken — jobs aren't being picked up, the worker crashes, output files don't appear in the final folder, logs are missing, or the worker is stuck in a loop. Trigger on "sync not working", "job not picked up", "drive sync broken", "worker crashed", "output not appearing", "sync worker error", "job stuck", "Drive not syncing".
---

# Debug Google Drive Sync

## Files involved
- `scripts/sync-worker.js` — the worker (runs on HOME COMPUTER)
- `sync.config.json` — paths config (project root)
- `C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\` — Drive bridge
- `C:\Trend Vault Program\` — local SSD on home computer (not synced to Drive)

## Files NOT to touch
- `server.ts` — laptop server, separate
- `frontend/trend-vault.html`
- `src/TrendVaultVideo.tsx`

## Decision tree

### 1. Run the test first
```bash
npm run sync:test
# Must print: TEST PASSED — 18/18 checks passed
```
If any check fails, the output tells you exactly which folder or write failed.

### 2. Check Drive is mounted
```bash
dir "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync"
# Must show: final  logs  requests  uploads
```
If the folder doesn't exist or is empty: Google Drive desktop app is not running or not signed in.

### 3. Check worker is running (home computer)
```bash
node scripts/sync-worker.js
```
Should print: `[INFO] Trend Vault Sync Worker started. Polling every 10 seconds.`

If it crashes immediately:
- Check `sync.config.json` exists
- Check `homeLocalRoot` path exists (`C:\Trend Vault Program` on home computer)
- Check `googleDriveRoot` path exists

### 4. Job not being picked up
Drop a test job manually:
```bash
echo '{"id":"debug-001","type":"script-only","trendVaultSign":"Scorpio","scriptLines":[{"text":"Test","type":"hook","durationSeconds":3}]}' > "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\requests\debug-001.json"
```
Wait 10–15 seconds. Worker should log `[PENDING] Job debug-001`.

If not picked up:
- `PATHS.driveRequests` must point to the requests folder
- Worker polls for `.json` files with `IGNORE_EXTS` exclusion — file extension must be `.json`
- File must be stable (not still being written) — worker waits `stableFileCheckSeconds` (5s)

### 5. Job picked up but crashes
Check log at `C:\Trend Vault Program\logs\sync-worker-<date>.log`. Log messages explain each failure:
- `[FAILED]` → error during job processing — stack trace in log
- TTS timeout → Edge TTS unreachable from home computer
- Render crash → check `trend-vault-render.ts` was installed on home computer

### 6. Output not in Drive/final
If `[COMPLETE]` logged but file not in Drive:
- Check `PATHS.driveFinal` path: `C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\final\`
- Worker copies file with `fs.copyFileSync` — check disk space on Drive
- Google Drive client must sync the local file to cloud — wait 1–2 minutes after the copy

### 7. Logs not appearing
Logs go to both `C:\Trend Vault Program\logs\` and `Drive/logs/`. If Drive logs missing, Drive write failed (check permissions). Local logs always work.

## Config reference
```json
{
  "homeLocalRoot": "C:\\Trend Vault Program",
  "googleDriveRoot": "C:\\Users\\Anton\\Google Drive\\My Drive\\Trend Vault Program Sync",
  "pollIntervalSeconds": 10,
  "stableFileCheckSeconds": 5
}
```
`projectRoot` is intentionally ABSENT — auto-resolved from `__dirname`.
