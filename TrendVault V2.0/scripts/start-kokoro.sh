#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start-kokoro.sh  —  Start the Kokoro TTS server using the project venv
#
# Called automatically by launcher-linux.py when the venv doesn't exist
# (as a fallback). Can also be run directly:
#     bash scripts/start-kokoro.sh
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PY="$ROOT/kokoro-tts/.venv/bin/python"
KOKORO_SCRIPT="$ROOT/kokoro-tts/kokoro_server.py"

if [[ ! -f "$VENV_PY" ]]; then
    echo "ERROR: Kokoro venv not found at $ROOT/kokoro-tts/.venv/"
    echo "Run setup first:  bash scripts/setup-kokoro.sh"
    exit 1
fi

if [[ ! -f "$ROOT/kokoro-tts/kokoro-v0_19.onnx" ]]; then
    echo "ERROR: Model file not found: $ROOT/kokoro-tts/kokoro-v0_19.onnx"
    echo "Re-run:  bash scripts/setup-kokoro.sh"
    exit 1
fi

exec "$VENV_PY" "$KOKORO_SCRIPT" "$@"
