#!/usr/bin/env bash
# bringup-stateless.sh — bring up hara-stateless (Phase 6).
#
# Run from operator laptop. SSHes to hara-stateless and brings up the full
# application + observability + edge stack in dependency order:
#
#   1. Create hara-platform docker network
#   2. Pull genesis.json from MinIO (rpc nodes need it)
#   3. Write per-host .env files (services + rpc + platform + edge)
#   4. RPC tier — HAProxy LB + 3 read RPC nodes (read Besu)
#   5. Services tier — migrate, signer, broadcaster, indexer, rpc-cache,
#                      blockscout(+db-init+fe). ANCHOR-WORKER deferred
#                      until Phase 7 (after contracts deploy + key seeded).
#   6. Observability tier — Prometheus, Grafana, Loki, Alertmanager,
#                          Promtail, alert-sink
#   7. Open UFW for 80/443
#   8. Edge (Caddy + Let's Encrypt) — needs DNS records already pointing
#      at hara-stateless and ports 80/443 open
#
# Prereqs:
#   • Phase 4 + 5 complete (vault unsealed; 4 validators producing blocks)
#   • DNS A records:
#       rpc.ledger.haratrust.io       → hara-stateless public IP
#       explorer.ledger.haratrust.io  → hara-stateless public IP
#       grafana.platform.haratrust.io → hara-stateless public IP
#   • ~/hara-ops/vault-init-keys-v2.json on operator laptop
#
# Required env on operator laptop:
#   VAULT_ROOT_TOKEN_FILE       default ~/hara-ops/vault-init-keys-v2.json
#   BACKUP_AGE_RECIPIENT        default reads from a saved value
#
# Idempotent — safe to re-run.

set -euo pipefail

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VAULT_ROOT_TOKEN_FILE="${VAULT_ROOT_TOKEN_FILE:-$HOME/hara-ops/vault-init-keys-v2.json}"
[ -f "$VAULT_ROOT_TOKEN_FILE" ] || die "missing $VAULT_ROOT_TOKEN_FILE — Phase 4 vault init keys"

ROOT=$(jq -r .root_token "$VAULT_ROOT_TOKEN_FILE")
[ -n "$ROOT" ] && [ "$ROOT" != "null" ] || die "could not extract root_token"

AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-age1fcdr3qk0wuzxy0ynmzj3d28d8m8pfe489wpk6udstzcyccj7l45sjla6e3}"
HARA_STATEFUL_WG="10.43.0.40"

# ── Steps 1-3: prep on operator laptop, then push to hara-stateless ─────────
log "Step 1-3: prep network + env files (on operator laptop, push to host)"

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Pull .env files from hara-stateful via operator laptop's ssh
ssh hara-stateful 'cat /opt/hara/hara-ledger/deploy/platform/.env' > "$TMPDIR/platform.env"
ssh hara-stateful 'cat /opt/hara/hara-ledger/deploy/services/.env' > "$TMPDIR/services.env"
ssh hara-stateful 'cat /opt/hara/hara-ledger/deploy/rpc/.env'      > "$TMPDIR/rpc.env"
ssh hara-stateful 'cat /opt/hara/hara-ledger/deploy/data/.env'     > "$TMPDIR/data.env"

# Replace dev token placeholder with the real Vault root token. The .env on
# hara-stateful has a random 48-char string under VAULT_DEV_ROOT_TOKEN (left
# over from dev-mode assumptions); in Raft mode the actual root token is
# the one returned by vault operator init.
sed -i "s|^VAULT_DEV_ROOT_TOKEN=.*|VAULT_DEV_ROOT_TOKEN=${ROOT}|" "$TMPDIR/services.env"
sed -i "s|^VAULT_DEV_ROOT_TOKEN=.*|VAULT_DEV_ROOT_TOKEN=${ROOT}|" "$TMPDIR/platform.env"

# services/.env on hara-stateless ALSO needs the MinIO + Postgres creds
# from data/.env (anchor-worker reaches MinIO + Postgres on hara-stateful
# via WG). Copy the relevant lines over.
{
  echo ""
  echo "# Cross-host service creds (copied from hara-stateful's data/.env)"
  grep -E '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)' "$TMPDIR/data.env"
} >> "$TMPDIR/services.env"

