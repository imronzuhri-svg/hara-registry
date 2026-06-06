#!/usr/bin/env bash
# Idempotent bootstrap for a bare Nevacloud Ubuntu 24.04 box — mirrors cloud-init.yaml.
# Run as root. Creates the `hara` user, installs Docker/WG/tooling, sets ufw rules
# (does NOT enable ufw — that waits until WG is up), hardens SSH LAST.
set -euo pipefail

OPS_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxywCp9uJ1ZANpmRzWpJc41oZfVoeA5Xpt7V5SKwVUV ops@haratrust'

echo "== [1/6] apt update + base packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg jq git wireguard rclone age zstd \
  prometheus-node-exporter ufw fail2ban

echo "== [1b/6] swap backstop (OOM cushion, low swappiness) =="
# The fleet runs no swap; memory-tight hosts (8GB validators, the RPC host's 3
# co-located Besu JVMs) need a cushion so a transient spike swaps instead of
# OOM-killing a container. swappiness=10 keeps it a backstop, not active paging.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 8G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=8192 status=none
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
fi
grep -q "^/swapfile[[:space:]]" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
echo "vm.swappiness=10" > /etc/sysctl.d/99-hara-swap.conf
sysctl -q vm.swappiness=10

echo "== [2/6] Docker engine + compose plugin =="
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "== [3/6] hara user (sudo + docker, ops key) =="
if ! id hara >/dev/null 2>&1; then
  useradd -m -s /bin/bash hara
fi
usermod -aG sudo,docker hara
echo 'hara ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hara
chmod 0440 /etc/sudoers.d/hara
install -d -m 0700 -o hara -g hara /home/hara/.ssh
touch /home/hara/.ssh/authorized_keys
grep -qF "$OPS_KEY" /home/hara/.ssh/authorized_keys || echo "$OPS_KEY" >> /home/hara/.ssh/authorized_keys
chown hara:hara /home/hara/.ssh/authorized_keys
chmod 0600 /home/hara/.ssh/authorized_keys

echo "== [4/6] /opt/hara owned by hara =="
mkdir -p /opt/hara
chown hara:hara /opt/hara

echo "== [5/6] ufw app profile + base rules (NOT enabling yet) =="
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
description=Grafana UI
ports=3200/tcp

[hara-p2p]
title=Chain P2P
description=Besu validator P2P
ports=30303/tcp|30303/udp

[hara-wireguard]
title=WireGuard
description=Mesh overlay
ports=51820/udp
EOF
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow hara-ssh
ufw allow hara-wireguard
# role-specific ufw rules + `ufw --force enable` happen later, after WG is verified

echo "== [6/6] enable services =="
systemctl daemon-reload
systemctl enable --now docker
systemctl enable --now prometheus-node-exporter
systemctl enable --now fail2ban

echo "BOOTSTRAP-OK $(hostname) docker=$(docker --version | awk '{print $3}' | tr -d ,) compose=$(docker compose version --short 2>/dev/null) hara=$(id hara | cut -d' ' -f1)"
