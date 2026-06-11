#!/usr/bin/env bash
# OpenClip local setup (macOS / Linux) — no Docker.
# Creates the backend virtualenv, installs dependencies, and initializes the DB.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "OpenClip local setup"

PY=""
for cand in python3.12 python3.11 python3.10 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.10-3.12 is required. https://www.python.org/downloads/" >&2
  exit 1
fi

"$PY" launch.py setup
echo
echo "Done. Start everything with:  $PY launch.py up"