# Append IMAGE_REGISTRY + age recipient (idempotent)
for f in "$TMPDIR"/{platform,services,rpc}.env; do
  grep -q ^IMAGE_REGISTRY       "$f" || echo "IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/" >> "$f"
  grep -q ^BACKUP_AGE_RECIPIENT "$f" || echo "BACKUP_AGE_RECIPIENT=${AGE_RECIPIENT}"   >> "$f"
done

# Set anchor-worker placeholder address so compose validates (real one set in Phase 7)
grep -q ^PQ_ANCHOR_REGISTRY_ADDRESS "$TMPDIR/services.env" \
  || echo "PQ_ANCHOR_REGISTRY_ADDRESS=0x0000000000000000000000000000000000000000" >> "$TMPDIR/services.env"

# Upload to hara-stateless
scp "$TMPDIR/platform.env" hara-stateless:/opt/hara/hara-ledger/deploy/platform/.env >/dev/null
scp "$TMPDIR/services.env" hara-stateless:/opt/hara/hara-ledger/deploy/services/.env >/dev/null
scp "$TMPDIR/rpc.env"      hara-stateless:/opt/hara/hara-ledger/deploy/rpc/.env      >/dev/null

# Blockscout env files are gitignored (they contain SECRET_KEY_BASE +
# hardcoded passwords). Scp them from the operator laptop's local copy.
SCRIPT_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BS_ENVS="$SCRIPT_REPO_ROOT/deploy/services/blockscout/envs"
if [ -d "$BS_ENVS" ]; then
  ssh hara-stateless 'mkdir -p /opt/hara/hara-ledger/deploy/services/blockscout/envs'
  scp -q "$BS_ENVS"/common-blockscout.env hara-stateless:/opt/hara/hara-ledger/deploy/services/blockscout/envs/
  scp -q "$BS_ENVS"/common-frontend.env   hara-stateless:/opt/hara/hara-ledger/deploy/services/blockscout/envs/
  ok ".env files + blockscout configs uploaded to hara-stateless (5 files)"
else
  warn "Blockscout envs missing at $BS_ENVS — Blockscout will fail to start. Skipping."
  ok ".env files uploaded to hara-stateless (3 files)"
fi

# Now do everything else on hara-stateless
log "Step 4-6: bring up RPC + services + obs on hara-stateless"
ssh hara-stateless "STATEFUL='$HARA_STATEFUL_WG' bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/hara/hara-ledger
git stash 2>/dev/null || true
git pull origin main >/dev/null

# Create hara-platform docker network if missing
if ! docker network inspect hara-platform >/dev/null 2>&1; then
  docker network create --driver bridge \
    --subnet 10.42.0.0/24 --gateway 10.42.0.1 \
    hara-platform
  echo "  ✓ created hara-platform docker network"
fi

# Pull genesis.json AND static-nodes.json from MinIO. RPC nodes mount
# both via bind: deploy/chain/genesis + deploy/chain/shared.
mkdir -p deploy/chain/genesis deploy/chain/shared
curl -fsS -o deploy/chain/genesis/genesis.json \
  http://${STATEFUL}:9000/hara-chain-config/genesis.json
curl -fsS -o deploy/chain/shared/static-nodes.json \
  http://${STATEFUL}:9000/hara-chain-config/static-nodes.json
ls -la deploy/chain/genesis/genesis.json deploy/chain/shared/static-nodes.json

chmod 600 deploy/{platform,services,rpc}/.env

# 4. RPC tier (LB + 3 read RPC nodes)
# Pre-build the hara-ledger-node image. GHCR doesn't have it yet (no CI
# workflow builds it), so the pull would fail and fall back to build —
# but the fallback is racy with multi-replica startup. Build first.
echo ""
echo "▶ Building hara-ledger-node image (not in GHCR)"
docker compose -f deploy/rpc/docker-compose.yml \
               --env-file deploy/rpc/.env build rpc-read-1 2>&1 | tail -3

echo ""
echo "▶ Bringing up RPC tier"
docker compose -f deploy/rpc/docker-compose.yml \
               --env-file deploy/rpc/.env up -d
sleep 6
docker ps --filter name=hara-rpc --filter name=hara-lb --format "  {{.Names}}\t{{.Status}}"

