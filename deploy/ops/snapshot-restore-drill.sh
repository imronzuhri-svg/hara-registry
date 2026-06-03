#!/usr/bin/env bash
# snapshot-restore-drill.sh — prove the Postgres backup path actually works.
#
# Mirrors what snapshot-postgres.sh does for the dump+restore parts, minus
# zstd compression and the rclone upload (those are transport
# optimisations, not data-integrity bits — they don't change whether the
# round-trip preserves data).
#
# Procedure:
#   1. Capture row counts + identifying fingerprints from the live
#      hara-postgres container (watched_contracts, indexed_events,
#      pq_anchor_signatures, _migrations, plus a spot-check on the
#      PQAnchorRegistry address).
#   2. pg_dump --clean --if-exists to a temp file.
#   3. Spin up a side Postgres in a fresh container.
#   4. Pipe the dump into the side container's psql via stdin (avoids
#      Git-Bash MSYS path-conversion mangling of `docker cp`).
#   5. Re-capture the same counts + fingerprints from the restored DB.
#   6. Fail loudly if anything diverges.
#
# Requires: docker + a running hara-postgres container.
# Side container is removed via EXIT trap whether the drill passes or fails.
#
# Why this matters: Postgres is the only data store in the stack with no
# self-healing path. Validators can resync from peers; Postgres can't.
# This drill validates the script's actually-restorable property — running
# it after any schema migration or upgrade is the cheapest defense against
# a backup that silently doesn't restore.
#
# First passing run: 2026-05-15 (closed gate #3 in deploy/topology.md §9).

set -euo pipefail

BACKUP="${BACKUP:-/tmp/hara_indexer_snapshot.sql}"
SIDE_PG="${SIDE_PG:-hara-postgres-restore-test}"
LIVE_PG="${LIVE_PG:-hara-postgres}"
DB="${DB:-hara_indexer}"
USER="${USER_PG:-hara}"

# Record drill outcome for the Strata Console Recovery panel (see pitr-restore-
# drill.sh for the same pattern).
DRILL_RESULT_DIR="${DRILL_RESULT_DIR:-/var/backups/hara/drills}"
DRILL_NAME="logical-dump"
DRILL_START_EPOCH="$(date +%s)"
write_drill_result() {
  local code="$1" status="fail"
  [ "$code" = "0" ] && status="pass"
  local dur=$(( $(date +%s) - DRILL_START_EPOCH ))
  ( mkdir -p "$DRILL_RESULT_DIR" 2>/dev/null || sudo mkdir -p "$DRILL_RESULT_DIR" 2>/dev/null ) || true
  printf '{"drill":"%s","status":"%s","exitCode":%s,"at":"%s","durationSec":%s}\n' \
    "$DRILL_NAME" "$status" "$code" "$(date -u +%FT%TZ)" "$dur" \
    | ( tee "$DRILL_RESULT_DIR/$DRILL_NAME.json" >/dev/null 2>&1 \
        || sudo tee "$DRILL_RESULT_DIR/$DRILL_NAME.json" >/dev/null 2>&1 ) || true
}

cleanup() {
  local code=$?
  docker rm -f "$SIDE_PG" >/dev/null 2>&1 || true
  rm -f "$BACKUP"
  write_drill_result "$code"
}
trap cleanup EXIT

q() { docker exec "$1" psql -U "$USER" -d "$DB" -t -A -c "$2"; }

echo "▶ 1. Baseline from $LIVE_PG"
LIVE_W=$(q "$LIVE_PG" "SELECT count(*) FROM watched_contracts")
LIVE_E=$(q "$LIVE_PG" "SELECT count(*) FROM indexed_events")
LIVE_P=$(q "$LIVE_PG" "SELECT count(*) FROM pq_anchor_signatures")
LIVE_N=$(q "$LIVE_PG" "SELECT string_agg(name, ',' ORDER BY name) FROM watched_contracts")
LIVE_M=$(q "$LIVE_PG" "SELECT count(*) FROM _migrations")
echo "  watched_contracts:    $LIVE_W"
echo "  indexed_events:       $LIVE_E"
echo "  pq_anchor_signatures: $LIVE_P"
echo "  _migrations applied:  $LIVE_M"

echo
echo "▶ 2. pg_dump --clean --if-exists"
docker exec "$LIVE_PG" pg_dump -U "$USER" -d "$DB" --clean --if-exists > "$BACKUP"
echo "  Wrote $BACKUP ($(stat -c %s "$BACKUP") bytes)"

echo
echo "▶ 3. Spin up side Postgres"
docker run -d --name "$SIDE_PG" \
  -e POSTGRES_USER="$USER" -e POSTGRES_PASSWORD="$USER" -e POSTGRES_DB="$DB" \
  postgres:16-alpine >/dev/null
until docker exec "$SIDE_PG" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; do
  sleep 1
done

echo
echo "▶ 4. Restore via stdin (no docker cp; avoids MSYS path mangling)"
cat "$BACKUP" | docker exec -i "$SIDE_PG" psql -U "$USER" -d "$DB" -q > /tmp/restore.log 2>&1

echo
echo "▶ 5. Verify counts + fingerprints"
R_W=$(q "$SIDE_PG" "SELECT count(*) FROM watched_contracts")
R_E=$(q "$SIDE_PG" "SELECT count(*) FROM indexed_events")
R_P=$(q "$SIDE_PG" "SELECT count(*) FROM pq_anchor_signatures")
R_N=$(q "$SIDE_PG" "SELECT string_agg(name, ',' ORDER BY name) FROM watched_contracts")
R_M=$(q "$SIDE_PG" "SELECT count(*) FROM _migrations")
chk() { [ "$1" = "$2" ] && echo ✓ || echo "✗ (live=$1 / restored=$2)"; }
echo "  watched_contracts:    $R_W  $(chk "$LIVE_W" "$R_W")"
echo "  indexed_events:       $R_E  $(chk "$LIVE_E" "$R_E")"
echo "  pq_anchor_signatures: $R_P  $(chk "$LIVE_P" "$R_P")"
echo "  _migrations applied:  $R_M  $(chk "$LIVE_M" "$R_M")"
echo "  contract name list:        $(chk "$LIVE_N" "$R_N")"

echo
echo "▶ 6. Spot-check: PQAnchorRegistry address"
ADDR_LIVE=$(q "$LIVE_PG" "SELECT contract_address FROM watched_contracts WHERE name='PQAnchorRegistry'")
ADDR_REST=$(q "$SIDE_PG" "SELECT contract_address FROM watched_contracts WHERE name='PQAnchorRegistry'")
echo "  live:     $ADDR_LIVE"
echo "  restored: $ADDR_REST  $(chk "$ADDR_LIVE" "$ADDR_REST")"

echo
if [ "$LIVE_W" = "$R_W" ] && [ "$LIVE_E" = "$R_E" ] && [ "$LIVE_P" = "$R_P" ] \
   && [ "$LIVE_M" = "$R_M" ] && [ "$LIVE_N" = "$R_N" ] && [ "$ADDR_LIVE" = "$ADDR_REST" ]; then
  echo "✓ POSTGRES SNAPSHOT/RESTORE DRILL PASSED"
else
  echo "✗ COUNTS DIVERGED — backup path is broken"
  exit 1
fi
