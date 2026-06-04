#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install-node.sh  —  Install Node.js 20 LTS via nvm
#
# Run once, then restart your shell (or source ~/.bashrc):
#     bash scripts/install-node.sh
#     source ~/.bashrc          # make node/npm/npx available NOW
#
# Why nvm instead of apt?
#   apt often ships Node 12 or 16 which is too old for this project.
#   nvm always gives you the current LTS and avoids sudo.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NODE_VERSION="20"        # LTS major version to install
NVM_VERSION="v0.40.1"   # nvm release to bootstrap with

echo "═══════════════════════════════════════════════"
echo "  Node.js $NODE_VERSION LTS installer (via nvm)"
echo "═══════════════════════════════════════════════"

# ── If node is already present and new enough, bail out ─────────────────────
if command -v node &>/dev/null; then
    CURRENT=$(node --version)
    MAJOR=$(node --version | tr -d 'v' | cut -d. -f1)
    if [[ "$MAJOR" -ge "$NODE_VERSION" ]]; then
        echo "Node.js $CURRENT is already installed and meets the requirement (>= $NODE_VERSION)."
        echo "If the launcher still can't find it, see the PATH note at the bottom."
        exit 0
    else
        echo "Node.js $CURRENT found, but this project needs >= $NODE_VERSION — upgrading..."
    fi
fi

# ── Install / upgrade nvm ────────────────────────────────────────────────────
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    echo "nvm already installed at $NVM_DIR — skipping download"
else
    echo "Downloading nvm $NVM_VERSION..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
fi

# ── Load nvm in this shell session ──────────────────────────────────────────
export NVM_DIR="$NVM_DIR"
# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"

# ── Install Node.js ──────────────────────────────────────────────────────────
echo "Installing Node.js $NODE_VERSION LTS..."
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
nvm alias default "$NODE_VERSION"

# ── Verify ───────────────────────────────────────────────────────────────────
echo ""
echo "Installed:"
echo "  node  $(node --version)"
echo "  npm   $(npm --version)"
echo "  npx   $(npx --version)"

# ── Remind the user to reload their shell ────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Node.js is installed!"
echo ""
echo "  IMPORTANT: to use node/npm/npx in your current"
echo "  terminal you must reload your shell config:"
echo ""
echo "    source ~/.bashrc        # bash"
echo "    source ~/.zshrc         # zsh"
echo ""
echo "  OR just open a new terminal."
echo ""
echo "  Then re-run the launcher:"
echo "    python3 launcher-linux.py"
echo "═══════════════════════════════════════════════"

# ── Ensure nvm init is in shell rc files ────────────────────────────────────
# (nvm's install.sh does this, but just in case it was skipped)
for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$RC" ]] && ! grep -q 'NVM_DIR' "$RC"; then
        echo "" >> "$RC"
        echo '# nvm — added by install-node.sh' >> "$RC"
        echo 'export NVM_DIR="$HOME/.nvm"' >> "$RC"
        echo '[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"' >> "$RC"
        echo '[ -s "$NVM_DIR/bash_completion" ] && source "$NVM_DIR/bash_completion"' >> "$RC"
        echo "  Added nvm init to $RC"
    fi
done
