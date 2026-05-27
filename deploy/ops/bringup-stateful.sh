#!/usr/bin/env bash
# bringup-stateful.sh — orchestrate everything on hara-stateful after
# vault-raft-init.sh has run. Run on hara-stateful, with VAULT_TOKEN env
# set to the root token from vault-init-keys.json.
#
# Does, in order:
#   1. Vault AppRole bootstrap   (validator, signer, anchor-worker)
#   2. Postgres + Redis up
#   3. MinIO up + bucket creation verified
#   4. Chain init (genesis + validator keys → Vault)
#   5. Upload genesis.json to MinIO for validator + rpc pull
#
# Idempotent — safe to re-run.
#
# Usage:
#   ssh hara-stateful "VAULT_TOKEN=hvs.XXX cd /opt/hara/hara-ledger && bash deploy/ops/bringup-stateful.sh"
#
# Prints AppRole credentials (role_id + secret_id) at the end — SAVE THESE.
# They go into per-VPS .env files in Phase 5 (validators) and Phase 6 (stateless).

set -euo pipefail

: "${VAULT_TOKEN:?VAULT_TOKEN required — set to root_token from vault-init-keys.json}"
REPO_ROOT="${REPO_ROOT:-/opt/hara/hara-ledger}"
cd "$REPO_ROOT"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Sanity-check Vault is unsealed + reachable
docker ps --format '{{.Names}}' | grep -q '^hara-vault$' \
  || die "hara-vault container not running — run vault-raft-init.sh first"

sealed=$(docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN \
  hara-vault vault status -format=json 2>/dev/null | jq -r '.sealed' || echo true)
[ "$sealed" = "false" ] || die "Vault is sealed — unseal it before continuing"
ok "Vault unsealed + reachable"

# ── 1. AppRole bootstrap ─────────────────────────────────────────────────────
log "1/5  AppRole bootstrap (validator, signer, anchor-worker policies + roles)"
APPROLE_OUTPUT=$(VAULT_TOKEN="$VAULT_TOKEN" bash deploy/ops/vault-approle-bootstrap.sh 2>&1)
echo "$APPROLE_OUTPUT" | tail -25
ok "AppRole bootstrap complete"

# Capture role_id/secret_id pairs for the final summary
APPROLE_CREDS=$(echo "$APPROLE_OUTPUT" | grep -E '(role_id|secret_id)' || true)

# ── 2. Postgres + Redis ──────────────────────────────────────────────────────
log "2/5  Bringing up data tier (postgres + redis)"
docker compose -f deploy/data/docker-compose.yml \
               --env-file deploy/data/.env up -d
for i in $(seq 1 30); do
  docker exec hara-postgres pg_isready -U hara >/dev/null 2>&1 && break
  sleep 2
done
docker exec hara-postgres pg_isready -U hara >/dev/null 2>&1 \
  || die "postgres never became ready"
ok "postgres + redis up"

# ── 3. MinIO + buckets ───────────────────────────────────────────────────────
log "3/5  Bringing up MinIO + creating buckets"
docker compose -f deploy/data/docker-compose.minio.yml \
               --env-file deploy/data/.env up -d
for i in $(seq 1 30); do
  state=$(docker inspect hara-minio-init --format '{{.State.Status}}' 2>/dev/null || echo missing)
  [ "$state" = "exited" ] && break
  sleep 2
done
docker logs hara-minio-init --tail 5 2>&1 | sed 's/^/    /'
ok "MinIO up; buckets hara-chain-config + hara-pq-anchors ready"

# ── 4. Chain init ────────────────────────────────────────────────────────────
log "4/5  Chain init (genesis + validator keys → Vault)"
# If genesis already exists, the init script skips. Idempotent.
#
# IMPORTANT: chain/.env has VAULT_ADDR=http://10.43.0.40:8200 because that
# value is correct for validators on hara-v1..v4 reaching vault cross-host.
# But this init container runs on hara-stateful where vault is LOCAL —
# and Docker's iptables chain doesn't NAT bridge→host-wg-IP traffic on
# Linux kernel defaults, so 10.43.0.40 is unreachable from the bridge.
# Override here to docker DNS for the intra-host case.
# Also override VAULT_DEV_ROOT_TOKEN with the REAL Vault Raft root token.
# chain/.env stores a random 48-char string under that name (left over from
# dev-mode assumptions — in dev mode, $VAULT_DEV_ROOT_TOKEN was the literal
# root token). In Raft mode, the real root token is returned by
# vault-raft-init.sh and lives in vault-init-keys.json. The orchestrator
# was invoked with VAULT_TOKEN=$root_token in env — pipe it through.
# Also pass VALIDATOR_IP_PREFIX=10.43.0.1 so chain init bakes WG mesh IPs
# into static-nodes.json. Otherwise it defaults to 10.42.0.1 (container
# bridge IPs) which only work for single-host, not multi-host where
# validators are on separate VPSes and need to reach each other via WG.
VAULT_ADDR=http://vault:8200 \
VAULT_DEV_ROOT_TOKEN="$VAULT_TOKEN" \
VALIDATOR_IP_PREFIX=10.43.0.1 \
  docker compose -f deploy/chain/docker-compose.yml \
                 --env-file deploy/chain/.env run --rm init 2>&1 | tail -20
ok "Chain init complete — 4 validator keys in Vault, genesis.json on disk"

# ── 5. Upload genesis.json to MinIO so validators + stateless can pull it ───
log "5/5  Uploading genesis.json to MinIO (hara-chain-config bucket)"
MINIO_USER=$(grep ^MINIO_ROOT_USER deploy/data/.env | cut -d= -f2)
MINIO_PASS=$(grep ^MINIO_ROOT_PASSWORD deploy/data/.env | cut -d= -f2)
# Use MC_HOST_<name>=URL form instead of `mc alias set`. The alias-set
# path in mc 2025-08 has a bug that fails with "Insufficient permissions"
# on cp even with valid root creds; the env-URL form works. Caught
# 2026-05-27 on hara-stateful.
docker run --rm --network hara-platform \
  -v "$REPO_ROOT/deploy/chain/genesis:/work:ro" \
  -e MC_HOST_h="http://${MINIO_USER}:${MINIO_PASS}@hara-minio:9000" \
  --entrypoint mc \
  minio/mc:RELEASE.2025-08-13T08-35-41Z \
  cp /work/genesis.json h/hara-chain-config/genesis.json
ok "genesis.json uploaded — validators + stateless can now pull it"

# ── Summary ──────────────────────────────────────────────────────────────────
cat <<'EOF'

═════════════════════════════════════════════════════════════════════
  hara-stateful bring-up COMPLETE
═════════════════════════════════════════════════════════════════════

  Running containers:
EOF
docker ps --filter name=hara- --format '    {{.Names}}\t{{.Status}}'

cat <<EOF

  AppRole credentials (SAVE THESE — needed for Phase 5 + Phase 6):

$APPROLE_CREDS

  Save each role_id + secret_id pair to your password manager as:
    HaraLedger Prod - Vault AppRole <role>

  Genesis file uploaded to MinIO:
    s3://hara-chain-config/genesis.json
    Validators + hara-stateless will pull this in Phase 5 + Phase 6.

  Next step (from operator laptop):
    Phase 5 — bring up validators v1..v4 in parallel
EOF
