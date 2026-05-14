#!/usr/bin/env bash
# HaraLedger init container
#   1. Generates QBFT genesis + N validator keypairs via `besu operator generate-blockchain-config`
#   2. Loads each validator key into Vault at secret/haraledger/validators/<N>/key
#   3. Writes static-nodes.json to the shared volume for validator P2P
#   4. Writes genesis.json to the shared genesis volume
#   5. Wipes all generated key material from local disk

set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR must be set}"
: "${VAULT_TOKEN:?VAULT_TOKEN must be set}"
: "${VALIDATOR_COUNT:=4}"

GENESIS_DIR=/work/genesis
GENERATED_DIR=/work/generated
SHARED_DIR=/shared
CONFIG_FILE=/work/qbft-config.json

# Idempotency: if genesis exists AND Vault still holds the keys, skip.
# Otherwise (e.g. Vault dev was restarted, losing in-memory keys), re-bootstrap.
if [ -f "${GENESIS_DIR}/genesis.json" ] && [ -f "${SHARED_DIR}/static-nodes.json" ]; then
  # Probe Vault for validator 1's key — if Vault has it, we're good
  if curl -fsS -o /dev/null \
       -H "X-Vault-Token: ${VAULT_TOKEN}" \
       "${VAULT_ADDR}/v1/secret/data/haraledger/validators/1" 2>/dev/null; then
    echo "✔ Genesis + static-nodes + Vault keys already present. Skipping bootstrap."
    echo "  (Run 'make clean' to wipe and re-bootstrap.)"
    exit 0
  else
    echo "⚠ Genesis present but Vault has no validator keys — re-bootstrapping."
    echo "  (This is expected after a Vault dev-mode restart.)"
    rm -f "${GENESIS_DIR}/genesis.json" "${SHARED_DIR}/static-nodes.json"
  fi
fi

echo "▶ Generating ${VALIDATOR_COUNT}-validator QBFT blockchain config..."
# Clear contents but keep the mount-point directories themselves
find "${GENERATED_DIR}" -mindepth 1 -delete 2>/dev/null || true
mkdir -p "${GENESIS_DIR}" "${SHARED_DIR}"

# besu operator requires the --to directory to NOT exist; use a subdir
WORK_OUT="${GENERATED_DIR}/out"
rm -rf "${WORK_OUT}"
besu operator generate-blockchain-config \
  --config-file="${CONFIG_FILE}" \
  --to="${WORK_OUT}" \
  --private-key-file-name=key

# Copy genesis to the genesis volume
cp "${WORK_OUT}/genesis.json" "${GENESIS_DIR}/genesis.json"
echo "✔ Wrote ${GENESIS_DIR}/genesis.json"

# Wait for Vault to be ready
echo "▶ Waiting for Vault at ${VAULT_ADDR}..."
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "${VAULT_ADDR}/v1/sys/health" 2>/dev/null; then
    break
  fi
  sleep 1
done

# Enable kv-v2 (idempotent — ignore "already in use")
curl -fsS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"type":"kv","options":{"version":"2"}}' \
  "${VAULT_ADDR}/v1/sys/mounts/secret" 2>/dev/null || true

# Walk generated key directories and load into Vault
declare -a ENODES=()
VALIDATOR_INDEX=0
for KEY_DIR in "${WORK_OUT}/keys"/*/; do
  VALIDATOR_INDEX=$((VALIDATOR_INDEX + 1))
  ADDR=$(basename "${KEY_DIR}")
  PRIV=$(cat "${KEY_DIR}/key")
  PUB=$(cat "${KEY_DIR}/key.pub")

  echo "  → Loading validator ${VALIDATOR_INDEX} (0x${ADDR}) into Vault..."
  curl -fsS -X POST \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"data\":{\"address\":\"0x${ADDR}\",\"private_key\":\"${PRIV}\",\"public_key\":\"${PUB}\"}}" \
    "${VAULT_ADDR}/v1/secret/data/haraledger/validators/${VALIDATOR_INDEX}" > /dev/null

  # Build enode entry — strip 0x prefix from pubkey if present.
  # Besu's enode parser requires an IP address (not a hostname). Use the static IPs
  # assigned in docker-compose.yml: 10.42.0.1<N> for validator N.
  PUB_HEX="${PUB#0x}"
  VALIDATOR_IP="10.42.0.1${VALIDATOR_INDEX}"
  ENODES+=("\"enode://${PUB_HEX}@${VALIDATOR_IP}:30303\"")
done

# Write static-nodes.json to shared volume
{
  echo "["
  printf "  %s" "${ENODES[0]}"
  for ((i=1; i<${#ENODES[@]}; i++)); do
    printf ",\n  %s" "${ENODES[$i]}"
  done
  echo ""
  echo "]"
} > "${SHARED_DIR}/static-nodes.json"

echo "✔ Wrote ${SHARED_DIR}/static-nodes.json (${#ENODES[@]} enodes)"

# Wipe generated keys from local disk — Vault is now the source of truth
rm -rf "${WORK_OUT}"
echo "✔ Local key material wiped. Vault holds all validator keys."

# ─────────────────────────────────────────────────────────────────────────────
# L2 — Load the default signer key (Foundry anvil #0) into Vault.
# This key is pre-funded in genesis (chain/qbft-config.json). Production replaces
# it with HARA-controlled signer keys generated separately and loaded via a
# multi-party ceremony.
# ─────────────────────────────────────────────────────────────────────────────
DEPLOYER_ADDR="0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
DEPLOYER_PRIV="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

echo "▶ Loading default signer key into Vault..."
curl -fsS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"data\":{\"address\":\"${DEPLOYER_ADDR}\",\"private_key\":\"${DEPLOYER_PRIV}\"}}" \
  "${VAULT_ADDR}/v1/secret/data/haraledger/signer-keys/deployer" > /dev/null
echo "✔ Signer key 'deployer' loaded at secret/haraledger/signer-keys/deployer"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  HaraLedger bootstrap complete."
echo "  Validators: ${VALIDATOR_COUNT}"
echo "  Vault keys: secret/haraledger/validators/{1..${VALIDATOR_COUNT}}"
echo "  Genesis:    ${GENESIS_DIR}/genesis.json"
echo "═══════════════════════════════════════════════════════════════"
