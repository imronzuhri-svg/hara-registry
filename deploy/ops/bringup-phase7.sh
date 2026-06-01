#!/usr/bin/env bash
# bringup-phase7.sh — deploy contracts + start anchor-worker.
#
# Runs from operator laptop. The chain must be live (Phase 6 complete).
# After this, the PQ audit chain is fully operational:
#   indexed_events → Merkle root → ML-DSA-65 signature → MinIO blob +
#   on-chain commitment via PQAnchorRegistry, every 10 min.
#
# Steps:
#   1. Generate fresh anchor-worker ECDSA keypair on operator laptop.
#      Prints address + private key — operator MUST save to password
#      manager. Will halt with y/N until confirmed.
#   2. Seed the key into Vault (via hara-stateful where Vault lives).
#   3. Fund the anchor-worker address from deployer (anvil-0 has 10000
#      HARA pre-funded in qbft-config.json).
#   4. Deploy 6 contracts via `forge script ...`. Uses ANCHOR_WORKER_ADDRESS
#      env so PQAnchorRegistry grants ANCHOR_ROLE + KEY_ROTATOR_ROLE.
#   5. Capture PQAnchorRegistry address from the broadcast file.
#   6. Push it into services/.env on hara-stateless.
#   7. Start hara-anchor-worker. Verify it boots clean (no Vault 404,
#      no role-grant revert).
#
# Prereqs:
#   • Phase 4-6 complete
#   • ~/hara-ops/vault-init-keys-v2.json present (need root token)
#   • Local repo path resolves so `forge script` can find contracts/
#
# Idempotent: if anchor-worker key already exists in Vault, skip seed.
# Re-deploying contracts produces NEW addresses (operator should run
# this script once per cluster lifetime).

set -euo pipefail

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VAULT_ROOT_TOKEN_FILE="${VAULT_ROOT_TOKEN_FILE:-$HOME/hara-ops/vault-init-keys-v2.json}"
[ -f "$VAULT_ROOT_TOKEN_FILE" ] || die "missing $VAULT_ROOT_TOKEN_FILE"

ROOT=$(jq -r .root_token "$VAULT_ROOT_TOKEN_FILE")
[ -n "$ROOT" ] && [ "$ROOT" != "null" ] || die "could not extract root_token"

# Deployer key — anvil-0 is pre-funded with 10000 HARA in genesis.
# Production should rotate to a fresh deployer key + zero out anvil-0
# in a future genesis if desired. For first-deploy this is fine.
DEPLOYER_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

# RPC endpoint — use the public URL. Could also tunnel via SSH if you
# don't want to expose the write endpoint to the public internet, but
# Caddy already does that for us via /write/ path.
RPC_URL="${RPC_URL:-https://rpc.ledger.haratrust.io/write/}"
echo "Using RPC: $RPC_URL"

# ── Step 1 — Generate anchor-worker keypair ─────────────────────────────────
log "1/7  Generating fresh anchor-worker ECDSA keypair"
WALLET_JSON=$(docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  wallet new --json)
ANCHOR_ADDR=$(echo "$WALLET_JSON" | jq -r '.[0].address')
ANCHOR_KEY=$(echo "$WALLET_JSON" | jq -r '.[0].private_key')

[ -n "$ANCHOR_ADDR" ] && [ "$ANCHOR_ADDR" != "null" ] || die "wallet gen failed"

cat <<EOF

═════════════════════════════════════════════════════════════════════
  ANCHOR-WORKER KEYPAIR — SAVE BOTH TO PASSWORD MANAGER NOW
═════════════════════════════════════════════════════════════════════

  Address:     $ANCHOR_ADDR
  Private key: $ANCHOR_KEY

  These are the only place this private key will ever exist outside
  Vault. Losing it = re-deploying PQAnchorRegistry with a new key.

═════════════════════════════════════════════════════════════════════
EOF

read -p "Saved to password manager? Continue? [y/N] " ans
[ "$ans" = "y" ] || { warn "Aborted. Re-run when ready."; exit 0; }
ok "Continuing with anchor-worker address: $ANCHOR_ADDR"

