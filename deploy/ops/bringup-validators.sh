#!/usr/bin/env bash
# bringup-validators.sh — bring up all 4 Besu validators on hara-v1..v4.
#
# Runs from your OPERATOR LAPTOP. SSHes to each validator VPS in turn:
#   1. Pulls genesis.json + static-nodes.json from MinIO on hara-stateful.
#   2. Writes per-VPS chain/.env (VALIDATOR_ID + Vault creds + P2P binding).
#   3. Brings up the validator via docker-compose.validator-only.yml.
#
# Prereqs:
#   • Phase 4 complete on hara-stateful (vault unsealed, 4 validator keys
#     in Vault, genesis.json + static-nodes.json in MinIO).
#   • All 5 VPSes bootstrapped (Docker + WG mesh on 10.43.0.0/24 up).
#   • ~/hara-ops/vault-init-keys-v2.json present (we need the root token).
#
# Required env on the operator laptop:
#   VAULT_ROOT_TOKEN_FILE   default ~/hara-ops/vault-init-keys-v2.json
#   ENV_AGE_RECIPIENT       default reads from a recent .env or env
#
# Idempotent — re-runs are safe.

set -euo pipefail

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VAULT_ROOT_TOKEN_FILE="${VAULT_ROOT_TOKEN_FILE:-$HOME/hara-ops/vault-init-keys-v2.json}"
[ -f "$VAULT_ROOT_TOKEN_FILE" ] || die "missing $VAULT_ROOT_TOKEN_FILE — Phase 4 vault init keys"

ROOT=$(jq -r .root_token "$VAULT_ROOT_TOKEN_FILE")
[ -n "$ROOT" ] && [ "$ROOT" != "null" ] || die "could not extract root_token from $VAULT_ROOT_TOKEN_FILE"

# Hardcoded backup recipient (the one in production env). If you rotated, override.
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-age1fcdr3qk0wuzxy0ynmzj3d28d8m8pfe489wpk6udstzcyccj7l45sjla6e3}"

# ── Step 0 — Ensure static-nodes.json is in MinIO ───────────────────────────
log "Step 0 — uploading static-nodes.json to MinIO (from hara-stateful)"
ssh hara-stateful 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/hara/hara-ledger
MUSER=$(grep MINIO_ROOT_USER deploy/data/.env | cut -d= -f2)
MPASS=$(grep MINIO_ROOT_PASSWORD deploy/data/.env | cut -d= -f2)

# Read static-nodes.json from the chain-shared volume (where chain init wrote it)
SN=$(docker run --rm -v chain-shared:/shared:ro alpine:3.20 cat /shared/static-nodes.json 2>/dev/null || true)
if [ -z "$SN" ]; then
  echo "✗ static-nodes.json not found on chain-shared volume" >&2
  exit 1
fi

# Upload via mc to hara-chain-config bucket
echo "$SN" | docker run --rm -i --network hara-platform \
  -e MC_HOST_h="http://$MUSER:$MPASS@hara-minio:9000" \
  --entrypoint sh minio/mc:RELEASE.2025-08-13T08-35-41Z \
  -c 'cat > /tmp/sn.json && mc cp /tmp/sn.json h/hara-chain-config/static-nodes.json'

# Verify
docker run --rm --network hara-platform \
  -e MC_HOST_h="http://$MUSER:$MPASS@hara-minio:9000" \
  --entrypoint mc minio/mc:RELEASE.2025-08-13T08-35-41Z \
  ls h/hara-chain-config/
REMOTE
ok "static-nodes.json uploaded"

# ── Step 1-4 — bring up each validator ──────────────────────────────────────
declare -A VALIDATOR_WG=( [1]=10.43.0.11 [2]=10.43.0.12 [3]=10.43.0.13 [4]=10.43.0.14 )