# 5. Services tier (anchor-worker excluded for now)
echo ""
echo "▶ Bringing up services tier (without anchor-worker)"
docker compose -f deploy/services/docker-compose.yml \
               --env-file deploy/services/.env up -d \
               migrate signer broadcaster indexer rpc-cache \
               blockscout-db-init blockscout blockscout-fe
sleep 8
docker ps --filter name=hara-signer --filter name=hara-broadcaster --filter name=hara-indexer \
          --filter name=hara-rpc-cache --filter name=hara-blockscout --format "  {{.Names}}\t{{.Status}}"

# 6. Observability
echo ""
echo "▶ Bringing up observability (prometheus, grafana, loki, alertmanager)"
docker compose -f deploy/platform/docker-compose.obs.yml \
               --env-file deploy/platform/.env up -d
sleep 6
docker ps --filter name=hara-prometheus --filter name=hara-grafana --filter name=hara-loki \
          --filter name=hara-alertmanager --format "  {{.Names}}\t{{.Status}}"
REMOTE
ok "RPC + services + obs up on hara-stateless"

# ── Step 7: Open UFW for Caddy edge (80/443) ────────────────────────────────
log "Opening UFW ports 80 + 443 on hara-stateless"
ssh hara-stateless 'sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw reload && sudo ufw status numbered | head -15'

# ── Step 8: Verify DNS BEFORE bringing up edge ──────────────────────────────
log "Verifying DNS for the 3 public hostnames"
STATELESS_IP=$(grep ^hara-stateless ~/hara-ops/vps-hosts.env | cut -d= -f2)
for h in rpc.ledger explorer.ledger grafana.platform; do
  RESOLVED=$(dig +short @1.1.1.1 $h.haratrust.io | tail -1)
  if [ "$RESOLVED" = "$STATELESS_IP" ]; then
    ok "  $h.haratrust.io → $RESOLVED (matches hara-stateless)"
  else
    warn "  $h.haratrust.io → '${RESOLVED:-no answer}' (expected $STATELESS_IP)"
    warn "  Caddy will fail to issue certs until DNS resolves correctly."
  fi
done

read -p "DNS looks right? Continue with edge bring-up? [y/N] " ans
[ "$ans" = "y" ] || { warn "Aborting before edge. Re-run after DNS propagates."; exit 0; }

# ── Step 9: Edge (Caddy + Let's Encrypt) ────────────────────────────────────
log "Bringing up edge (Caddy + LE cert issuance)"
ssh hara-stateless '
  cd /opt/hara/hara-ledger
  docker compose -f deploy/edge/docker-compose.yml up -d
  echo ""
  echo "Watching Caddy for cert issuance (Ctrl+C to detach — Caddy stays up)..."
  echo "Expect 3 \"certificate obtained\" lines (one per hostname)."
  timeout 120 docker logs -f hara-caddy 2>&1 | grep --line-buffered -E "certificate obtained|error|warn" | head -10 || true
'

ok "Edge brought up. Verify public endpoints:"
cat <<EOF

  curl -sI https://rpc.ledger.haratrust.io/        | head -1
  curl -sI https://explorer.ledger.haratrust.io/   | head -1
  curl -sI https://grafana.platform.haratrust.io/  | head -1

  Expect HTTP/2 200 (or 301 redirect for some — fine).

  If any return 502 / 504: services aren't connecting to upstreams.
  Diagnose with: docker logs hara-caddy --tail 30

EOF

cat <<'EOF'

═════════════════════════════════════════════════════════════════════
  Phase 6 — hara-stateless up
═════════════════════════════════════════════════════════════════════

  Next: Phase 7 — deploy contracts + start anchor-worker
    1. From operator laptop with anvil-funded or production deployer key:
       cd hara-ledger
       ANCHOR_WORKER_ADDRESS=<address> \
         DEPLOYER_PRIVATE_KEY=<key> \
         RPC_URL=https://rpc.ledger.haratrust.io/write \
         make deploy-all
    2. Capture PQAnchorRegistry address from broadcast file.
    3. Seed anchor-worker signer key in Vault:
       ANCHOR_ADDRESS=<addr> ANCHOR_PRIVATE_KEY=<key> \
         VAULT_TOKEN=<root> VAULT_ADDR=http://10.43.0.40:8200 \
         ./deploy/ops/seed-anchor-key.sh
    4. Update services/.env with PQ_ANCHOR_REGISTRY_ADDRESS=<addr>
    5. Start anchor-worker on hara-stateless

EOF
