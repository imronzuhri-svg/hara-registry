#!/usr/bin/env bash
# pitr-restore-drill.sh — prove the Postgres point-in-time-recovery path works:
# a physical base backup + replay of archived WAL actually reconstructs data
# that was written AFTER the base was taken.
#
# Companion to snapshot-restore-drill.sh (which validates the logical dump). That
# one proves "last night's dump restores"; THIS one proves the harder property:
# "base backup + the WAL stream since = the cluster, to any point in time." If
# this passes, snapshot-postgres-basebackup.sh + snapshot-postgres-wal.sh +
# archive_mode are wired correctly end to end.
#
# What it does (all against the live hara-postgres, but isolated in a throwaway
# database + a side container — it never touches hara_indexer / blockscout):
#   1. Take a physical base backup of the live cluster (tar, to a temp dir).
#   2. AFTER the base, create database `pitr_drill_db` with a sentinel row
#      carrying a fresh UUID — this exists ONLY in WAL, not in the base.
#   3. Force a WAL switch and wait for the sentinel's segment to land in the
#      archive (the same /wal-archive snapshot-postgres-wal.sh ships).
#   4. Restore the base into a side Postgres container, point restore_command at
#      the live archive, and let it replay to the end of WAL and promote.
#   5. Assert the sentinel UUID is present in the restored cluster. If it is,
#      WAL replay extended the base past its stop point — PITR works.
#
# Requires: docker, a running hara-postgres with archive_mode=on (i.e. the PITR
# compose deployed), and sudo (to read the root-owned WAL archive + fix perms on
# the extracted data dir). The side container, temp dir, and drill database are
# all removed via the EXIT trap whether the drill passes or fails.

set -euo pipefail

LIVE_PG="${LIVE_PG:-hara-postgres}"
SIDE_PG="${SIDE_PG:-hara-postgres-pitr-drill}"
PG_USER="${POSTGRES_USER:-hara}"
IMG="${PITR_IMG:-postgres:16-alpine}"
DRILL_DB="pitr_drill_db"
SENTINEL="pitr-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/pitr-drill.XXXXXX")"
PGDATA="$WORK/pgdata"

ql() { docker exec "$LIVE_PG" psql -U "$PG_USER" -d "${2:-postgres}" -t -A -c "$1"; }
qs() { docker exec "$SIDE_PG" psql -U "$PG_USER" -d "${2:-postgres}" -t -A -c "$1"; }

cleanup() {
  docker rm -f "$SIDE_PG" >/dev/null 2>&1 || true
  docker exec "$LIVE_PG" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE)" >/dev/null 2>&1 || true
  sudo rm -rf "$WORK" 2>/dev/null || rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ 0. Preflight"
docker ps --format '{{.Names}}' | grep -qx "$LIVE_PG" || { echo "✗ $LIVE_PG not running"; exit 1; }
AM=$(ql "SHOW archive_mode")
[ "$AM" = "on" ] || { echo "✗ archive_mode=$AM — PITR compose not deployed; nothing to drill"; exit 1; }
ARCHIVE=$(docker inspect "$LIVE_PG" \
  --format '{{ range .Mounts }}{{ if eq .Destination "/wal-archive" }}{{ .Source }}{{ end }}{{ end }}')
[ -z "$ARCHIVE" ] && { echo "✗ $LIVE_PG has no /wal-archive mount"; exit 1; }
echo "  archive_mode=on, archive dir ← $ARCHIVE"
# Make sure no stale drill DB lingers in what we're about to base-backup.
docker exec "$LIVE_PG" psql -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE)" >/dev/null 2>&1 || true

echo
echo "▶ 1. Base backup of live cluster (this is the PITR baseline)"
mkdir -p "$PGDATA"
# -D - -Ft -Xfetch: a single self-consistent tar to stdout. Extract into PGDATA.
docker exec "$LIVE_PG" pg_basebackup -U "$PG_USER" -D - -Ft -Xfetch -c fast \
  | tar -xf - -C "$PGDATA"
echo "  Extracted base into $PGDATA ($(du -sh "$PGDATA" | cut -f1))"