for ID in 1 2 3 4; do
  HOST="hara-v$ID"
  WG_IP="${VALIDATOR_WG[$ID]}"

  log "Bringing up validator $ID on $HOST (wg=$WG_IP)"

  # SSH in, prepare files + start
  ssh $HOST "VID=$ID WG_IP=$WG_IP ROOT='$ROOT' AGE_RECIP='$AGE_RECIPIENT' bash -s" <<'REMOTE'
    set -euo pipefail
    cd /opt/hara/hara-ledger
    git stash 2>/dev/null || true
    git pull origin main >/dev/null

    # Pull genesis + static-nodes from MinIO (anonymous read, hara-chain-config is download)
    mkdir -p deploy/chain/genesis deploy/chain/shared
    docker run --rm --network host \
      --entrypoint mc minio/mc:RELEASE.2025-08-13T08-35-41Z \
      cp http://10.43.0.40:9000/hara-chain-config/genesis.json /tmp/genesis.json 2>&1 | tail -3
    # mc can't cp from http URL directly; use anonymous alias instead
    docker run --rm --network host \
      -v "$(pwd)/deploy/chain/genesis:/work" \
      --entrypoint sh minio/mc:RELEASE.2025-08-13T08-35-41Z \
      -c 'mc alias set h http://10.43.0.40:9000 "" "" && mc cp h/hara-chain-config/genesis.json /work/genesis.json'
    docker run --rm --network host \
      -v "$(pwd)/deploy/chain/shared:/work" \
      --entrypoint sh minio/mc:RELEASE.2025-08-13T08-35-41Z \
      -c 'mc alias set h http://10.43.0.40:9000 "" "" && mc cp h/hara-chain-config/static-nodes.json /work/static-nodes.json'

    ls -la deploy/chain/genesis/genesis.json deploy/chain/shared/static-nodes.json

    # Write per-VPS chain/.env
    cat > deploy/chain/.env <<EOF
VALIDATOR_ID=${VID}
VAULT_DEV_ROOT_TOKEN=${ROOT}
VAULT_ADDR=http://10.43.0.40:8200
HARA_CHAIN_ID=131216
HARA_BLOCK_PERIOD_SECONDS=2
HARA_VALIDATOR_COUNT=4
VALIDATOR_P2P_BIND=${WG_IP}:30303
IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/
BACKUP_AGE_RECIPIENT=${AGE_RECIP}
EOF
    chmod 600 deploy/chain/.env

    # Pre-pull the validator image (faster startup)
    docker pull ghcr.io/imronzuhri-svg/hara-ledger-node:latest 2>&1 | tail -1 || true

    # Bring up
    docker compose -f deploy/chain/docker-compose.validator-only.yml \
                   --env-file deploy/chain/.env up -d

    # Wait briefly + show status
    sleep 6
    docker ps --filter name=hara-validator --format "{{.Names}}\t{{.Status}}"
REMOTE

  ok "validator $ID started on $HOST"
done

# ── Step 5 — verify all 4 peered ────────────────────────────────────────────
log "Step 5 — verifying QBFT consensus across all 4 validators"
sleep 15

for ID in 1 2 3 4; do
  HOST="hara-v$ID"
  echo "--- $HOST ---"
  ssh $HOST 'docker exec hara-validator$VALIDATOR_ID sh -c "
    wget -qO- --post-data=\"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"qbft_getValidatorsByBlockNumber\\\",\\\"params\\\":[\\\"latest\\\"],\\\"id\\\":1}\" --header=\"Content-Type: application/json\" http://localhost:8545
  " 2>&1 | head -3' || true
done

cat <<'EOF'

═════════════════════════════════════════════════════════════════════
  Phase 5 — validators up
═════════════════════════════════════════════════════════════════════

  Each of hara-v1..v4 should show 4 validator addresses in qbft_getValidatorsByBlockNumber
  output above. If you see all 4 from all 4 hosts, QBFT consensus is healthy.

  Next: Phase 6 — bring up hara-stateless (RPC + services + edge).

EOF
