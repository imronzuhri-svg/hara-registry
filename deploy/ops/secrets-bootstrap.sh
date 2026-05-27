#!/usr/bin/env bash
# Generate production secrets, write them to local .env files (one per role),
# and seed Vault with the canonical copies.
#
# Run this ONCE per cluster from the host that will run the platform stack
# (where Vault is reachable). After it completes, copy each role's .env to
# the corresponding VPS via SCP.
#
# Usage:
#   ./secrets-bootstrap.sh init             Generate fresh secrets (refuses if .env exists)
#   ./secrets-bootstrap.sh refresh-grafana  Rotate just the Grafana admin password
#   ./secrets-bootstrap.sh refresh-postgres Rotate just the Postgres password (DOWNTIME)
#
# Generated secrets live in:
#   ./deploy/platform/.env       (Vault token, Grafana password)
#   ./deploy/data/.env           (Postgres password, Redis settings)
#   ./deploy/services/.env       (inherits the above)
#   ./deploy/chain/.env          (inherits Vault token)
#   ./deploy/rpc/.env            (binding only — no secrets)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gen() {
  # tr reading /dev/urandom is unbounded; head -c N closes the pipe early
  # and tr exits 141 (SIGPIPE). Under `set -euo pipefail` that aborts the
  # whole script *before* any .env is written — found by the 2026-05-15
  # pre-VPS gate-5 dry-run. Subshell with pipefail off absorbs it cleanly.
  (set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-32}")
}

cmd=${1:-init}

case "$cmd" in

init)
  for d in platform data services chain rpc; do
    if [ -f "$ROOT/$d/.env" ]; then
      echo "✗ $ROOT/$d/.env exists — refuse to overwrite. Use refresh-* commands or delete and re-run."
      exit 1
    fi
  done

  VAULT_TOKEN="$(gen 48)"
  GF_PASSWORD="$(gen 32)"
  PG_PASSWORD="$(gen 32)"
  MINIO_PASSWORD="$(gen 32)"

  # Production layout (post-2026-05-27 redesign):
  #   WG mesh on 10.43.0.0/24 — each host's wg0 IP is the cross-host endpoint.
  #   Docker bridge stays on 10.42.0.0/24 — container-local only.
  #   Services on hara-stateful bind their ports to 10.43.0.40 (wg0); services
  #   on hara-stateless reach them at http://10.43.0.40:<port>.
  #
  # Bind addresses below assume each .env file deploys to the VPS that hosts
  # those services:
  #   platform/.env, data/.env, data/minio       → hara-stateful (binds 10.43.0.40)
  #   services/.env, rpc/.env, platform/obs.env  → hara-stateless
  #   chain/.env                                  → hara-v1..v4 + hara-stateful (init)

  HARA_STATEFUL_WG="10.43.0.40"
  HARA_STATELESS_WG="10.43.0.20"

  echo "▶ Writing deploy/platform/.env  (for hara-stateful)"
  cat > "$ROOT/platform/.env" <<EOF
VAULT_DEV_ROOT_TOKEN=${VAULT_TOKEN}
GF_SECURITY_ADMIN_PASSWORD=${GF_PASSWORD}
GF_SERVER_ROOT_URL=https://grafana.platform.haratrust.io
GRAFANA_BIND=${HARA_STATELESS_WG}:3200
# Vault listens on hara-stateful's wg0 IP so other VPSes can reach it via
# WG mesh (validators + signer + anchor-worker all need this).
VAULT_BIND=${HARA_STATEFUL_WG}:8200
VAULT_CLUSTER_BIND=${HARA_STATEFUL_WG}:8201
PROM_BIND=127.0.0.1:9090
ALERTMANAGER_BIND=127.0.0.1:9093
LOKI_BIND=127.0.0.1:3201
TEMPO_OTLP_HTTP_BIND=127.0.0.1:4318
PROM_RETENTION=90d
EOF
  chmod 600 "$ROOT/platform/.env"

  echo "▶ Writing deploy/data/.env  (for hara-stateful)"
  cat > "$ROOT/data/.env" <<EOF
POSTGRES_USER=hara
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=hara_indexer
# Postgres + Redis + MinIO bind on hara-stateful's wg0 so hara-stateless
# services can reach them cross-host via WG.
POSTGRES_BIND=${HARA_STATEFUL_WG}:5432
REDIS_BIND=${HARA_STATEFUL_WG}:6379
REDIS_MAXMEMORY=512mb
MINIO_ROOT_USER=haraadmin
MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}
MINIO_API_BIND=${HARA_STATEFUL_WG}:9000
MINIO_CONSOLE_BIND=127.0.0.1:9001
EOF
  chmod 600 "$ROOT/data/.env"

  echo "▶ Writing deploy/services/.env  (for hara-stateless)"
  cat > "$ROOT/services/.env" <<EOF
