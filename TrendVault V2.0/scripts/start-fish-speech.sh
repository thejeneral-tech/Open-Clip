#!/usr/bin/env bash
# =============================================================================
#  start-fish-speech.sh
#  Linux/macOS launcher for the Fish Speech S2 Pro TTS server.
#
#  Mirrors bats/start-fish-speech.bat:
#    1. If fish_speech_server.py exists at the project root, run it (handles
#       clone + venv + pip install + server start automatically).
#    2. Otherwise call `tools.api_server` directly from the project-local
#       venv if one exists.
#    3. Otherwise print "run setup first" and exit non-zero.
#
#  All paths are overridable via env vars:
#    FISH_S2_PRO_MODEL_PATH    Model dir (default: ~/.cache/trendvault/models/s2-pro)
#    FISH_SPEECH_RUNTIME_PATH  Where to clone fish-speech (default: ~/.local/share/trendvault/runtimes/fish-speech)
#    FISH_SPEECH_VENV_PATH     Python venv inside the runtime (default: <runtime>/.venv)
#    FISH_TTS_URL              HTTP listen URL (default: http://127.0.0.1:8080)
# =============================================================================

set -e

# Resolve project root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Source .env.all if present (mirrors the bat file's loader).
if [ -f ".env.all" ]; then
  # shellcheck disable=SC2046,SC2002
  export $(cat .env.all | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | xargs -d '\n' -I{} echo {})
fi

# Defaults — mirror fishSpeechS2Pro.ts::resolveFishConfig() on Linux.
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
FISH_SPEECH_RUNTIME_PATH="${FISH_SPEECH_RUNTIME_PATH:-$XDG_DATA_HOME/trendvault/runtimes/fish-speech}"
FISH_SPEECH_VENV_PATH="${FISH_SPEECH_VENV_PATH:-$FISH_SPEECH_RUNTIME_PATH/.venv}"
FISH_S2_PRO_MODEL_PATH="${FISH_S2_PRO_MODEL_PATH:-$HOME/.cache/trendvault/models/s2-pro}"
FISH_TTS_URL="${FISH_TTS_URL:-http://127.0.0.1:8080}"

export FISH_SPEECH_RUNTIME_PATH FISH_SPEECH_VENV_PATH FISH_S2_PRO_MODEL_PATH FISH_TTS_URL

echo
echo "[Fish Speech] Starting Fish Speech S2 Pro server"
echo "[Fish Speech] Model:   $FISH_S2_PRO_MODEL_PATH"
echo "[Fish Speech] Runtime: $FISH_SPEECH_RUNTIME_PATH"
echo "[Fish Speech] Venv:    $FISH_SPEECH_VENV_PATH"
echo "[Fish Speech] URL:     $FISH_TTS_URL"
echo

VENV_PY="$FISH_SPEECH_VENV_PATH/bin/python"
LAUNCHER="$ROOT/fish_speech_server.py"

# Strategy 1 — fish_speech_server.py (cross-platform, handles full setup).
if [ -f "$LAUNCHER" ]; then
  if [ -x "$VENV_PY" ]; then
    echo "[Fish Speech] Using venv: $VENV_PY"
    exec "$VENV_PY" "$LAUNCHER"
  fi
  # No venv yet — pick the best host Python we can find (3.11 preferred).
  HOST_PY=""
  for cand in python3.11 python3.10 python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      ver=$("$cand" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)
      if [ "$ver" = "3.10" ] || [ "$ver" = "3.11" ]; then
        HOST_PY="$cand"
        break
      fi
    fi
  done
  if [ -z "$HOST_PY" ]; then
    echo "[ERROR] No Python 3.10 or 3.11 found on PATH."
    echo "        On Debian/Ubuntu: sudo apt install python3.11 python3.11-venv"
    echo "        On Fedora:        sudo dnf install python3.11"
    echo "        On Arch:          sudo pacman -S python311"
    exit 1
  fi
  echo "[Fish Speech] Bootstrapping with host Python: $HOST_PY"
  exec "$HOST_PY" "$LAUNCHER"
fi

# Strategy 2 — Direct api_server call (needs an existing venv).
if [ ! -x "$VENV_PY" ]; then
  echo "[ERROR] fish_speech_server.py not present, and no Fish Speech venv at:"
  echo "        $FISH_SPEECH_VENV_PATH"
  echo
  echo "Press Start on the Fish Speech S2 Pro card in the launcher (which builds"
  echo "the venv automatically), or run setup-fish-speech (Windows) / build the"
  echo "venv by hand on Linux:"
  echo
  echo "    python3.11 -m venv \"$FISH_SPEECH_VENV_PATH\""
  echo "    \"$VENV_PY\" -m pip install -e fish-speech-runtime/"
  echo
  exit 1
fi

echo "[Fish Speech] Starting via tools.api_server..."
exec "$VENV_PY" -m tools.api_server \
  --listen 127.0.0.1:8080 \
  --llama-checkpoint-path "$FISH_S2_PRO_MODEL_PATH"
