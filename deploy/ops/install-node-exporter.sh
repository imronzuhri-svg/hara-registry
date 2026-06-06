#!/usr/bin/env bash
# install-node-exporter.sh — deploy Prometheus node_exporter on a host, bound to
# its WireGuard mesh IP so the obs-host Prometheus can scrape host OS metrics
# (disk / CPU / RAM / inodes) over the mesh.
#
# This is the host-resource layer that was MISSING when hara-rpc-1 silently filled
# to 82% (see doc/technical/devops-and-infrastructure.md R-01). Run on EACH host.
#
# Usage (on the host):   sudo ./install-node-exporter.sh
#   or remotely:         ssh <host> 'sudo bash -s' < install-node-exporter.sh
#
# It binds to the host's wg0 IP only (not 0.0.0.0) and opens 9100 to the mesh in
# ufw. Idempotent — safe to re-run (recreates the container).

set -euo pipefail

IMAGE="${NODE_EXPORTER_IMAGE:-quay.io/prometheus/node-exporter:v1.8.2}"
NAME="${NODE_EXPORTER_NAME:-hara-node-exporter}"
PORT="${NODE_EXPORTER_PORT:-9100}"
MESH_CIDR="${MESH_CIDR:-10.43.0.0/24}"

WG_IP="${WG_IP:-$(ip -4 -o addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)}"
[ -n "$WG_IP" ] || { echo "✗ could not determine wg0 IP (set WG_IP=…)"; exit 1; }
echo "▶ node_exporter on $(hostname) → bind ${WG_IP}:${PORT}"

docker pull "$IMAGE" >/dev/null 2>&1 || { echo "  (quay pull failed, falling back to Docker Hub)"; IMAGE="prom/node-exporter:v1.8.2"; docker pull "$IMAGE" >/dev/null; }
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --net host --pid host \
  -v /:/host:ro,rslave \
  "$IMAGE" \
  --path.rootfs=/host \
  --web.listen-address="${WG_IP}:${PORT}" >/dev/null

# Allow the mesh to reach this exporter (host firewall; Docker --net host bypasses
# Docker's own port publishing, so ufw is the gate).
if command -v ufw >/dev/null 2>&1; then
  ufw allow from "$MESH_CIDR" to any port "$PORT" proto tcp comment 'node_exporter mesh' >/dev/null 2>&1 || true
fi

sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://${WG_IP}:${PORT}/metrics" || echo 000)
echo "  node_exporter HTTP ${code} on ${WG_IP}:${PORT}"
[ "$code" = "200" ] || { echo "✗ exporter not responding"; exit 1; }
echo "✓ done. Add ${WG_IP}:${PORT} to Prometheus job 'node' (deploy/platform/prometheus/prometheus.yml)."
