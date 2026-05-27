#!/usr/bin/env bash
# sim-up.sh — bring up the production-shaped 6-node stack locally.
#
# The 6 logical "VPSes" are simulated as named container groups sharing the
# hara-platform Docker bridge (10.42.0.0/24) — same topology as Nevacloud,
# just on one Docker host:
#
#   hara-stateful  → vault(dev), postgres, redis, minio
#   hara-stateless → migrate, signer, broadcaster, indexer, rpc-cache,
#                    blockscout(+fe), HAProxy LB, anchor-worker (deferred),
#                    observability stack (from _platform)
#   hara-v1..v4    → 4 Besu validators
#
# Differences vs production:
#   • Vault is in -dev mode (auto-unsealed, root token). Production runs Raft.
#   • Caddy edge is skipped — services exposed directly on localhost ports.
#   • Backup scripts not cron'd.
#   • Images are built locally unless IMAGE_REGISTRY is set in .env.sim.
#
# Usage:
#   ./deploy/sim/sim-up.sh            # full bring-up in production order
#   ./deploy/sim/sim-up.sh anchor     # after deploying contracts, start anchor-worker
#
# Required: docker, docker compose, the _platform sibling dir at ../_platform.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy/sim/.env.sim"
PLATFORM_DIR="$REPO_ROOT/../_platform"

[ -f "$ENV_FILE" ] || { echo "✗ missing $ENV_FILE"; exit 1; }
[ -d "$PLATFORM_DIR" ] || { echo "✗ _platform sibling dir not found at $PLATFORM_DIR"; exit 1; }

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

compose() { docker compose --env-file "$ENV_FILE" "$@"; }

# ── Optional second-phase target: anchor-worker after contracts deploy ──────
if [ "${1:-}" = "anchor" ]; then
  log "Phase 2 — starting anchor-worker"
  echo "  Reads PQ_ANCHOR_REGISTRY_ADDRESS from $ENV_FILE"
  ADDR=$(grep ^PQ_ANCHOR_REGISTRY_ADDRESS "$ENV_FILE" | cut -d= -f2)
  if [ "$ADDR" = "0x0000000000000000000000000000000000000000" ]; then
    err "PQ_ANCHOR_REGISTRY_ADDRESS still placeholder — deploy contracts first then set it in $ENV_FILE"
    exit 1
  fi
  compose -f "$REPO_ROOT/deploy/services/docker-compose.yml" up -d anchor-worker
  ok "anchor-worker started"
  exit 0
fi

# ── 1. Shared platform (Vault dev + observability) ──────────────────────────
log "1/6 — Bringing up _platform (vault dev + prom + grafana + loki + alertmanager)"
docker compose -f "$PLATFORM_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
# Wait for vault to be healthy so secret writes work in step 4
log "    Waiting for vault to be healthy..."
for i in $(seq 1 30); do
  status=$(docker inspect hara-vault --format '{{.State.Health.Status}}' 2>/dev/null || echo none)
  [ "$status" = "healthy" ] && break
  sleep 2
done
[ "$status" = "healthy" ] || { err "vault never became healthy"; exit 1; }
ok "platform up; vault healthy"

# ── 2. Data tier (postgres + redis) ─────────────────────────────────────────
log "2/6 — Bringing up data tier (postgres + redis)"
compose -f "$REPO_ROOT/deploy/data/docker-compose.yml" up -d
log "    Waiting for postgres..."
for i in $(seq 1 30); do
  docker exec hara-postgres pg_isready -U hara >/dev/null 2>&1 && break
  sleep 2
done
ok "data tier up"

# ── 3. MinIO + buckets ──────────────────────────────────────────────────────
log "3/6 — Bringing up MinIO + bucket init"
compose -f "$REPO_ROOT/deploy/data/docker-compose.minio.yml" up -d
log "    Waiting for minio-init to finish bucket setup..."
for i in $(seq 1 30); do
  state=$(docker inspect hara-minio-init --format '{{.State.Status}}' 2>/dev/null || echo gone)
  [ "$state" = "exited" ] && break
  sleep 2
done
ok "minio up; buckets hara-chain-config + hara-pq-anchors ready"

# ── 4. Chain (4 validators) ─────────────────────────────────────────────────
log "4/6 — Bringing up chain (4 validators)"
# Init container seeds vault with validator keys + writes genesis/static-nodes
log "    Running chain init (seeds vault + genesis)..."
compose -f "$REPO_ROOT/deploy/chain/docker-compose.yml" run --rm init
log "    Starting 4 validators..."
compose -f "$REPO_ROOT/deploy/chain/docker-compose.yml" up -d validator1 validator2 validator3 validator4
log "    Waiting for validator1 to mine its first block..."
for i in $(seq 1 60); do
  height=$(docker exec hara-validator1 sh -c 'wget -qO- --post-data="{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"id\":1}" --header="Content-Type: application/json" http://localhost:8545' 2>/dev/null | grep -oE '"result":"0x[0-9a-f]+"' | head -1 || true)
  [ -n "$height" ] && [ "$height" != '"result":"0x0"' ] && break
  sleep 2
done
ok "chain up; validators mining"

# ── 5. RPC tier (HAProxy LB) ────────────────────────────────────────────────
log "5/6 — Bringing up RPC tier (LB)"
compose -f "$REPO_ROOT/deploy/rpc/docker-compose.yml" up -d
ok "RPC LB up at http://localhost:8545"

# ── 6. Services tier (minus anchor-worker until contracts deploy) ───────────
log "6/6 — Bringing up services (signer/broadcaster/indexer/rpc-cache/blockscout)"
compose -f "$REPO_ROOT/deploy/services/docker-compose.yml" up -d \
  migrate signer broadcaster indexer rpc-cache \
  blockscout-db-init blockscout blockscout-fe
ok "services up"

cat <<EOF

═════════════════════════════════════════════════════════════════════
  HaraLedger local simulation up
═════════════════════════════════════════════════════════════════════

  Topology:
    hara-stateful  → hara-vault, hara-postgres, hara-redis, hara-minio
    hara-stateless → hara-signer, hara-broadcaster, hara-indexer,
                     hara-rpc-cache, hara-blockscout(+fe), hara-lb,
                     hara-prometheus, hara-grafana, hara-loki
    hara-v1..v4    → hara-validator1..4

  Endpoints:
    RPC (LB):           http://localhost:8545
    RPC WS:             ws://localhost:8546
    Blockscout:         http://localhost:4010
    Grafana:            http://localhost:3200    (admin / admin)
    Vault UI:           http://localhost:8200    (token: haraledger-dev-root)
    Prometheus:         http://localhost:9090
    MinIO console:      http://localhost:9001    (haraadmin / haraminio-sim)
    Signer (internal):  http://localhost:7000
    RPC cache:          http://localhost:8088

  Next steps:
    1. Deploy contracts:    make deploy-all
    2. Capture the PQAnchorRegistry address from the broadcast file:
         jq -r '.transactions[]
           | select(.contractName=="PQAnchorRegistry")
           | .contractAddress' \\
           chain/deploy/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json
    3. Set it in deploy/sim/.env.sim:
         PQ_ANCHOR_REGISTRY_ADDRESS=0x...
    4. Start anchor-worker:  ./deploy/sim/sim-up.sh anchor

  To tear down:  ./deploy/sim/sim-down.sh
  To see what's running:  docker ps --filter name=hara-

EOF
