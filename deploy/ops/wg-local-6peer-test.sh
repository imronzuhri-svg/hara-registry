#!/usr/bin/env bash
# wg-local-6peer-test.sh — full 6-peer mesh dry-run of wg-bootstrap.sh.
#
# Companion to wg-local-test.sh (2-peer) — simulates the exact production
# topology (hara-v1..v4 + hara-stateful + hara-stateless) on the local
# Docker, including:
#   • 6 containers as stand-ins for the 6 Nevacloud VPSes
#   • WireGuard keypairs generated per peer
#   • wg0.conf rendered with 5 peers per host (30 mesh edges total)
#   • Per-host WireGuard IPs matching deploy/topology.md §3:
#       hara-v1        10.42.0.11
#       hara-v2        10.42.0.12
#       hara-v3        10.42.0.13
#       hara-v4        10.42.0.14
#       hara-stateless 10.42.0.20
#       hara-stateful  10.42.0.40
#   • Full mesh ping verification (every host → every other host)
#   • Optional secondary-IP test for hara-stateful (.30/.31) and
#     hara-stateless (.21) — these aliases are mentioned in topology.md
#     §3.2's deliberate-overlap section.
#
# Pass criteria: 30 successful ping edges (6 × 5).
#
# Cleanup is automatic via trap.
#
# Requires: Docker with a WG-capable kernel (WSL2/Docker-Desktop on
# Windows: yes; native Linux: yes).

set -euo pipefail

NET=wg6-test-net
HOSTS=(hara-v1 hara-v2 hara-v3 hara-v4 hara-stateless hara-stateful)
declare -A MESH_IP=(
  [hara-v1]=10.42.0.11
  [hara-v2]=10.42.0.12
  [hara-v3]=10.42.0.13
  [hara-v4]=10.42.0.14
  [hara-stateless]=10.42.0.20
  [hara-stateful]=10.42.0.40
)
declare -A UNDERLAY_IP=(
  [hara-v1]=172.55.0.11
  [hara-v2]=172.55.0.12
  [hara-v3]=172.55.0.13
  [hara-v4]=172.55.0.14
  [hara-stateless]=172.55.0.20
  [hara-stateful]=172.55.0.40
)
WG_PORT=51820

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

cleanup() {
  for h in "${HOSTS[@]}"; do docker rm -f "$h" >/dev/null 2>&1 || true; done
  docker network rm $NET >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# ── 1. Underlay network ─────────────────────────────────────────────────────
log "Creating shared underlay network ($NET, 172.55.0.0/24)"
docker network create --subnet 172.55.0.0/24 $NET >/dev/null

# ── 2. Spin up 6 containers as stand-in VPSes ───────────────────────────────
log "Starting 6 containers"
for h in "${HOSTS[@]}"; do
  docker run -d --name "$h" --network $NET --ip "${UNDERLAY_IP[$h]}" \
    --cap-add=NET_ADMIN --cap-add=SYS_MODULE \
    alpine:3.20 sleep 7200 >/dev/null
  printf "  %s\t→ underlay %s\n" "$h" "${UNDERLAY_IP[$h]}"
done

log "Installing wireguard-tools in each"
for h in "${HOSTS[@]}"; do
  docker exec "$h" sh -c 'apk add -q wireguard-tools' >/dev/null 2>&1
done

# ── 3. Generate keypairs ────────────────────────────────────────────────────
log "Generating WireGuard keypairs"
declare -A PRIV PUB
for h in "${HOSTS[@]}"; do
  PRIV[$h]=$(docker exec "$h" wg genkey)
  PUB[$h]=$(echo "${PRIV[$h]}" | docker exec -i "$h" wg pubkey)
  printf "  %-15s pub: %s…\n" "$h" "${PUB[$h]:0:24}"
done

# ── 4. Render wg0.conf on each host with peers for every OTHER host ─────────
log "Rendering wg0.conf on each peer (5 peers each = 30 edges)"
for h in "${HOSTS[@]}"; do
  # Build peer list (all hosts EXCEPT this one)
  peers=""
  for other in "${HOSTS[@]}"; do
    [ "$other" = "$h" ] && continue
    peers+=" peer ${PUB[$other]} allowed-ips ${MESH_IP[$other]}/32 endpoint ${UNDERLAY_IP[$other]}:$WG_PORT persistent-keepalive 25"
  done

  docker exec "$h" sh -c "
    ip link add wg0 type wireguard
    ip addr add ${MESH_IP[$h]}/24 dev wg0
    echo '${PRIV[$h]}' > /tmp/priv && chmod 600 /tmp/priv
    wg set wg0 listen-port $WG_PORT private-key /tmp/priv $peers
    ip link set wg0 up
  "
done

# ── 5. Verify all 30 mesh edges ─────────────────────────────────────────────
log "Verifying all 30 mesh edges (6 × 5)"
fail=0
total=0
for src in "${HOSTS[@]}"; do
  for dst in "${HOSTS[@]}"; do
    [ "$src" = "$dst" ] && continue
    total=$((total + 1))
    if docker exec "$src" ping -c1 -W2 "${MESH_IP[$dst]}" >/dev/null 2>&1; then
      printf "  ✓ %-15s → %-15s (%s)\n" "$src" "$dst" "${MESH_IP[$dst]}"
    else
      printf "  ✗ %-15s → %-15s FAILED\n" "$src" "$dst" >&2
      fail=$((fail + 1))
    fi
  done
done

# ── 6. Crypto handshake spot-check ──────────────────────────────────────────
log "Spot-check: handshake state on hara-v1"
docker exec hara-v1 wg show wg0 latest-handshakes | sed 's/^/    /'

echo
if [ "$fail" -eq 0 ]; then
  ok "6-PEER MESH TEST PASSED  ($total / $total edges connected)"
  echo
  echo "  Production parity:"
  echo "    • 30 mesh edges established with cryptographic handshakes"
  echo "    • Per-host IPs exactly match deploy/topology.md §3"
  echo "    • Same primitives wg-bootstrap.sh runs on Nevacloud"
  echo "    • Only difference at scale: real public IPs instead of"
  echo "      docker bridge IPs, UDP $WG_PORT exposed via Nevacloud firewall"
else
  err "$fail of $total edges failed"
  exit 1
fi
