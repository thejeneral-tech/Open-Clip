#!/usr/bin/env bash
# Linux / macOS / WSL companion to claw-web.bat.
# Frees the port, opens the browser, then runs `npm run web`.

set -u

# Resolve repo root = parent of this script's directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

: "${WEB_PORT:=7878}"
URL="http://127.0.0.1:${WEB_PORT}"

echo
echo "  TrendVault Coder Web UI"
echo "  -----------------------"
echo "  URL:  $URL"
echo "  Root: $REPO_ROOT"
echo "  Press Ctrl+C in this terminal to stop the server."
echo

# 1. Make sure dependencies are present.
if [ ! -d "node_modules" ]; then
  echo "  Dependencies missing — running 'npm install'..."
  if ! npm install; then
    echo
    echo "  npm install failed. See output above." >&2
    exit 1
  fi
  echo
fi

# 2. Free the port if a previous server is still bound to it.
kill_listeners_on_port() {
  local port="$1"
  local killed=0
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      while IFS= read -r pid; do
        [ -z "$pid" ] && continue
        if kill "$pid" 2>/dev/null; then
          killed=$((killed + 1))
        fi
      done <<< "$pids"
    fi
  elif command -v fuser >/dev/null 2>&1; then
    if fuser -k "${port}/tcp" >/dev/null 2>&1; then
      killed=1
    fi
  elif command -v ss >/dev/null 2>&1; then
    # ss prints "users:(("name",pid=NNNN,fd=N))" — pull out the pids.
    local pids
    pids="$(ss -lptnH "sport = :${port}" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' \
      | cut -d= -f2 \
      | sort -u)"
    if [ -n "$pids" ]; then
      while IFS= read -r pid; do
        [ -z "$pid" ] && continue
        if kill "$pid" 2>/dev/null; then
          killed=$((killed + 1))
        fi
      done <<< "$pids"
    fi
  fi
  if [ "$killed" -gt 0 ]; then
    echo "  Stopped $killed previous listener(s) on port $port."
    sleep 0.6
  fi
}
kill_listeners_on_port "$WEB_PORT"

# 3. Open the browser. Best-effort; the server still starts if this fails.
open_browser_async() {
  local url="$1"
  (
    sleep 2
    if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
      # WSL: invoke the Windows shell to open the user's default browser.
      if command -v wslview >/dev/null 2>&1; then
        wslview "$url" >/dev/null 2>&1 && return
      fi
      if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1 && return
      fi
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$url" >/dev/null 2>&1 && return
      fi
    fi
    case "$(uname -s)" in
      Darwin)
        open "$url" >/dev/null 2>&1 && return
        ;;
      *)
        if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
          if command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$url" >/dev/null 2>&1 && return
          fi
          if command -v gio >/dev/null 2>&1; then
            gio open "$url" >/dev/null 2>&1 && return
          fi
          if command -v sensible-browser >/dev/null 2>&1; then
            sensible-browser "$url" >/dev/null 2>&1 && return
          fi
        fi
        ;;
    esac
    echo "  (could not auto-open browser — visit $url manually)" >&2
  ) &
}

if [ "${TV_NO_BROWSER:-0}" != "1" ]; then
  open_browser_async "$URL"
fi

# 4. Run the server in the foreground so Ctrl+C stops it cleanly.
WEB_PORT="$WEB_PORT" exec npm run web
