#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/trendvault-ai-ui.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: trendvault-ai-ui.service not found in $SCRIPT_DIR"
  exit 1
fi

echo "Installing TrendVault AI UI service..."
echo "Make sure you've edited trendvault-ai-ui.service with your username and paths first!"
echo ""

sudo cp "$SERVICE_FILE" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable trendvault-ai-ui
sudo systemctl start trendvault-ai-ui
sudo systemctl status trendvault-ai-ui
