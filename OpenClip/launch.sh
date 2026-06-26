#!/usr/bin/env bash
# OpenClip launcher (macOS / Linux) — no Docker.
#
# A thin, native entry point for the cross-platform control panel in launch.py.
# It is the Linux/macOS twin of launch.ps1: run it with no arguments for the
# interactive menu, or pass any launch.py subcommand straight through.
#
#   ./launch.sh                  # interactive menu
#   ./launch.sh doctor           # check prerequisites (Python / Node / FFmpeg / Ollama / ports)
#   ./launch.sh setup            # create venv, install deps, init the database
#   ./launch.sh up               # start the whole stack, wait, open the app
#   ./launch.sh status           # service + health overview
#   ./launch.sh logs api         # tail a service log (api | worker | frontend | ollama | fish)
#   ./launch.sh down             # stop everything
#   ./launch.sh install-launcher # add a double-click desktop icon (KDE / GNOME …)
#
# launch.py is pure standard library, so no virtualenv is needed just to run
# this — it builds the backend venv itself on `setup`. Python discovery mirrors
# scripts/setup.sh.
set -euo pipefail
cd "$(dirname "$0")"

# Double-clicking from a file manager (KDE Dolphin, GNOME Files …) starts us with
# no terminal attached: launch.py's interactive menu would immediately hit EOF on
# stdin and the window would vanish in ~1s with nothing shown. When invoked with
# no arguments (menu mode) and neither stdin nor stdout is a TTY, but a desktop
# session is present, relaunch inside a terminal emulator so the menu is usable.
# OPENCLIP_IN_TERM breaks the re-exec loop (the spawned terminal has a real TTY).
# Commands like `up`/`setup` run headless, so we never intercept those — only the
# bare menu. Requiring BOTH streams non-TTY avoids hijacking `./launch.sh > log`.
if [ "$#" -eq 0 ] && [ -z "${OPENCLIP_IN_TERM:-}" ] \
   && [ ! -t 0 ] && [ ! -t 1 ] \
   && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  # Line 21 already cd'd into the script's directory, so $PWD is it.
  self="$PWD/$(basename "$0")"
  export OPENCLIP_IN_TERM=1
  hold='ec=$?; echo; read -rn1 -p "[OpenClip exited $ec] Press any key to close…"'
  if command -v konsole >/dev/null 2>&1; then
    exec konsole --separate -e bash -c "\"$self\"; $hold"
  elif command -v gnome-terminal >/dev/null 2>&1; then
    exec gnome-terminal -- bash -c "\"$self\"; $hold"
  elif command -v xterm >/dev/null 2>&1; then
    exec xterm -e bash -c "\"$self\"; $hold"
  elif command -v x-terminal-emulator >/dev/null 2>&1; then
    exec x-terminal-emulator -e bash -c "\"$self\"; $hold"
  fi
  # No terminal emulator found — fall through; launch.py prints a clear hint.
fi

PY=""
for cand in python3.12 python3.11 python3.10 python3.13 python3.14 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3 is required to run OpenClip (3.10–3.12 recommended for the full stack)." >&2
  echo "https://www.python.org/downloads/" >&2
  exit 1
fi

# exec so Ctrl-C, signals and the exit code pass straight through to launch.py
# (the interactive menu, `up`, and `logs` all run until you stop them).
exec "$PY" launch.py "$@"