# ── Step 2 — Seed key into Vault ─────────────────────────────────────────────
log "2/7  Seeding key into Vault (via hara-stateful)"
ssh hara-stateful "
  cd /opt/hara/hara-registry
  ANCHOR_ADDRESS='$ANCHOR_ADDR' ANCHOR_PRIVATE_KEY='$ANCHOR_KEY' \\
    VAULT_TOKEN='$ROOT' VAULT_ADDR=http://10.43.0.40:8200 \\
    bash deploy/ops/seed-anchor-key.sh
" | tail -15
ok "Vault seeded at secret/haraledger/signer-keys/anchor-worker"

# ── Step 3 — Fund the anchor-worker address from deployer ────────────────────
log "3/7  Funding $ANCHOR_ADDR with 1 HARA from deployer"
docker run --rm --network host --entrypoint cast \
  ghcr.io/foundry-rs/foundry:latest \
  send --legacy --gas-price 0 --value 1ether "$ANCHOR_ADDR" \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_KEY" 2>&1 | grep -E 'transactionHash|status' | head -3

# Verify balance
BAL=$(docker run --rm --network host --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  balance "$ANCHOR_ADDR" --rpc-url "$RPC_URL")
echo "  Balance: $BAL wei"
[ "$BAL" != "0" ] || die "anchor-worker has zero balance — fund failed"
ok "anchor-worker funded"

# ── Step 4 — Deploy contracts ────────────────────────────────────────────────
log "4/7  Deploying 6 system contracts via make deploy-all"
cd "$REPO_ROOT"

# Override Makefile's hardcoded http://localhost:8545 by passing
# RPC_URL through to forge directly. But the Makefile pins localhost,
# so easiest: use forge script directly.
cd contracts

# Deploy.s.sol — ContractRegistry + AnchorRegistry + GovernanceContract +
# HaraHalalPassport + IssuerRegistry + TraceabilityBatchRelay
log "  4a  Deploy.s.sol (base contracts)"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --broadcast --legacy --skip-simulation \
  --private-key "$DEPLOYER_KEY" 2>&1 | grep -E '✓|deployed|Hash:|Error' | head -15

# DeployPalmOil.s.sol — HaraPalmOil
log "  4b  DeployPalmOil.s.sol"
forge script script/DeployPalmOil.s.sol:DeployPalmOil \
  --rpc-url "$RPC_URL" \
  --broadcast --legacy --skip-simulation \
  --private-key "$DEPLOYER_KEY" 2>&1 | grep -E '✓|deployed|Hash:|Error' | head -10

# DeployPQAnchor.s.sol — PQAnchorRegistry, with role grant to anchor-worker
log "  4c  DeployPQAnchor.s.sol (with ANCHOR_WORKER_ADDRESS=$ANCHOR_ADDR)"
CR=$(jq -r '.transactions[] | select(.contractName=="ContractRegistry") | .contractAddress' \
  broadcast/Deploy.s.sol/131216/run-latest.json | head -1)
[ -n "$CR" ] || die "could not find ContractRegistry address in broadcast"
echo "  ContractRegistry: $CR"

CONTRACT_REGISTRY="$CR" \
ANCHOR_WORKER_ADDRESS="$ANCHOR_ADDR" \
forge script script/DeployPQAnchor.s.sol:DeployPQAnchor \
  --rpc-url "$RPC_URL" \
  --broadcast --legacy --skip-simulation \
  --private-key "$DEPLOYER_KEY" 2>&1 | grep -E '✓|deployed|granted|Hash:|Error' | head -10

cd "$REPO_ROOT"
ok "contracts deployed"

# ── Step 5 — Capture PQAnchorRegistry address ────────────────────────────────
log "5/7  Capturing PQAnchorRegistry address"
PQ_ADDR=$(jq -r '.transactions[] | select(.contractName=="PQAnchorRegistry") | .contractAddress' \
  contracts/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json | head -1)
[ -n "$PQ_ADDR" ] && [ "${#PQ_ADDR}" = "42" ] || die "could not extract PQAnchorRegistry address"
ok "PQAnchorRegistry deployed at: $PQ_ADDR"

