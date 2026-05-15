#!/usr/bin/env bash
# Clip Factory — Mac / Linux launcher
# Usage: bash start.sh   (or: chmod +x start.sh && ./start.sh)

cd "$(dirname "$0")"

echo ""
echo "  ============================================="
echo "    Clip Factory - Starting up..."
echo "  ============================================="
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed (need v18+)."
  echo "  Download from: https://nodejs.org"
  echo ""
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
echo "  Node.js $NODE_VER detected."

# ── Check .env ────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo ""
  echo "  ERROR: .env file not found."
  echo "  Copy .env.example to .env and fill in your API keys."
  echo ""
  exit 1
fi

# ── Kill any leftover process on port 3001 ────────────────────────────────────
echo "  Checking if port 3001 is free..."
OLD_PID=$(lsof -ti tcp:3001 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "  Found old process (PID $OLD_PID) on port 3001 — stopping it..."
  kill -9 "$OLD_PID" 2>/dev/null
  sleep 1
fi

# ── Install / verify dependencies ─────────────────────────────────────────────
echo "  Checking dependencies..."
npm install --silent
if [ $? -ne 0 ]; then
  echo ""
  echo "  ERROR: npm install failed. Check your internet connection."
  exit 1
fi
echo "  Dependencies OK."
echo ""

# ── Open browser after a short delay ──────────────────────────────────────────
(sleep 3 && (open http://localhost:3001 2>/dev/null || xdg-open http://localhost:3001 2>/dev/null)) &

# ── Start the server ──────────────────────────────────────────────────────────
echo "  Server starting at http://localhost:3001"
echo "  Leave this window open while processing."
echo "  Press Ctrl+C to stop Clip Factory."
echo ""
npx tsx server.ts
