#!/usr/bin/env bash
# validator-snapshot-restore-drill.sh — prove a validator backup actually
# restores cleanly and the chain survives the outage.
#
# Companion to snapshot-restore-drill.sh (Postgres). Together they verify
# both irreplaceable state stores: Postgres for indexed events (no self-heal)
# and validator data (validators self-heal via P2P, but the backup must
# actually round-trip).
#
# What it does:
#   1. Capture chain block + validator data size baseline.
#   2. Stop validator1 (chain keeps producing if QBFT has 3 of 4 alive).
#   3. tar /opt/besu/data via a sidecar container into a host backup dir
#      (matches what snapshot-validator.sh does, minus the rclone upload).
#   4. Wipe validator1's data volume contents.
#   5. Confirm chain kept advancing during the outage (3 of 4 quorum).
#   6. Restore from tar.
#   7. Start validator1; wait for it to rejoin.
#   8. Verify: chain advanced while down, v1 running, data preserved, chain
#      still advancing post-restore. Any failure → exit non-zero.
#
# Pre-reqs:
#   • All 4 validators currently running (drill needs 3-of-4 quorum survived).
#   • Docker reachable, alpine:3.20 pullable (or already pulled).
#
# First passing run: 2026-05-19. Closes pre-VPS gate #3b in
# deploy/topology.md §9.

set -euo pipefail

V="${VALIDATOR_CONTAINER:-hara-validator1}"
BACKUP_DIR_HOST="${BACKUP_DIR_HOST:-${TEMP:-/tmp}/hara-validator-snap-drill}"
# Docker on Windows is happier with a Windows-style mount source than /tmp.
# Build a backup path that's valid on both Linux hosts and Git-Bash-on-Windows.
mkdir -p "$BACKUP_DIR_HOST"
SNAP_NAME="${V}.tar"
SNAP_HOST="${BACKUP_DIR_HOST}/${SNAP_NAME}"
rm -f "$SNAP_HOST"

log() { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
chk() { [ "$1" = "$2" ] && echo "✓" || echo "✗ (got $1, want $2)"; }

rpc_block() {
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "${RPC_URL:-http://localhost:8545}" | grep -oE '0x[0-9a-f]+'
}

# ── 1. Baseline ──────────────────────────────────────────────────────────────
log "Baseline: chain block + validator data size"
BLOCK_BEFORE=$(rpc_block)
[ -n "$BLOCK_BEFORE" ] || { echo "✗ RPC not reachable at ${RPC_URL:-http://localhost:8545}" >&2; exit 2; }
echo "  chain block: $BLOCK_BEFORE ($(printf %d $BLOCK_BEFORE))"
SIZE_BEFORE=$(MSYS_NO_PATHCONV=1 docker exec "$V" sh -c 'du -sb /opt/besu/data | cut -f1')
echo "  validator data: $SIZE_BEFORE bytes"

# ── 2. Stop ──────────────────────────────────────────────────────────────────
log "Stop $V (3 of 4 quorum should carry the chain)"
docker stop "$V" >/dev/null

# ── 3. Snapshot ──────────────────────────────────────────────────────────────
log "tar /opt/besu/data via sidecar → $SNAP_HOST"
MSYS_NO_PATHCONV=1 docker run --rm --volumes-from "$V" \
  -v "${BACKUP_DIR_HOST}:/backup" alpine:3.20 \
  sh -c "cd /opt/besu && tar cf /backup/${SNAP_NAME} data" >/dev/null
[ -s "$SNAP_HOST" ] || { echo "✗ snapshot empty" >&2; exit 3; }
echo "  tarball: $(stat -c %s $SNAP_HOST) bytes"
echo "  sha256:  $(sha256sum $SNAP_HOST | cut -d' ' -f1 | head -c 16)…"

# ── 4. Wipe ──────────────────────────────────────────────────────────────────
log "Wipe /opt/besu/data contents (keep mount point intact)"
MSYS_NO_PATHCONV=1 docker run --rm --volumes-from "$V" alpine:3.20 \
  sh -c 'rm -rf /opt/besu/data/* /opt/besu/data/.[!.]* 2>/dev/null; ls -1A /opt/besu/data | wc -l' \
  | awk '{print "  entries after wipe: "$1}'

# ── 5. Quorum check during outage ───────────────────────────────────────────
log "Verify other 3 validators kept producing"
sleep 6
BLOCK_DURING=$(rpc_block)
echo "  chain advanced to $BLOCK_DURING"

# ── 6. Restore ───────────────────────────────────────────────────────────────
log "Restore from tar"
MSYS_NO_PATHCONV=1 docker run --rm --volumes-from "$V" \
  -v "${BACKUP_DIR_HOST}:/backup" alpine:3.20 \
  sh -c "cd /opt/besu && tar xf /backup/${SNAP_NAME}" >/dev/null

# ── 7. Restart ───────────────────────────────────────────────────────────────
log "Start $V; wait 20s for it to rejoin + catch up"
docker start "$V" >/dev/null
sleep 20

SIZE_AFTER=$(MSYS_NO_PATHCONV=1 docker exec "$V" sh -c 'du -sb /opt/besu/data | cut -f1')
STATE=$(docker inspect "$V" --format '{{.State.Status}}')
BLOCK_AFTER=$(rpc_block)
echo "  $V data after restore: $SIZE_AFTER bytes"
echo "  $V state:              $STATE"
echo "  chain after restore:   $BLOCK_AFTER"

# ── 8. Verify ────────────────────────────────────────────────────────────────
bef=$(printf '%d' $BLOCK_BEFORE)
dur=$(printf '%d' $BLOCK_DURING)
aft=$(printf '%d' $BLOCK_AFTER)

echo
echo "  (a) chain produced during outage:  $bef → $dur  $([ $dur -gt $bef ] && echo ✓ || echo ✗)"
echo "  (b) $V running post-restore:       state=$STATE  $([ "$STATE" = running ] && echo ✓ || echo ✗)"
echo "  (c) restored data non-trivial:     $SIZE_AFTER bytes  $([ $SIZE_AFTER -gt 100 ] && echo ✓ || echo ✗)"
echo "  (d) chain producing post-restore:  $dur → $aft  $([ $aft -ge $dur ] && echo ✓ || echo ✗)"

if [ $dur -gt $bef ] && [ "$STATE" = running ] && [ $SIZE_AFTER -gt 100 ] && [ $aft -ge $dur ]; then
  rm -f "$SNAP_HOST"
  echo
  echo "✓ VALIDATOR SNAPSHOT/RESTORE DRILL PASSED"
else
  echo
  echo "✗ DRILL FAILED — snapshot left at $SNAP_HOST for inspection"
  exit 1
fi
