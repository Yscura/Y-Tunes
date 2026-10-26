#!/usr/bin/env bash
# Install YTunes as a systemd service: starts on boot, restarts if it crashes.
#
#   sudo bash scripts/install-service.sh              install, or update after moving the folder
#   sudo bash scripts/install-service.sh --uninstall  remove the service
#
# Set NODE_BIN=/path/to/node if node isn't found automatically.
set -euo pipefail

SERVICE=ytunes
UNIT_FILE="/etc/systemd/system/$SERVICE.service"

if [[ $EUID -ne 0 ]]; then
  echo "This needs root. Run: sudo bash $0 $*" >&2
  exit 1
fi

if [[ ${1:-} == "--uninstall" ]]; then
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  echo "Removed the $SERVICE service."
  exit 0
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run as whoever called sudo (they own the checkout), not as root.
RUN_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

find_node() {
  if [[ -n ${NODE_BIN:-} ]]; then echo "$NODE_BIN"; return; fi
  command -v node && return
  sudo -u "$RUN_USER" -i bash -c 'command -v node' 2>/dev/null && return
  # nvm installs aren't on PATH for non-interactive shells
  ls -d "$RUN_HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1
}
NODE_BIN="$(find_node || true)"

if [[ -z $NODE_BIN || ! -x $NODE_BIN ]]; then
  echo "Could not find node. Install Node.js 18+, or pass NODE_BIN=/path/to/node." >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and add your bot token first." >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "Missing node_modules. Run 'npm install' in $APP_DIR first (as $RUN_USER, not root)." >&2
  exit 1
fi

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=YTunes Discord music bot
Wants=network-online.target
After=network-online.target
# Never stop retrying, e.g. when booting without internet for a while.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=10
# The bot saves what's playing on SIGTERM, then resumes it on the next start.
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

echo "Installed and started the $SERVICE service."
echo "  user:   $RUN_USER"
echo "  folder: $APP_DIR"
echo "  node:   $NODE_BIN ($("$NODE_BIN" --version))"
echo
echo "Logs:    journalctl -u $SERVICE -f"
echo "Status:  systemctl status $SERVICE"
echo "Restart: sudo systemctl restart $SERVICE"
