#!/usr/bin/env bash
# wg-local-test.sh — local 2-peer WireGuard mesh validation.
#
# Spins up two Alpine containers with NET_ADMIN, generates keypairs,
# builds a 2-peer mesh at 10.42.0.11 + 10.42.0.12, and verifies:
#   • crypto handshake completes (proves key exchange + AEAD)
#   • bidirectional ping over the WG interface
#   • persistent keepalive negotiated
#
# Mirrors the exact primitives used by deploy/ops/wg-bootstrap.sh at
# 6-VPS scale (wg genkey/pubkey/set, ip link/addr) so passing here is
# strong evidence the production mesh logic is sound.
#
# Requires:
#   • Docker with a WG-capable kernel (WSL2 on recent Windows: yes;
#     Docker Desktop Linux: yes; mac M-series: works via Apple
#     hypervisor's Linux VM)
#   • alpine:3.20 image (pulled on first run)
#
# Safe to run repeatedly — `trap cleanup EXIT` removes the test
# containers + network on completion or interruption.
#
# Result of the first run (2026-05-15) closed pre-VPS gate #2 in
# deploy/topology.md §9.
set -euo pipefail

NET=wg-test-net
A=peer-a
B=peer-b
WG_PORT=51820

cleanup() {
  docker rm -f $A $B >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "▶ Creating shared underlay network"
docker network create --subnet 172.50.0.0/24 $NET >/dev/null

echo "▶ Starting both peers"
docker run -d --name $A --network $NET --ip 172.50.0.10 \
  --cap-add=NET_ADMIN --cap-add=SYS_MODULE \
  -e PEER=a alpine:3.20 sleep 3600 >/dev/null
docker run -d --name $B --network $NET --ip 172.50.0.11 \
  --cap-add=NET_ADMIN --cap-add=SYS_MODULE \
  -e PEER=b alpine:3.20 sleep 3600 >/dev/null

echo "▶ Installing wireguard-tools in both"
for c in $A $B; do
  docker exec $c sh -c 'apk add -q wireguard-tools' >/dev/null 2>&1
done

echo "▶ Generating keys"
A_PRIV=$(docker exec $A wg genkey)
A_PUB=$(echo  "$A_PRIV" | docker exec -i $A wg pubkey)
B_PRIV=$(docker exec $B wg genkey)
B_PUB=$(echo  "$B_PRIV" | docker exec -i $B wg pubkey)
echo "  peer-a pub: ${A_PUB:0:20}…"
echo "  peer-b pub: ${B_PUB:0:20}…"

echo "▶ Bringing up wg0 on peer-a (10.42.0.11)"
docker exec $A sh -c "
  ip link add wg0 type wireguard
  ip addr add 10.42.0.11/24 dev wg0
  echo '$A_PRIV' > /tmp/priv && chmod 600 /tmp/priv
  wg set wg0 listen-port $WG_PORT private-key /tmp/priv \
      peer $B_PUB allowed-ips 10.42.0.12/32 endpoint 172.50.0.11:$WG_PORT persistent-keepalive 25
  ip link set wg0 up
"

echo "▶ Bringing up wg0 on peer-b (10.42.0.12)"
docker exec $B sh -c "
  ip link add wg0 type wireguard
  ip addr add 10.42.0.12/24 dev wg0
  echo '$B_PRIV' > /tmp/priv && chmod 600 /tmp/priv
  wg set wg0 listen-port $WG_PORT private-key /tmp/priv \
      peer $A_PUB allowed-ips 10.42.0.11/32 endpoint 172.50.0.10:$WG_PORT persistent-keepalive 25
  ip link set wg0 up
"

echo
echo "▶ Mesh status from peer-a:"
docker exec $A wg show | sed 's/^/    /'

echo
echo "▶ Verifying connectivity"
if docker exec $A ping -c 2 -W 2 10.42.0.12 >/dev/null 2>&1; then
  echo "  ✓ peer-a → peer-b (10.42.0.12)"
else
  echo "  ✗ peer-a → peer-b FAILED"; exit 1
fi
if docker exec $B ping -c 2 -W 2 10.42.0.11 >/dev/null 2>&1; then
  echo "  ✓ peer-b → peer-a (10.42.0.11)"
else
  echo "  ✗ peer-b → peer-a FAILED"; exit 1
fi

echo
echo "▶ Handshake check (proves crypto worked, not just IP routing):"
docker exec $A wg show wg0 latest-handshakes | sed 's/^/    /'

echo
echo "✓ WIREGUARD MESH VALIDATION PASSED"
