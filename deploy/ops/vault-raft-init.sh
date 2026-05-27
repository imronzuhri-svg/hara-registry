#!/usr/bin/env bash
# vault-raft-init.sh — one-shot initialisation for Vault in Raft mode.
#
# Run this ONCE per cluster, immediately after the very first time Vault
# starts in Raft mode (deploy/platform/docker-compose.secrets.yml). It:
#
#   1. Calls `vault operator init` to create the initial unseal keys + root
#      token. Returns 5 unseal keys; any 3 are required to unseal Vault.
#   2. Writes the keys to a local file (chmod 600) so the operator can move
#      them OUT-OF-BAND to a password manager / vault / safe.
#   3. Performs the initial unseal (3 keys).
#   4. Confirms Vault is responsive at the root token.
#
# Safety: this script WILL refuse to run if Vault is already initialised.
# Re-initialising would destroy the existing Raft data (encryption keys
# change). To re-key safely, use `vault operator rekey`.
#
# Next step after this: run vault-approle-bootstrap.sh to create policies
# + AppRoles for validators and signer roles.
#
# Usage: ssh hara@hara-stateful && cd /opt/hara-ledger && ./deploy/ops/vault-raft-init.sh

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
OUT_FILE="${OUT_FILE:-./vault-init-keys.json}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

command -v vault >/dev/null \
  || die "vault CLI required. Install hashicorp/vault or run inside the container."
command -v jq >/dev/null \
  || die "jq required"

export VAULT_ADDR

log "Checking Vault status at $VAULT_ADDR"
status_json=$(vault status -format=json 2>/dev/null || true)
if [ -z "$status_json" ]; then
  die "Vault is not reachable. Bring up the secrets stack first:\n  docker compose -f deploy/platform/docker-compose.secrets.yml up -d"
fi

initialised=$(jq -r '.initialized' <<<"$status_json")
if [ "$initialised" = "true" ]; then
  warn "Vault is already initialised. Refusing to re-init (would destroy data)."
  warn "If you need to unseal a running-but-sealed Vault, use:"
  warn "    vault operator unseal <key>"
  warn "If you need to rotate keys, use:"
  warn "    vault operator rekey -init -key-shares=5 -key-threshold=3"
  exit 0
fi

if [ -f "$OUT_FILE" ]; then
  die "$OUT_FILE already exists. Refusing to overwrite. Move it to a safe place and re-run."
fi

log "Initialising Vault (5 key shares, threshold 3)…"
init_json=$(vault operator init -format=json -key-shares=5 -key-threshold=3)

# Save IMMEDIATELY before doing anything else — if the next step crashes,
# the operator can still recover.
umask 0077
printf '%s\n' "$init_json" > "$OUT_FILE"
chmod 600 "$OUT_FILE"
ok "Wrote unseal keys + root token to $OUT_FILE (chmod 600)"

root_token=$(jq -r '.root_token' <<<"$init_json")

log "Unsealing with the first 3 keys…"
for i in 0 1 2; do
  key=$(jq -r ".unseal_keys_b64[$i]" <<<"$init_json")
  vault operator unseal "$key" >/dev/null
done

log "Verifying unseal succeeded…"
sealed=$(vault status -format=json | jq -r '.sealed')
[ "$sealed" = "false" ] || die "Unseal incomplete (Vault still sealed). Check vault logs." 2

ok "Vault is initialised + unsealed."

log "Enabling KV v2 at secret/ (idempotent)…"
VAULT_TOKEN="$root_token" vault secrets enable -version=2 -path=secret kv 2>/dev/null \
  || warn "  (already enabled — fine)"

ok "Done."
cat >&2 <<EOF

════════════════════════════════════════════════════════════════════════════════
  IMPORTANT — move $OUT_FILE OUT OF THIS HOST.

  It contains:
    • 5 unseal keys (any 3 unseal Vault — quorum-style backup)
    • The initial root token (full admin)

  Recommended destinations (pick at least 2):
    1. Your team's password manager (1Password, Bitwarden, etc.) — each key
       in a separate item so a single compromise doesn't yield 3.
    2. A printed hardcopy in a physical safe.
    3. An encrypted backup on object storage with a separately-stored key.

  After you've copied them out:
    shred -u $OUT_FILE        # secure delete from the VPS

  Next step:
    ./deploy/ops/vault-approle-bootstrap.sh
════════════════════════════════════════════════════════════════════════════════
EOF
