#!/usr/bin/env bash
# bootstrap-vps.sh — manual equivalent of cloud-init.yaml.
#
# Use this when the provider panel doesn't expose a user-data / cloud-init
# field (e.g. Nevacloud standard plans as of 2026-05). Run as root once on a
# freshly-provisioned Ubuntu 24.04 (or 22.04) VPS:
#
#     # On operator laptop:
#     scp deploy/ops/bootstrap-vps.sh root@<vps-public-ip>:/root/
#     ssh root@<vps-public-ip>
#     bash /root/bootstrap-vps.sh
#
# Result: identical to what cloud-init.yaml would have produced —
# Docker installed, hara user with your SSH key, UFW rules ready (not
# enabled), node_exporter + fail2ban running, repo cloned to /opt/hara/.
#
# Idempotent — safe to re-run if a step fails partway.

set -euo pipefail

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }

[ "$(id -u)" = "0" ] || { echo "✗ run as root (use sudo)"; exit 1; }

# ── 1. Packages ─────────────────────────────────────────────────────────────
log "Updating apt + installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  ca-certificates curl gnupg jq git \
  wireguard rclone age zstd \
  prometheus-node-exporter ufw fail2ban
ok "base packages installed"

# ── 2. Docker engine + Compose plugin ───────────────────────────────────────
log "Installing Docker engine + compose plugin"
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
ok "docker installed: $(docker --version)"

# ── 3. hara user with SSH key ───────────────────────────────────────────────
log "Creating hara user"
if ! id hara >/dev/null 2>&1; then
  useradd -m -s /bin/bash hara
  usermod -aG docker,sudo hara
  echo 'hara ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hara
  chmod 0440 /etc/sudoers.d/hara
fi
mkdir -p /home/hara/.ssh
chmod 700 /home/hara/.ssh
# Append the primary operator key (matches deploy/ops/cloud-init.yaml).
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxywCp9uJ1ZANpmRzWpJc41oZfVoeA5Xpt7V5SKwVUV ops@haratrust'
if ! grep -qF "$KEY" /home/hara/.ssh/authorized_keys 2>/dev/null; then
  echo "$KEY" >> /home/hara/.ssh/authorized_keys
fi
chmod 600 /home/hara/.ssh/authorized_keys
chown -R hara:hara /home/hara/.ssh
ok "hara user ready (docker, sudo NOPASSWD)"

# ── 4. UFW rules (NOT enabled — would lock you out before WG mesh exists) ──
log "Writing UFW application profiles"
cat > /etc/ufw/applications.d/hara <<'EOF'
[hara-ssh]
title=SSH
description=SSH access
ports=22/tcp

[hara-rpc]
title=Chain RPC
description=Public-facing JSON-RPC + WS
ports=8545,8546/tcp

[hara-explorer]
title=Blockscout
description=Blockscout UI
ports=4010/tcp

[hara-grafana]
title=Grafana
description=Grafana UI (behind VPN ideally)
ports=3200/tcp

[hara-p2p]
title=Chain P2P
description=Besu validator P2P
ports=30303/tcp,30303/udp

[hara-wireguard]
title=WireGuard
description=Mesh overlay
ports=51820/udp
EOF
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow hara-ssh
ufw allow hara-wireguard
warn "UFW rules staged but NOT enabled. Enable AFTER wg-bootstrap.sh succeeds:"
warn "   sudo ufw allow hara-p2p     # validators only"
warn "   sudo ufw allow hara-rpc hara-explorer hara-grafana   # hara-stateless only"
warn "   sudo ufw --force enable"

# ── 5. Repo clone (public — no deploy key needed) ───────────────────────────
log "Cloning hara-ledger repo to /opt/hara/hara-ledger"
mkdir -p /opt/hara
chown hara:hara /opt/hara
if [ ! -d /opt/hara/hara-ledger/.git ]; then
  sudo -u hara git clone https://github.com/imronzuhri-svg/hara-ledger.git \
    /opt/hara/hara-ledger
else
  sudo -u hara git -C /opt/hara/hara-ledger pull --ff-only
fi
ok "repo at /opt/hara/hara-ledger ($(sudo -u hara git -C /opt/hara/hara-ledger rev-parse --short HEAD))"

# ── 6. System services ──────────────────────────────────────────────────────
log "Enabling system services"
systemctl enable --now prometheus-node-exporter
systemctl enable --now fail2ban
ok "node_exporter + fail2ban active"

# ── 7. SSH hardening ────────────────────────────────────────────────────────
log "Hardening sshd (PermitRootLogin no, PasswordAuthentication no)"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh
ok "ssh hardened — root password login disabled"

cat <<EOF

═════════════════════════════════════════════════════════════════════
  Hara VPS bootstrap complete on $(hostname)

  • Docker:        $(docker --version | head -c 60)...
  • Repo:          /opt/hara/hara-ledger
  • Operator SSH:  ssh hara@<this-vps-public-ip>
                   (using ~/.ssh/hara_ops_ed25519)
  • UFW staged but not enabled — enable after WireGuard mesh is up.

  WARNING: this shell is currently logged in as root via password (or
  whatever Nevacloud gave you). PasswordAuthentication is now disabled
  globally; future logins MUST use the ops@haratrust SSH key.

  Next step from your operator laptop:
    ssh hara@<this-vps-public-ip> 'docker --version'
  Then proceed to nevacloud-runbook.md Step 3 (WireGuard mesh).
═════════════════════════════════════════════════════════════════════
EOF
