---
name: debug-server-errors
description: Use this skill when the server crashes, returns unexpected 500 errors, or logs confusing output — to read logs, identify the root cause, and find the right file to fix. Trigger on "server crashed", "500 error", "server not responding", "express error", "unhandled rejection", "ENOENT", "cannot find module", "port already in use", "server error in console".
---

# Debug Server Errors

## Server location
```
server.ts  — main Express server (port 3001)
```
Start: `npm start` (runs `npx tsx server.ts`)

## Files involved
- `server.ts` — all API routes
- `.env` — API keys and environment variables
- `scripts/trend-vault-generate.ts` — imported at startup
- `scripts/tts/ttsService.ts` — imported at startup
- `scripts/ai-completion.ts` — imported at startup

## Common errors and fixes

### 1. Port already in use
```
Error: listen EADDRINUSE :::3001
```
Another process is using port 3001. Kill it:
```bash
# Windows:
netstat -ano | findstr :3001
taskkill /PID <pid> /F
# Or just restart:
npx kill-port 3001
```

### 2. Cannot find module
```
Error: Cannot find module './scripts/trend-vault-generate'
```
- `npm install` not run → run `npm install`
- File path wrong in import → check the import at the top of `server.ts`
- TypeScript module resolution → check `tsconfig.json`

### 3. ENOENT — file not found
```
Error: ENOENT: no such file or directory, open 'custom-presets.json'
```
Usually harmless — the server creates missing data files on first write. If it crashes instead of creating: the target directory doesn't exist. Check:
```bash
dir C:\Users\Anton\Desktop\Trend Vault Program\data
dir C:\Users\Anton\Desktop\Trend Vault Program\output
```

### 4. Unhandled promise rejection
Look for `UnhandledPromiseRejection` in stdout. The error includes the file and line. Common sources:
- `generateTrendVaultScript()` — Anthropic API call without try/catch (shouldn't happen — it has fallback)
- `generateVoice()` — TTS call
- Render subprocess (`trend-vault-render.ts`) — check its own error handling

### 5. AssemblyAI / API key errors at startup
The server imports `AssemblyAI` but doesn't instantiate it at startup — safe. If you see `ASSEMBLYAI_API_KEY` warnings, add the key to `.env` or ignore (transcription is optional).

### 6. TSX compilation errors
```
SyntaxError: ... at server.ts:XXX
```
TypeScript syntax error. Run:
```bash
npx tsc --noEmit 2>&1 | head -30
```
Fix the flagged errors before starting the server.

## Reading server logs
The server logs everything to stdout. Pattern:
```
[Trend Vault] ...     ← trend-vault-specific logs
[TTS] ...        ← voice generation logs
[Render] ...     ← render pipeline logs
[SYNC] ...       ← sync worker (separate process)
```

## Quick health check
```bash
curl -s http://localhost:3001/api/trend-vault/engine-status
# Returns: { anthropicOk, openaiOk, localTts, piperReady, ... }
# Any 500 here means server is running but an import/startup step failed
```

## Nuclear restart
```bash
# Kill everything on port 3001 and restart fresh:
npx kill-port 3001 && npm start
```
