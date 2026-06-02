#!/usr/bin/env bash
# install-metrics-proxies.sh — expose already-running container metrics endpoints
# on the host's WireGuard IP via tiny socat sidecars, so Prometheus (on
# hara-stateless-2) can scrape them over the mesh. NO Besu/HAProxy restart — the
# besu/haproxy processes already serve metrics on the docker bridge; we just
# bridge wg0:<port> -> <container>:<port>.
#
# Role-aware (hostname): hara-v1..v4 → validator besu :9545; hara-rpc-1 → rpc
# write/read besu + HAProxy stats/metrics. Idempotent (recreates the sidecars).
#
#   sudo ./deploy/ops/install-metrics-proxies.sh        # auto-detect role
#
# Bind is the host's wg0 IP, so the ports are mesh-only (not public). Image:
# alpine/socat (Docker Hub).

set -euo pipefail

WG="$(ip -o -4 addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
[ -n "$WG" ] || { echo "✗ no wg0 IP found"; exit 1; }
HOST="$(hostname -s)"
NET="${HARA_NET:-hara-platform}"

# proxy <name> <host_port> <target_container> <target_port>
proxy() {
  local name="$1" port="$2" target="$3" tport="$4"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped \
    --network "$NET" -p "${WG}:${port}:${port}" \
    alpine/socat "TCP-LISTEN:${port},fork,reuseaddr" "TCP:${target}:${tport}" >/dev/null
  echo "✓ $name : ${WG}:${port} -> ${target}:${tport}"
}

case "$HOST" in
  hara-v[1-9]*)
    C="$(docker ps --format '{{.Names}}' | grep -m1 '^hara-validator' || true)"
    [ -n "$C" ] || { echo "✗ no hara-validator* container"; exit 1; }
    proxy hara-metrics-proxy 9545 "$C" 9545
    ;;
  hara-rpc-1)
    proxy hara-metrics-proxy-write   9545 hara-rpc-write  9545
    proxy hara-metrics-proxy-read1   9546 hara-rpc-read-1 9545
    proxy hara-metrics-proxy-read2   9547 hara-rpc-read-2 9545
    proxy hara-metrics-proxy-haproxy 8404 hara-lb         8404
    ;;
  *)
    echo "✗ no metrics-proxy mapping for host '$HOST' (expected hara-v1..4 or hara-rpc-1)"; exit 1 ;;
esac

echo
echo "Prometheus (hara-stateless-2) scrapes these at:"
echo "  validators 10.43.0.11-14:9545 · rpc 10.43.0.21:9545/9546/9547 · haproxy 10.43.0.21:8404"
echo "Ports bind to wg0 only (mesh-scoped). Verify: curl http://${WG}:9545/metrics | head"
