#!/usr/bin/env bash
# OpenClip launcher (macOS / Linux) — no Docker.
#
# A thin, native entry point for the cross-platform control panel in launch.py.
# It is the Linux/macOS twin of launch.ps1: run it with no arguments for the
# interactive menu, or pass any launch.py subcommand straight through.
#
#   ./launch.sh            # interactive menu
#   ./launch.sh doctor     # check prerequisites (Python / Node / FFmpeg / Ollama / ports)
#   ./launch.sh setup      # create venv, install deps, init the database
#   ./launch.sh up         # start the whole stack, wait, open the app
#   ./launch.sh status     # service + health overview
#   ./launch.sh logs api   # tail a service log (api | worker | frontend | ollama | fish)
#   ./launch.sh down       # stop everything
#
# launch.py is pure standard library, so no virtualenv is needed just to run
# this — it builds the backend venv itself on `setup`. Python discovery mirrors
# scripts/setup.sh.
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for cand in python3.12 python3.11 python3.10 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.10-3.12 is required to run OpenClip. https://www.python.org/downloads/" >&2
  exit 1
fi

# exec so Ctrl-C, signals and the exit code pass straight through to launch.py
# (the interactive menu, `up`, and `logs` all run until you stop them).
exec "$PY" launch.py "$@"
