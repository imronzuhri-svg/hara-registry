#!/usr/bin/env bash
# Validator entrypoint
#   1. Fetches this validator's key from Vault (by VALIDATOR_ID)
#   2. Writes it to /opt/besu/data/key (chmod 600)
#   3. Copies static-nodes.json from shared volume
#   4. Starts Besu with QBFT

set -euo pipefail

: "${VALIDATOR_ID:?VALIDATOR_ID must be set}"
: "${VAULT_ADDR:?VAULT_ADDR must be set}"
: "${VAULT_TOKEN:?VAULT_TOKEN must be set}"

DATA_DIR=/opt/besu/data
GENESIS=/opt/besu/genesis/genesis.json
STATIC_NODES=/shared/static-nodes.json

mkdir -p "${DATA_DIR}"

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
  --block-txs-selection-max-time=8000 \
  --tx-pool-enable-save-restore=false \
  --logging=INFO
