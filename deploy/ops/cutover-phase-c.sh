#!/usr/bin/env bash
# Phase C cutover — RPC host migration. Run from the operator laptop (uses ssh
# aliases hara-stateless / hara-stateless-2). Staged so the DNS flip (manual,
# GoDaddy) happens between `stop-old` and `start-new-caddy`.
#
# Usage (run stages in order, with the DNS flip between stage 2 and 3):
#   cutover-phase-c.sh handoff          # stop old writers+services, start new ones on .25
#   cutover-phase-c.sh stop-old-caddy   # release the public domains from the old host
#   --- now flip the 3 A-records -> 103.169.206.239 at GoDaddy, wait for propagation ---
#   cutover-phase-c.sh start-new-caddy  # bring up Caddy on .25 (re-issues LE certs)
#   cutover-phase-c.sh verify           # public endpoint + indexing checks
#   cutover-phase-c.sh rollback         # ABORT: restart old services+caddy (revert DNS yourself)
set -euo pipefail

OLD=hara-stateless
NEW=hara-stateless-2
NEW_PUB_IP=103.169.206.239
REPO=/opt/hara/hara-registry
SVC="docker compose -f deploy/services/docker-compose.yml --env-file deploy/services/.env"
EDGE="docker compose -f deploy/edge/docker-compose.yml"

# Writers/services that must NOT run on both hosts at once (shared Postgres/Redis/chain).
OLD_SERVICES=(hara-indexer hara-anchor-worker hara-blockscout hara-blockscout-fe hara-signer hara-broadcaster hara-rpc-cache)
# NEW services to start (rpc-cache already up; skip migrate + blockscout-db-init — DB already initialised).
NEW_SERVICES=(signer broadcaster indexer anchor-worker blockscout blockscout-fe)

case "${1:-}" in
  handoff)
    echo "▶ Stopping shared-state services on OLD ($OLD)…"
    ssh "$OLD" "docker stop ${OLD_SERVICES[*]}"
    echo "▶ Starting services on NEW ($NEW)…"
    ssh "$NEW" "cd $REPO && $SVC up -d ${NEW_SERVICES[*]}"
    echo "▶ NEW services status:"
    ssh "$NEW" "docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'indexer|anchor|blockscout|signer|broadcaster|rpc-cache'"
    echo "✓ handoff done. Watch indexer resume from cursor, then run: stop-old-caddy"
    ;;

  stop-old-caddy)
    echo "▶ Stopping Caddy on OLD ($OLD) — releases public domains…"
    ssh "$OLD" "docker stop hara-caddy"
    echo "✓ Old Caddy stopped. NOW flip the 3 A-records -> $NEW_PUB_IP at GoDaddy."
    echo "  Then wait for propagation and run: start-new-caddy"
    ;;

  start-new-caddy)
    echo "▶ Checking DNS resolves to $NEW_PUB_IP before starting Caddy (avoids LE rate-limit)…"
    got=$(getent hosts rpc.ledger.haratrust.io | awk '{print $1}' | head -1 || true)
    echo "  rpc.ledger.haratrust.io -> ${got:-<none>}"
    if [ "$got" != "$NEW_PUB_IP" ]; then
      echo "✗ DNS not yet pointing at $NEW_PUB_IP. Wait for propagation, re-run start-new-caddy."
      exit 1
    fi
    ssh "$NEW" "cd $REPO && $EDGE up -d"
    echo "✓ New Caddy up. ACME will (re)issue certs. Run: verify"
    ;;

  verify)
    echo "▶ Public endpoints:"
    for ep in "write/ https://rpc.ledger.haratrust.io/write/" "read/ https://rpc.ledger.haratrust.io/read/"; do
      url=${ep#* }
      printf "  %-8s " "${ep%% *}"
      curl -sS -m 12 -X POST "$url" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' || echo FAIL
      echo
    done
    printf "  explorer "; curl -sI -m 12 https://explorer.ledger.haratrust.io | head -1 || echo FAIL
    printf "  grafana  "; curl -sI -m 12 https://grafana.platform.haratrust.io | head -1 || echo FAIL
    echo "▶ NEW indexer tailing:"
    ssh "$NEW" "docker logs hara-indexer --tail 6 2>&1 | tail -6"
    ;;

  rollback)
    echo "▶ ROLLBACK — restarting services + Caddy on OLD ($OLD)…"
    ssh "$OLD" "docker start ${OLD_SERVICES[*]} hara-caddy"
    echo "▶ Stopping the NEW services to avoid double-writers…"
    ssh "$NEW" "cd $REPO && $SVC stop ${NEW_SERVICES[*]}; $EDGE down || true"
    echo "✓ Old stack restored. REVERT the DNS A-records to the old host IP (202.155.91.66) yourself."
    ;;

  *)
    echo "stages: handoff | stop-old-caddy | (flip DNS) | start-new-caddy | verify | rollback"; exit 2;;
esac
