#!/usr/bin/env bash
# install-console-agent.sh — install the read-only backups-status agent as a
# systemd service on a host that runs hara-*-snapshot timers (hara-stateful +
# validators). The Strata Console API aggregates each host's agent over the WG
# mesh (BACKUPS_AGENT_URLS). Idempotent.
#
# Run with sudo ON the host:
#   sudo ./deploy/ops/install-console-agent.sh
#
# Env:
#   REPO          repo checkout (auto-detected if unset)
#   AGENT_PORT    default 8911
#   AGENT_BIND    default = this host's wg0 IP if present, else 0.0.0.0
#   RUN_USER      default hara (can read systemctl timers/show without root)

set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "✗ run with sudo (writes /etc/systemd/system)"; exit 1; }

if [ -z "${REPO:-}" ]; then
  for c in /opt/hara-registry /opt/hara/hara-registry /opt/hara/hara-ledger; do
    [ -d "$c/console/agent" ] && { REPO="$c"; break; }
  done
fi
: "${REPO:?could not locate repo (need console/agent) — set REPO=/path/to/hara-registry}"
AGENT_DIR="$REPO/console/agent"
[ -d "$AGENT_DIR" ] || { echo "✗ $AGENT_DIR not found"; exit 1; }

RUN_USER="${RUN_USER:-hara}"
AGENT_PORT="${AGENT_PORT:-8911}"
if [ -z "${AGENT_BIND:-}" ]; then
  AGENT_BIND="$(ip -o -4 addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
  AGENT_BIND="${AGENT_BIND:-0.0.0.0}"
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "✗ node not installed on this host. Install Node (the agent is dependency-free and runs on any Node >= 18), e.g.: sudo apt-get install -y nodejs"; exit 1; }
echo "▶ Using node: $NODE_BIN ($($NODE_BIN --version))"
# The agent is dependency-free (plain node:http) — no install step needed.

echo "▶ Writing hara-console-agent.service (bind ${AGENT_BIND}:${AGENT_PORT}, user ${RUN_USER})"
cat > /etc/systemd/system/hara-console-agent.service <<EOF
[Unit]
Description=Strata Console backups-status agent (read-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$AGENT_DIR
Environment=AGENT_PORT=$AGENT_PORT
Environment=AGENT_BIND=$AGENT_BIND
ExecStart=$NODE_BIN src/index.mjs
Restart=on-failure
RestartSec=5
# read-only service; minimal hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now hara-console-agent.service
echo "✓ hara-console-agent.service enabled"
echo
echo "⚠ ufw: allow ${AGENT_PORT}/tcp ONLY from WG mesh peers (10.43.0.0/24), e.g.:"
echo "    sudo ufw allow from 10.43.0.0/24 to any port ${AGENT_PORT} proto tcp"
echo
echo "Verify:  curl -s http://${AGENT_BIND}:${AGENT_PORT}/backups | head"
