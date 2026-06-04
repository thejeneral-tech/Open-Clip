#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-kokoro.sh  —  Build the Kokoro TTS Python venv
#
# Run once from the Trend Vault root (or from scripts/):
#     bash scripts/setup-kokoro.sh
#
# What it does:
#   1. Creates kokoro-tts/.venv/ with a clean Python 3 virtual environment
#   2. Installs all dependencies from kokoro-tts/requirements.txt
#      (flask, kokoro-onnx, onnxruntime, soundfile, numpy)
#   3. Verifies that the kokoro-onnx model file exists
#
# After this script succeeds, launcher-linux.py will automatically use
# kokoro-tts/.venv/bin/python to run kokoro_server.py.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Resolve project root (works when called from any directory) ──────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KOKORO_DIR="$ROOT/kokoro-tts"
VENV_DIR="$KOKORO_DIR/.venv"
REQUIREMENTS="$KOKORO_DIR/requirements.txt"
MODEL_FILE="$KOKORO_DIR/kokoro-v0_19.onnx"

echo "═══════════════════════════════════════════════"
echo "  Kokoro TTS Setup"
echo "  Root : $ROOT"
echo "  Venv : $VENV_DIR"
echo "═══════════════════════════════════════════════"

# ── Check Python 3.10+ ───────────────────────────────────────────────────────
PYTHON=$(command -v python3 || command -v python || true)
if [[ -z "$PYTHON" ]]; then
    echo "ERROR: python3 not found. Install it first:"
    echo "  sudo apt install python3          # Debian/Ubuntu"
    echo "  sudo dnf install python3          # Fedora"
    exit 1
fi

PY_VER=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON" -c "import sys; print(sys.version_info.minor)")

echo "Using Python $PY_VER at $PYTHON"

if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 10 ]]; }; then
    echo "ERROR: Python 3.10 or higher is required (found $PY_VER)"
    exit 1
fi

# ── Check python3-venv / ensurepip is available ──────────────────────────────
if ! "$PYTHON" -m ensurepip --version &>/dev/null && ! "$PYTHON" -m venv --help &>/dev/null; then
    echo "ERROR: python3-venv is not installed."
    echo "  sudo apt install python3-venv     # Debian/Ubuntu"
    echo "  sudo dnf install python3-venv     # Fedora"
    exit 1
fi

# ── Create virtual environment ───────────────────────────────────────────────
if [[ -d "$VENV_DIR" ]]; then
    echo "Existing venv found at $VENV_DIR — removing and recreating..."
    rm -rf "$VENV_DIR"
fi

echo "Creating venv..."
"$PYTHON" -m venv "$VENV_DIR"

VENV_PY="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# ── Upgrade pip inside the venv ──────────────────────────────────────────────
echo "Upgrading pip..."
"$VENV_PY" -m pip install --upgrade pip --quiet

# ── Install requirements ─────────────────────────────────────────────────────
if [[ ! -f "$REQUIREMENTS" ]]; then
    echo "ERROR: requirements.txt not found at $REQUIREMENTS"
    exit 1
fi

echo "Installing dependencies from requirements.txt..."
echo "(This may take a few minutes on first run)"
"$VENV_PIP" install -r "$REQUIREMENTS"

# ── Verify flask is importable ───────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"$VENV_PY" -c "import flask; print(f'  flask          {flask.__version__}')"
"$VENV_PY" -c "import numpy; print(f'  numpy          {numpy.__version__}')" 2>/dev/null || true
"$VENV_PY" -c "import soundfile; print(f'  soundfile      ok')" 2>/dev/null || true
"$VENV_PY" -c "import kokoro_onnx; print(f'  kokoro-onnx    ok')" 2>/dev/null || true

# ── Check for model file ─────────────────────────────────────────────────────
echo ""
if [[ -f "$MODEL_FILE" ]]; then
    SIZE=$(du -sh "$MODEL_FILE" | cut -f1)
    echo "✓ Model file found: $MODEL_FILE ($SIZE)"
else
    echo "⚠  Model file not found: $MODEL_FILE"
    echo "   The model (~330 MB) should have been included in the distribution."
    echo "   If it is missing, you can download it manually from:"
    echo "   https://github.com/thewh1teagle/kokoro-onnx/releases"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  Kokoro TTS setup complete!"
echo "  The launcher will now use:"
echo "  $VENV_PY"
echo ""
echo "  To start Kokoro manually:"
echo "  bash scripts/start-kokoro.sh"
echo "═══════════════════════════════════════════════"