VAULT_DEV_ROOT_TOKEN=${VAULT_TOKEN}
POSTGRES_USER=hara
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=hara_indexer
HARA_CHAIN_ID=131216
# Cross-host service endpoints (point at hara-stateful's wg0 IP)
VAULT_ADDR=http://${HARA_STATEFUL_WG}:8200
POSTGRES_HOST=${HARA_STATEFUL_WG}
REDIS_HOST=${HARA_STATEFUL_WG}
MINIO_ENDPOINT=${HARA_STATEFUL_WG}:9000
SIGNER_BIND=127.0.0.1:7000
INDEXER_METRICS_BIND=127.0.0.1:9100
RPC_CACHE_BIND=0.0.0.0:8088
BLOCKSCOUT_BE_BIND=127.0.0.1:4000
BLOCKSCOUT_FE_BIND=0.0.0.0:4010
EOF
  chmod 600 "$ROOT/services/.env"

  echo "▶ Writing deploy/chain/.env  (for hara-v1..v4 + hara-stateful init)"
  cat > "$ROOT/chain/.env" <<EOF
VAULT_DEV_ROOT_TOKEN=${VAULT_TOKEN}
HARA_CHAIN_ID=131216
HARA_BLOCK_PERIOD_SECONDS=2
HARA_VALIDATOR_COUNT=4
# Vault is on hara-stateful, reachable cross-host at its wg0 IP. Validators
# AND the init container on hara-stateful both use this address — on
# hara-stateful, 10.43.0.40 IS the local wg0 IP, so it works there too.
VAULT_ADDR=http://${HARA_STATEFUL_WG}:8200
V1_P2P_BIND=0.0.0.0:30303
EOF
  chmod 600 "$ROOT/chain/.env"

  echo "▶ Writing deploy/rpc/.env"
  cat > "$ROOT/rpc/.env" <<EOF
RPC_HTTP_BIND=0.0.0.0:8545
RPC_WS_BIND=0.0.0.0:8546
HAPROXY_STATS_BIND=127.0.0.1:8404
EOF
  chmod 600 "$ROOT/rpc/.env"

  echo
  echo "═════════════════════════════════════════════════════════════════════"
  echo "  Generated 3 fresh secrets across 5 .env files (all chmod 600)"
  echo
  echo "  Vault token:      ${VAULT_TOKEN:0:8}…  (48 chars)"
  echo "  Grafana password: ${GF_PASSWORD:0:8}…  (32 chars)"
  echo "  Postgres pwd:     ${PG_PASSWORD:0:8}…  (32 chars)"
  echo "  MinIO root pwd:   ${MINIO_PASSWORD:0:8}…  (32 chars)"
  echo "═════════════════════════════════════════════════════════════════════"
  echo
  echo "Next steps:"
  echo "  1. Bring up platform first:    docker compose -f platform/docker-compose.yml --env-file platform/.env up -d"
  echo "  2. Bring up data:              docker compose -f data/docker-compose.yml --env-file data/.env up -d"
  echo "  3. Bring up chain (init runs):  docker compose -f chain/docker-compose.yml --env-file chain/.env run --rm init"
  echo "     Then:                        docker compose -f chain/docker-compose.yml --env-file chain/.env up -d"
  echo "  4. Bring up rpc:               docker compose -f rpc/docker-compose.yml --env-file rpc/.env up -d"
  echo "  5. Bring up services:          docker compose -f services/docker-compose.yml --env-file services/.env up -d"
  ;;

refresh-grafana)
  NEW=$(gen 32)
  sed -i "s|^GF_SECURITY_ADMIN_PASSWORD=.*|GF_SECURITY_ADMIN_PASSWORD=${NEW}|" "$ROOT/platform/.env"
  echo "▶ Recreating Grafana with new password..."
  docker compose -f "$ROOT/platform/docker-compose.yml" --env-file "$ROOT/platform/.env" up -d --force-recreate grafana
  echo "✔ Done. New Grafana password: ${NEW:0:8}… (full value in platform/.env)"
  ;;

refresh-postgres)
  echo "⚠  Postgres password rotation requires brief downtime of every dependent service."
  read -p "Continue? [y/N] " ans
  [ "$ans" != "y" ] && exit 0
  NEW=$(gen 32)
  OLD=$(grep POSTGRES_PASSWORD "$ROOT/data/.env" | cut -d= -f2)
  docker exec hara-postgres psql -U hara -d hara_indexer -c "ALTER USER hara WITH PASSWORD '${NEW}'"
  for f in "$ROOT"/{data,services}/.env; do sed -i "s|POSTGRES_PASSWORD=${OLD}|POSTGRES_PASSWORD=${NEW}|" "$f"; done
  echo "▶ Restarting dependent services..."
  docker compose -f "$ROOT/services/docker-compose.yml" --env-file "$ROOT/services/.env" restart signer broadcaster indexer blockscout
  echo "✔ Done. New Postgres password rotated."
  ;;

*)
  echo "Usage: $0 {init|refresh-grafana|refresh-postgres}"
  exit 1
  ;;
esac
