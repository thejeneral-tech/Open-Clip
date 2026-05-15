---
name: start-zodiac-stack
description: Use this skill whenever the user wants to start, restart, launch, boot, or fire up the Zodiac video studio, the server, the stack, kokoro, or any combination of Node + Kokoro. Trigger on phrases like "start the server", "boot the studio", "restart everything", "kokoro is dead", "fire up zodiac", "get the stack running", or any time the user implies the studio isn't running and they want it running. Also use when the user says "doesn't seem to be running" or "the server crashed".
---

# Start the Zodiac stack

The studio is two cooperating processes:

- **Node server** — `start.bat` at the project root, port 3001 (Express + Remotion)
- **Kokoro Python TTS** — `start-kokoro.bat` at the project root, port 5070

The Node server reads `.env` ONCE at startup. So if `LOCAL_TTS_URL` was just added/changed, Node must be restarted. If only Kokoro was restarted, no Node restart is needed.

## The right startup order

1. Start Kokoro **first** so the Node server's adapter probe succeeds on boot:
   ```
   start-kokoro.bat
   ```
   Wait for: `Running on http://127.0.0.1:5070`

2. Start Node:
   ```
   start.bat
   ```
   Wait for: `Server starting at http://localhost:3001`

3. Verify both engines are reachable from Node by hitting:
   ```
   http://localhost:3001/api/zodiac/engine-status
   ```
   `localTts.ok` should be `true` and `engine` should be `kokoro`.

## When something's wrong

- **Edge TTS is still being used despite Kokoro running** → Node didn't pick up `LOCAL_TTS_URL`. Stop Node fully (close the cmd window, kill any leftover `node.exe` in Task Manager), restart it.
- **Port 3001 already in use** → `start.bat` will try to kill the previous process. If it doesn't, manually run `taskkill /IM node.exe /F`.
- **Port 5070 already in use** → kill the leftover Python: `taskkill /IM python.exe /F` (caution: kills all python processes).
- **Kokoro reports model not found** → `kokoro-v0_19.onnx` and `voices.bin` should sit next to `kokoro_server.py` inside `kokoro-tts/`. If missing, rerun `setup-kokoro.bat`.

## Quick sanity check after a clean start

Open the browser to `http://localhost:3001/zodiac`. The voice card should show a green dot next to "Local TTS: kokoro @ http://localhost:5070".

If you only need to tell the user how to start it (and shouldn't run the .bat files yourself), give them the exact commands and what success looks like.
