#!/usr/bin/env bash
# vault-approle-bootstrap.sh — create policies + AppRoles for hara-registry.
#
# Run this AFTER vault-raft-init.sh has put Vault in an unsealed state.
# Idempotent — safe to re-run; existing roles are updated, not duplicated.
#
# Creates:
#   • Policy `haraledger-validator`  → read secret/data/haraledger/validators/*
#   • Policy `haraledger-signer`     → read secret/data/haraledger/signer-keys/*
#   • Policy `haraledger-anchor`     → read+write secret/data/haraledger/anchor/*
#   • AppRole `validator`            → bound to validator policy
#   • AppRole `signer`               → bound to signer policy
#   • AppRole `anchor-worker`        → bound to anchor policy
#
# For each AppRole, prints role_id + secret_id pair to STDOUT. Operator
# copies these into the per-VPS .env file (no token sprawl; each VPS only
# sees the credentials for the role it actually plays).
#
# Why AppRole, not root token: state-2 §11 #3 and the lessons doc both want
# this. Root token = key to the kingdom; AppRole tokens are role-scoped,
# rotatable, and revocable per VPS.
#
# Required env:
#   VAULT_ADDR    default http://127.0.0.1:8200
#   VAULT_TOKEN   the root token from vault-init-keys.json
#
# Usage:
#   VAULT_TOKEN=$(jq -r .root_token < vault-init-keys.json) \
#     ./deploy/ops/vault-approle-bootstrap.sh

set -euo pipefail

: "${VAULT_TOKEN:?VAULT_TOKEN required (root token from vault-init-keys.json)}"
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_TOKEN

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

command -v jq >/dev/null || die "jq required"

# Prefer docker exec into hara-vault container; only fall back to host CLI
# if the binary identifies as HashiCorp Vault v1.x (some distros ship an
# unrelated `vault` v2.x command). Same pattern as vault-raft-init.sh.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hara-vault$'; then
  vault() { docker exec -e VAULT_ADDR=http://127.0.0.1:8200 \
                    -e VAULT_TOKEN="$VAULT_TOKEN" \
                    -i hara-vault vault "$@"; }
  VAULT_ADDR="http://127.0.0.1:8200"
elif command -v vault >/dev/null 2>&1 \
     && vault --version 2>/dev/null | grep -qE '^Vault v1\.'; then
  vault() { command vault "$@"; }
else
  die "no usable Vault: hara-vault container not running AND no HashiCorp Vault v1.x CLI on host"
fi

vault status -format=json | jq -e '.sealed == false' >/dev/null \
  || die "Vault is sealed — run vault-raft-init.sh or unseal first"

# ── Enable AppRole auth (idempotent) ─────────────────────────────────────────
log "Enabling AppRole auth method"
if ! vault auth list -format=json | jq -e '.["approle/"]' >/dev/null 2>&1; then
  vault auth enable approle
else
  ok "  (already enabled)"
fi

# ── Policies ─────────────────────────────────────────────────────────────────
log "Writing policy haraledger-validator"
vault policy write haraledger-validator - <<'EOF'
# Validator can ONLY read its assigned key under validators/{1..4}.
# Granularity stops a compromised validator-1 from reading validator-2's key.
# We don't have per-validator policies yet (would need a templated policy
# parameterised by role-bound metadata). For now: any validator can read any
# validator key. Acceptable in the P0–P1 trust model (all validators are
# HARA-operated). Tighten at L6 when external operators join.
path "secret/data/haraledger/validators/*" {
  capabilities = ["read"]
}
EOF

log "Writing policy haraledger-signer"
vault policy write haraledger-signer - <<'EOF'
path "secret/data/haraledger/signer-keys/*" {
  capabilities = ["read"]
}
EOF

log "Writing policy haraledger-anchor"
vault policy write haraledger-anchor - <<'EOF'
# Anchor worker reads its signing key and writes audit anchors.
path "secret/data/haraledger/signer-keys/anchor-worker" {
  capabilities = ["read"]
}
path "secret/data/haraledger/anchor/*" {
  capabilities = ["read", "create", "update"]
}
EOF

ok "Policies written"

# ── AppRoles ─────────────────────────────────────────────────────────────────
create_approle() {
  local role="$1"; local policy="$2"; local ttl="${3:-1h}"; local max_ttl="${4:-24h}"
  log "Configuring AppRole: $role (policy=$policy ttl=$ttl max_ttl=$max_ttl)"
  vault write -f "auth/approle/role/$role" \
    token_policies="$policy" \
    token_ttl="$ttl" \
    token_max_ttl="$max_ttl" \
    secret_id_ttl="0" \
    secret_id_num_uses="0" >/dev/null
}

create_approle validator     haraledger-validator
create_approle signer        haraledger-signer
create_approle anchor-worker haraledger-anchor

ok "AppRoles created"

# ── Print role_id / secret_id pairs ──────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  AppRole credentials — copy into each VPS's chain/.env or service env"
echo "════════════════════════════════════════════════════════════════════════"
for role in validator signer anchor-worker; do
  role_id=$(vault read -format=json "auth/approle/role/$role/role-id" | jq -r '.data.role_id')
  secret_id=$(vault write -f -format=json "auth/approle/role/$role/secret-id" | jq -r '.data.secret_id')
  echo
  echo "[$role]"
  echo "  VAULT_APPROLE_ID=$role_id"
  echo "  VAULT_APPROLE_SECRET=$secret_id"
done
echo

ok "Done. Move these credentials to the per-VPS .env files."
echo
echo "Next step:"
echo "  • Distribute role/secret pairs to validator VPSes + hara-stateless"
echo "  • Bring up validators (they will authenticate via AppRole on first boot)"
echo "  • Consider running this script periodically to rotate secret_ids"
