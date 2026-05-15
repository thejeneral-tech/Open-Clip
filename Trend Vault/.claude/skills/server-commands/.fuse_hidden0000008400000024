---
name: server-commands
description: Use this skill for exact commands to start, stop, restart, or check the status of any part of the Trend Vault stack — the main server, sync worker, sync test, or TypeScript checks. Trigger on "how do I start the server", "what command starts trend-vault", "restart command", "stop the server", "check if server is running", "start sync worker", "what's the command for X".
---

# Trend Vault Program — Exact Commands

## Start the studio server (laptop)
```bash
cd "C:\Users\Anton\Desktop\Trend Vault Program"
npm start
# → Opens http://localhost:3001/trend-vault
# Uses: npx tsx server.ts
```

## Check server is running
```bash
curl -s http://localhost:3001/trend-vault -o /dev/null -w "HTTP: %{http_code}\n"
# 200 = running, connection refused = not started
```

## Stop the server
```
Ctrl+C in the terminal running npm start
```
Or kill by port:
```bash
npx kill-port 3001
```

## TypeScript check (no compile, just type-check)
```bash
cd "C:\Users\Anton\Desktop\Trend Vault Program"
npx tsc --noEmit
# 0 errors = clean. Pre-existing errors in server.ts are known/harmless.
```

## Start the Drive sync worker (HOME COMPUTER only)
```bash
cd "C:\Trend Vault Program"   # home computer SSD path
node scripts/sync-worker.js
# Polls Google Drive every 10 seconds for new render jobs
```

## Test Drive sync (laptop — no home computer needed)
```bash
cd "C:\Users\Anton\Desktop\Trend Vault Program"
npm run sync:test
# Must print: TEST PASSED — 18/18 checks passed
```

## Manually trigger a render (API)
```bash
curl -X POST http://localhost:3001/api/trend-vault/render \
  -H "Content-Type: application/json" \
  -d @payload.json
```
See `trigger-render` skill for full payload format.

## Check engine/API status
```bash
curl -s http://localhost:3001/api/trend-vault/engine-status
```

## Check TTS status
```bash
curl -s http://localhost:3001/api/trend-vault/tts-status
curl -s http://localhost:3001/api/trend-vault/edge-tts-status
```

## Watch render progress (SSE stream)
```bash
curl -N http://localhost:3001/api/trend-vault/render-status/<jobId>
# Streams JSON events until done
```

## Install dependencies (first time or after pulling)
```bash
cd "C:\Users\Anton\Desktop\Trend Vault Program"
npm install
```

## Key ports
| Port | Service |
|------|---------|
| 3001 | Main Trend Vault server (Express) |
| 5050 | openai-edge-tts (optional, high quality TTS) |
| 5070 | Kokoro local TTS (optional) |
| 9001 | CapCut API server (optional) |