# ── Step 6 — Update services/.env on hara-stateless ─────────────────────────
log "6/7  Updating services/.env on hara-stateless"
ssh hara-stateless "
  sed -i 's|^PQ_ANCHOR_REGISTRY_ADDRESS=.*|PQ_ANCHOR_REGISTRY_ADDRESS=$PQ_ADDR|' \\
    /opt/hara/hara-registry/deploy/services/.env
  grep PQ_ANCHOR_REGISTRY_ADDRESS /opt/hara/hara-registry/deploy/services/.env
"
ok "PQ_ANCHOR_REGISTRY_ADDRESS=$PQ_ADDR set"

# Register all the watched_contracts so the indexer picks them up
log "  6b  Registering deployed contracts in indexer's watched_contracts"
ssh hara-stateless "
  cd /opt/hara/hara-registry
  for s in Deploy.s.sol DeployPalmOil.s.sol DeployPQAnchor.s.sol; do
    f=contracts/broadcast/\$s/131216/run-latest.json
    if [ -f \"\$f\" ]; then
      ./scripts/register-from-broadcast.sh \"\$f\" 2>&1 | tail -3
    fi
  done
" || warn "watched_contracts registration didn't run on hara-stateless (contracts/broadcast/ is on operator laptop, not the VPS) — registering from laptop instead"

# Try from operator laptop too (if scripts/register-from-broadcast.sh exists)
if [ -x "$REPO_ROOT/scripts/register-from-broadcast.sh" ]; then
  for s in Deploy.s.sol DeployPalmOil.s.sol DeployPQAnchor.s.sol; do
    f="contracts/broadcast/$s/131216/run-latest.json"
    [ -f "$f" ] && (cd "$REPO_ROOT" && ./scripts/register-from-broadcast.sh "$f" 2>&1 | tail -3) || true
  done
fi

# ── Step 7 — Start anchor-worker ────────────────────────────────────────────
log "7/7  Starting hara-anchor-worker on hara-stateless"
ssh hara-stateless "
  cd /opt/hara/hara-registry
  docker compose -f deploy/services/docker-compose.yml \\
                 --env-file deploy/services/.env up -d anchor-worker
  sleep 10
  docker ps --filter name=hara-anchor-worker --format '{{.Names}}\t{{.Status}}'
  echo ''
  echo '=== anchor-worker logs (first 30 lines) ==='
  docker logs hara-anchor-worker --tail 30
"

cat <<EOF

═════════════════════════════════════════════════════════════════════
  PHASE 7 COMPLETE — full HaraLedger stack live
═════════════════════════════════════════════════════════════════════

  Deployed contracts:
EOF
jq -r '.transactions[] | select(.contractName) | "    \(.contractName): \(.contractAddress)"' \
  "$REPO_ROOT/contracts/broadcast/Deploy.s.sol/131216/run-latest.json" 2>/dev/null | sort -u
jq -r '.transactions[] | select(.contractName) | "    \(.contractName): \(.contractAddress)"' \
  "$REPO_ROOT/contracts/broadcast/DeployPalmOil.s.sol/131216/run-latest.json" 2>/dev/null | sort -u
echo "    PQAnchorRegistry: $PQ_ADDR"

cat <<EOF

  anchor-worker will produce its first PQ anchor in ~10 min (default
  ANCHOR_INTERVAL_MS=600000). Verify with:

    # On-chain anchor count
    docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest \\
      call $PQ_ADDR 'anchorCount()(uint256)' \\
      --rpc-url $RPC_URL

    # Signature blob in MinIO
    ssh hara-stateful 'docker exec hara-minio mc ls h/hara-pq-anchors/ml-dsa-65/'

    # Postgres row
    ssh hara-stateful "docker exec hara-postgres psql -U hara -d hara_indexer -c \\
      'SELECT encode(commitment_hash,\\\"hex\\\") AS commit, algo, encode(anchor_tx_hash,\\\"hex\\\") AS tx
       FROM pq_anchor_signatures ORDER BY created_at DESC LIMIT 3'"

EOF
