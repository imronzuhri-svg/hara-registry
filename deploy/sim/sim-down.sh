#!/usr/bin/env bash
# sim-down.sh — tear down the local 6-node simulation.
#
# Usage:
#   ./deploy/sim/sim-down.sh           # stop containers, keep volumes (fast restart)
#   ./deploy/sim/sim-down.sh --purge   # stop AND delete volumes (full chain reset)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy/sim/.env.sim"
PLATFORM_DIR="$REPO_ROOT/../_platform"

PURGE=""
[ "${1:-}" = "--purge" ] && PURGE="-v"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }

# Tear down in REVERSE order so dependents stop before their dependencies
log "Stopping services tier"
docker compose --env-file "$ENV_FILE" \
  -f "$REPO_ROOT/deploy/services/docker-compose.yml" down $PURGE || true

log "Stopping RPC tier"
docker compose --env-file "$ENV_FILE" \
  -f "$REPO_ROOT/deploy/rpc/docker-compose.yml" down $PURGE || true

log "Stopping chain (4 validators)"
docker compose --env-file "$ENV_FILE" \
  -f "$REPO_ROOT/deploy/chain/docker-compose.yml" down $PURGE || true

log "Stopping MinIO"
docker compose --env-file "$ENV_FILE" \
  -f "$REPO_ROOT/deploy/data/docker-compose.minio.yml" down $PURGE || true

log "Stopping data tier"
docker compose --env-file "$ENV_FILE" \
  -f "$REPO_ROOT/deploy/data/docker-compose.yml" down $PURGE || true

log "Stopping platform (vault dev + observability)"
docker compose --env-file "$ENV_FILE" \
  -f "$PLATFORM_DIR/docker-compose.yml" down $PURGE || true

if [ -n "$PURGE" ]; then
  echo "✓ All sim containers + volumes removed (full reset)"
else
  echo "✓ All sim containers stopped (volumes kept — next sim-up resumes from current state)"
fi
