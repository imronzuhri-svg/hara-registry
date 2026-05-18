#!/usr/bin/env bash
# Validator entrypoint
#   1. Fetches this validator's key from Vault (by VALIDATOR_ID)
#   2. Writes it to /opt/besu/data/key (chmod 600)
#   3. Copies static-nodes.json from shared volume
#   4. Starts Besu with QBFT

set -euo pipefail

: "${VALIDATOR_ID:?VALIDATOR_ID must be set}"
: "${VAULT_ADDR:?VAULT_ADDR must be set}"

DATA_DIR=/opt/besu/data
GENESIS=/opt/besu/genesis/genesis.json
STATIC_NODES=/shared/static-nodes.json

mkdir -p "${DATA_DIR}"

# ── Vault auth: AppRole preferred, root-token fallback ──────────────────────
# Production (per deploy/ops/vault-approle-bootstrap.sh): VAULT_APPROLE_ID +
# VAULT_APPROLE_SECRET are set, validator logs in to get a short-TTL token.
# Local dev: VAULT_TOKEN is set directly (haraledger-dev-root or similar).
if [ -n "${VAULT_APPROLE_ID:-}" ] && [ -n "${VAULT_APPROLE_SECRET:-}" ]; then
  echo "▶ Logging in to Vault via AppRole (validator)..."
  LOGIN_RESPONSE=$(curl -fsS \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"role_id\":\"${VAULT_APPROLE_ID}\",\"secret_id\":\"${VAULT_APPROLE_SECRET}\"}" \
    "${VAULT_ADDR}/v1/auth/approle/login")
  VAULT_TOKEN=$(echo "${LOGIN_RESPONSE}" | grep -oE '"client_token":"[^"]+"' | sed 's/.*:"//;s/"$//')
  if [ -z "${VAULT_TOKEN}" ]; then
    echo "✗ AppRole login failed:" >&2
    echo "${LOGIN_RESPONSE}" >&2
    exit 1
  fi
  echo "✔ AppRole token acquired (no root token in this container)"
elif [ -n "${VAULT_TOKEN:-}" ]; then
  echo "▶ Using VAULT_TOKEN directly (dev mode — AppRole envs not set)"
else
  echo "✗ Need either VAULT_APPROLE_ID+VAULT_APPROLE_SECRET (prod) or VAULT_TOKEN (dev)" >&2
  exit 1
fi

# Fetch validator key from Vault
echo "▶ Fetching validator ${VALIDATOR_ID} key from Vault..."
RESPONSE=$(curl -fsS \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/secret/data/haraledger/validators/${VALIDATOR_ID}")

PRIV=$(echo "${RESPONSE}" | grep -oE '"private_key":"[^"]+"' | sed 's/"private_key":"//;s/"$//')

if [ -z "${PRIV}" ]; then
  echo "✗ Failed to fetch validator key from Vault" >&2
  echo "${RESPONSE}" >&2
  exit 1
fi

# Besu expects the key without 0x prefix in the key file
echo "${PRIV#0x}" > "${DATA_DIR}/key"
chmod 600 "${DATA_DIR}/key"
echo "✔ Validator key written to ${DATA_DIR}/key"

# Build bootnodes comma-separated list from static-nodes.json,
# excluding our own enode (Besu rejects self-references).
# Validators are at 10.42.0.11..14 (by VALIDATOR_ID).
OWN_IP="10.42.0.1${VALIDATOR_ID}"
BOOTNODES=$(grep -oE 'enode://[^"]+' "${STATIC_NODES}" | grep -v "@${OWN_IP}:" | paste -sd,)

echo "▶ Bootnodes: ${BOOTNODES}"

# Start Besu
exec besu \
  --data-path="${DATA_DIR}" \
  --genesis-file="${GENESIS}" \
  --node-private-key-file="${DATA_DIR}/key" \
  --p2p-host=0.0.0.0 \
  --p2p-port=30303 \
  --discovery-enabled=true \
  --bootnodes="${BOOTNODES}" \
  --rpc-http-enabled=false \
  --rpc-ws-enabled=false \
  --host-allowlist="*" \
  --metrics-enabled=true \
  --metrics-host=0.0.0.0 \
  --metrics-port=9545 \
  --min-gas-price=0 \
  --logging=INFO
