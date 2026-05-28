#!/usr/bin/env bash
# Linux / macOS / WSL entry point for the GUI launcher.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Pick the best available Python 3 — Ubuntu only ships `python3`, never `python`.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done

if [ -z "$PY" ]; then
  echo
  echo "  Python 3 is required but was not found on PATH." >&2
  echo "  Install it from your package manager and re-run." >&2
  echo
  exit 1
fi

exec "$PY" launchers/trendvault-gui.py "$@"