echo
echo "▶ 2. Write a sentinel AFTER the base (exists only in WAL): $SENTINEL"
docker exec "$LIVE_PG" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $DRILL_DB" >/dev/null
docker exec "$LIVE_PG" psql -U "$PG_USER" -d "$DRILL_DB" -c \
  "CREATE TABLE marker(id text primary key, at timestamptz default now()); INSERT INTO marker(id) VALUES ('$SENTINEL');" >/dev/null
# The segment that now holds our insert — we must wait for IT to be archived.
SEG=$(ql "SELECT pg_walfile_name(pg_current_wal_lsn())")
echo "  Sentinel lives in WAL segment $SEG"

echo
echo "▶ 3. Force a WAL switch and wait for $SEG to reach the archive"
ql "SELECT pg_switch_wal()" >/dev/null
for i in $(seq 1 60); do
  if sudo test -f "$ARCHIVE/$SEG"; then echo "  ✓ $SEG archived"; break; fi
  [ "$i" = 60 ] && { echo "✗ $SEG never archived after 60s — archive_command is failing"; exit 1; }
  sleep 1
done

echo
echo "▶ 4. Restore base + replay archived WAL in a side container, then promote"
# Extracted tar is root-owned; postgres in the image runs as uid 70 and refuses a
# data dir it doesn't own. Fix ownership, then arm archive recovery.
sudo chown -R 70:70 "$PGDATA"
# recovery.signal (NOT standby.signal) → archive recovery that replays to the end
# of available WAL and then promotes. restore_command pulls segments from the
# read-only-mounted live archive.
sudo touch "$PGDATA/recovery.signal"
printf "restore_command = 'cp /wal-archive/%%f %%p'\nrecovery_target_action = 'promote'\n" \
  | sudo tee -a "$PGDATA/postgresql.auto.conf" >/dev/null
# Don't inherit the live archive_command/archive_mode into the throwaway cluster.
printf "archive_mode = 'off'\n" | sudo tee -a "$PGDATA/postgresql.auto.conf" >/dev/null
# WAL replay refuses to start if any of these postmaster GUCs is LOWER on the
# recovery cluster than it was on the primary that generated the WAL ("recovery
# aborted because of insufficient parameter settings"). The live cluster runs
# max_connections=300 (see deploy/data/docker-compose.yml) while the image default
# is 100, so copy the primary's values across. Read them live so the drill stays
# correct if the primary's tuning changes.
for guc in max_connections max_prepared_transactions max_wal_senders \
           max_worker_processes max_locks_per_transaction; do
  val=$(ql "SHOW $guc")
  printf "%s = '%s'\n" "$guc" "$val" | sudo tee -a "$PGDATA/postgresql.auto.conf" >/dev/null
done

docker run -d --name "$SIDE_PG" \
  -v "$PGDATA:/var/lib/postgresql/data" \
  -v "$ARCHIVE:/wal-archive:ro" \
  "$IMG" >/dev/null

echo -n "  Waiting for recovery to finish + promote "
for i in $(seq 1 90); do
  if docker exec "$SIDE_PG" pg_isready -U "$PG_USER" -d postgres >/dev/null 2>&1; then
    INREC=$(qs "SELECT pg_is_in_recovery()" 2>/dev/null || echo "t")
    [ "$INREC" = "f" ] && { echo " ✓ promoted"; break; }
  fi
  [ "$i" = 90 ] && { echo; echo "✗ side cluster did not promote in 90s"; docker logs --tail 30 "$SIDE_PG"; exit 1; }
  echo -n "."; sleep 1
done

echo
echo "▶ 5. Verify the sentinel survived base→WAL replay"
GOT=$(qs "SELECT id FROM marker WHERE id='$SENTINEL'" "$DRILL_DB" 2>/dev/null || true)
echo "  expected: $SENTINEL"
echo "  restored: ${GOT:-<missing>}"

echo
if [ "$GOT" = "$SENTINEL" ]; then
  echo "✓ POSTGRES PITR DRILL PASSED — base backup + WAL replay reconstructs post-base writes"
else
  echo "✗ PITR DRILL FAILED — sentinel absent; WAL replay did not extend the base"
  exit 1
fi
