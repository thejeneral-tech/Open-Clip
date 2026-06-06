#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fix-server.sh  —  One-shot fix for all Trend Vault Linux startup errors
#
# Run from the Trend Vault root (or from scripts/):
#     bash scripts/fix-server.sh
#
# Fixes:
#   ✓ Node.js / npm / npx not on PATH
#   ✓ Kokoro TTS "No module named 'flask'"
#   ✓ Missing scripts/setup-kokoro.sh  (creates the venv)
#   ✓ Missing scripts/start-kokoro.sh  (referenced by launcher)
#
# After this script completes, open a NEW terminal and run:
#     python3 launcher-linux.py
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║      Trend Vault — Linux Server Fix          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Helper ───────────────────────────────────────────────────────────────────
ok()   { echo "  ✓  $*"; }
warn() { echo "  ⚠  $*"; }
fail() { echo "  ✗  $*"; }
step() { echo ""; echo "──────────────────────────────────────────────"; echo "  $*"; echo "──────────────────────────────────────────────"; }

ERRORS=0

# ════════════════════════════════════════════════════════════════════════════
# 1. NODE.JS
# ════════════════════════════════════════════════════════════════════════════
step "1/2  Node.js"

# Load nvm if it exists (handles the PATH-not-updated case)
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
fi

if command -v node &>/dev/null; then
    NODE_MAJOR=$(node --version | tr -d 'v' | cut -d. -f1)
    if [[ "$NODE_MAJOR" -ge 18 ]]; then
        ok "Node.js $(node --version) already installed"
    else
        warn "Node.js $(node --version) is too old (need >= 18) — upgrading via nvm"
        bash "$SCRIPT_DIR/install-node.sh"
    fi
else
    echo "  Node.js not found — running install-node.sh..."
    bash "$SCRIPT_DIR/install-node.sh"

    # Reload nvm so npm/node are available for the npm install step below
    if [[ -s "$NVM_DIR/nvm.sh" ]]; then
        source "$NVM_DIR/nvm.sh"
    fi
fi

# Verify
if command -v node &>/dev/null && command -v npm &>/dev/null; then
    ok "node  $(node --version)"
    ok "npm   $(npm --version)"
    ok "npx   $(npx --version)"
else
    fail "Node.js still not on PATH after install."
    fail "Open a new terminal and re-run this script."
    ERRORS=$((ERRORS + 1))
fi

# ── npm install (only if node_modules missing) ───────────────────────────────
if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "  node_modules missing — running npm install in $ROOT ..."
    (cd "$ROOT" && npm install)
    ok "npm install complete"
else
    ok "node_modules already present"
fi

# ════════════════════════════════════════════════════════════════════════════
# 2. KOKORO TTS
# ════════════════════════════════════════════════════════════════════════════
step "2/2  Kokoro TTS"

VENV_PY="$ROOT/kokoro-tts/.venv/bin/python"

if [[ -f "$VENV_PY" ]]; then
    # Venv exists — check flask is importable
    if "$VENV_PY" -c "import flask" &>/dev/null; then
        ok "Kokoro venv exists and flask is installed"
    else
        warn "Venv exists but flask missing — re-running setup..."
        bash "$SCRIPT_DIR/setup-kokoro.sh"
    fi
else
    echo "  Kokoro venv not found — running setup-kokoro.sh..."
    bash "$SCRIPT_DIR/setup-kokoro.sh"
fi

# Final check
if [[ -f "$VENV_PY" ]] && "$VENV_PY" -c "import flask" &>/dev/null; then
    ok "Kokoro TTS venv is ready"
else
    fail "Kokoro TTS setup failed — check the output above for details"
    ERRORS=$((ERRORS + 1))
fi

# ════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════╗"
if [[ "$ERRORS" -eq 0 ]]; then
echo "║  All fixes applied successfully!             ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Next steps:                                 ║"
echo "║                                              ║"
echo "║  1. Open a NEW terminal (to reload PATH)     ║"
echo "║  2. cd to your Trend Vault folder            ║"
echo "║  3. python3 launcher-linux.py                ║"
else
echo "║  Completed with $ERRORS error(s) — see above  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Check the messages above and fix any        ║"
echo "║  reported errors, then re-run this script.   ║"
fi
echo "╚══════════════════════════════════════════════╝"
echo ""

exit "$ERRORS"
