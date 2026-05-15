# Google Drive Sync Debugging Reference

Use this file when the error involves any of these:
- Jobs staying at `pending` forever (worker not picking them up)
- Files not appearing in Google Drive after a render
- "Drive folder not accessible" warnings in the worker log
- The worker cannot find the `requests/` or `final/` folders
- Files uploaded to Drive `uploads/` not being found by the worker
- `sync.config.json` path problems

---

## Table of Contents

1. Understanding the Drive Bridge
2. Job Stuck at Pending
3. Output Not Appearing in Drive Final
4. Source File Not Found in Drive Uploads
5. Drive Folder Path Problems
6. Google Drive App Issues
7. Log File Locations

---

## 1. Understanding the Drive Bridge

The Trend Vault Program uses Google Drive **only as a mailbox** — it never processes
files inside Drive. Here is what actually happens:

```
LAPTOP                        GOOGLE DRIVE                  HOME COMPUTER
──────                        ────────────                  ─────────────
Drop job.json  ──────────→   requests/job.json  ──────────→ Worker reads it
               (Drive syncs)                    (Drive syncs)
                                                             Copies files to
                                                             C:\Trend Vault Program\
                                                             Runs the pipeline
               ←──────────   final/output.mp4  ←──────────  Puts result back
(Drive syncs)
You see the file
```

If anything in this chain breaks, jobs will appear stuck.

---

## 2. Job Stuck at Pending

This is the most common issue. The job JSON is in Drive `requests/` with
`"status": "pending"` but nothing is happening.

### Checklist — work through these in order

**A. Is the worker running on the home computer?**
Look for a terminal window running `npm run sync:worker`.
If there is none, open a terminal in the project folder and run:
```bash
npm run sync:worker
```
Leave that window open. The worker must be running continuously.

**B. Is the Drive desktop app synced on the home computer?**
Look at the Google Drive icon in the system tray (bottom-right of taskbar).
- Spinning icon = still syncing — wait for it to stop
- Check icon = synced — good
- Error icon = Drive has an error — click it and sign in again if needed

**C. Is `googleDriveRoot` correct in `sync.config.json`?**
```bash
# Open the file and check the path
type "C:\Users\Anton\Desktop\Trend Vault Program\sync.config.json"
```
The `googleDriveRoot` must exactly match where Google Drive is on the home
computer. Common paths:
```
C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync
G:\My Drive\Trend Vault Program Sync
```
To find your actual Drive path: open the Google Drive app → gear icon →
Preferences → look for "Google Drive folder location".

**D. Does the `requests/` subfolder exist?**
```bash
dir "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\requests"
```
If that folder does not exist, run:
```bash
npm run setup:sync
```

**E. Is the job JSON valid?**
```bash
node -e "JSON.parse(require('fs').readFileSync('path/to/job.json','utf8')); console.log('valid')"
```
Invalid JSON is silently skipped by the worker.

**F. Is the job status actually `pending`?**
Open the job JSON and confirm `"status": "pending"`. If it says `"processing"`,
the worker already started it. See the "Job stuck at processing" section below.

---

## 3. Job Stuck at Processing (Worker Crashed Mid-Job)

The worker crashed after marking the job `processing`, so it will not pick it
up again.

**How to reset:**
1. Open `Google Drive → Trend Vault Program Sync → requests → your-job.json`
2. Edit the file:
   - Change `"status": "processing"` → `"status": "pending"`
   - Delete the `"startedAt"` line
   - Delete any `"error"` or `"failedAt"` lines
3. Save the file
4. Google Drive will sync it to the home computer within a few seconds
5. The worker will pick it up on the next 10-second poll

---

## 4. Output Not Appearing in Drive Final

The job shows `"status": "complete"` but there is no file in Drive `final/`.

### Step A — Check local final first
```bash
dir "C:\Trend Vault Program\final"
```
If the file IS in local final but NOT in Drive final, Google Drive is still
uploading it. Wait 1–2 minutes and check again. Large video files take time
to upload.

### Step B — Check if safeCopy ran
Look at the worker log:
```bash
dir "C:\Trend Vault Program\logs"
type "C:\Trend Vault Program\logs\sync-worker-2026-05-11.log"
```
Search for `[COPY]` lines near the job ID. You should see:
```
[COPY] scorpio-001_Scorpio.mp4 → C:\Users\Anton\Google Drive\...\final\scorpio-001_Scorpio.mp4
```
If that line is missing, the copy step was skipped (maybe the file was
the same size as an existing one — the worker skips identical files).

### Step C — Check Drive write permissions
```bash
# Try writing a test file to Drive final
echo test > "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\final\write-test.txt"
```
If that fails, Drive is read-only or not mounted. Restart the Google Drive app.

---

## 5. Source File Not Found in Drive Uploads (Clip Jobs)

Error: `Source not in Drive uploads: my-video.mp4`

**Cause:** The `inputFile` field in the job JSON does not exactly match the
filename in the Drive `uploads/` folder.

**How to check:**
```bash
dir "C:\Users\Anton\Google Drive\My Drive\Trend Vault Program Sync\uploads"
```

Check for:
- Case mismatch (`My-Video.mp4` vs `my-video.mp4`)
- Space in the filename
- The file is still uploading (Drive icon is spinning)

**The worker waits up to 60 seconds** for a file to stabilise (stop changing
size). If the file is very large, start the upload before dropping the job JSON.

---

## 6. Drive Folder Path Problems

### The most reliable way to find your Drive path on Windows

1. Open File Explorer
2. Look in the left sidebar for "Google Drive" or "My Drive"
3. Right-click → Properties → Location — this shows the exact path
4. OR: Open the Google Drive app → gear → Preferences → scroll to "Google Drive
   folder location"

### If Drive is mounted as a virtual drive (G: or H:)
Some Google Drive setups use a virtual disk letter. In that case your path
might be:
```
G:\My Drive\Trend Vault Program Sync
```
Update `sync.config.json` → `googleDriveRoot` to match.

### Testing the path quickly
```bash
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('sync.config.json','utf8'));
console.log('Drive root exists:', fs.existsSync(cfg.googleDriveRoot));
console.log('requests/ exists:', fs.existsSync(require('path').join(cfg.googleDriveRoot,'requests')));
"
```
Run this from `C:\Users\Anton\Desktop\Trend Vault Program`.

---

## 7. Log File Locations

The worker writes logs to two places:

| Location | Contains |
|----------|---------|
| `C:\Trend Vault Program\logs\sync-worker-YYYY-MM-DD.log` | Full detailed log |
| `Google Drive\...\logs\sync-worker-YYYY-MM-DD.log` | Same log, mirrored to Drive |

To read the latest log:
```bash
# Most recent log file
dir "C:\Trend Vault Program\logs" /od

# Tail the log (PowerShell)
Get-Content "C:\Trend Vault Program\logs\sync-worker-2026-05-11.log" -Wait
```

The `-Wait` flag makes it live-update as new lines are added — useful for
watching a job as it runs.
