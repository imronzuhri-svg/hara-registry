#!/usr/bin/env bash
# standby-bootstrap.sh — wake a COLD/SLEEPING standby: rebuild a current Postgres
# from the off-host PITR backups (latest base backup + replay of archived WAL
# from Nevacloud S3), promoted and ready to serve. This is the "wake" action of
# the sleeping-standby DR model (see deploy/ops/RECOVERY.md §PITR and the console
# Backups & DR → Failover panel).
#
# WHERE: run ON the standby host (the VPS that was asleep/just provisioned).
# WHEN:  operator-triggered failover, or to validate the standby is restorable.
#
# It does the same restore the passing pitr-restore-drill.sh proves, but for real:
# into a persistent data dir, with a dedicated `hara-postgres-standby` container,
# then promotes. It deliberately STOPS before repointing production traffic —
# cutover (promote-to-primary / repoint services / update mesh) is the final
# operator step, printed at the end.
#
# RPO: bounded by the WAL ship cadence (~10 min). RTO: mostly the base download +
# WAL replay time.
#
# Requirements on the standby host:
#   - rclone configured with the `nevacloud-s3` remote (read access to the
#     hara-backups-postgres-base + hara-backups-postgres-wal buckets)
#   - the age PRIVATE key (decrypts the backups). Provide via:
#         BACKUP_AGE_KEY=/path/to/hara-backups.txt   (default ~/.config/age/hara-backups.txt)
#     The key is read transiently; it is never written elsewhere by this script.
#   - docker, zstd, age, tar
#
# Modes (env):
#   RECOVERY_TARGET_TIME unset  → replay ALL archived WAL, then promote (most current)
#   RECOVERY_TARGET_TIME='2026-06-03 14:31:55+00' → stop at that instant (PITR)
#
# Env (override as needed):
#   BASE_REMOTE   nevacloud-s3:hara-backups-postgres-base
#   WAL_REMOTE    nevacloud-s3:hara-backups-postgres-wal
#   BACKUP_AGE_KEY  ~/.config/age/hara-backups.txt
#   STANDBY_DIR   /var/lib/hara-standby           (work + restored pgdata live here)
#   PG_IMAGE      postgres:16-alpine
#   PG_PORT       5432                            (host bind for the standby container)
#   MAX_CONNECTIONS / MAX_WORKER_PROCESSES / MAX_WAL_SENDERS / MAX_LOCKS / MAX_PREPARED_TX
#                 must be >= the PRIMARY's, or WAL replay aborts. Defaults match
#                 deploy/data/docker-compose.yml (max_connections=300).

set -euo pipefail

BASE_REMOTE="${BASE_REMOTE:-nevacloud-s3:hara-backups-postgres-base}"
WAL_REMOTE="${WAL_REMOTE:-nevacloud-s3:hara-backups-postgres-wal}"
BACKUP_AGE_KEY="${BACKUP_AGE_KEY:-$HOME/.config/age/hara-backups.txt}"
STANDBY_DIR="${STANDBY_DIR:-/var/lib/hara-standby}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_PORT="${PG_PORT:-5432}"
CONTAINER="${CONTAINER:-hara-postgres-standby}"

# Postmaster GUCs — MUST be >= the primary's (else: "recovery aborted because of
# insufficient parameter settings"). Mirror deploy/data/docker-compose.yml.
MAX_CONNECTIONS="${MAX_CONNECTIONS:-300}"
MAX_WORKER_PROCESSES="${MAX_WORKER_PROCESSES:-8}"
MAX_WAL_SENDERS="${MAX_WAL_SENDERS:-10}"
MAX_LOCKS="${MAX_LOCKS:-64}"
MAX_PREPARED_TX="${MAX_PREPARED_TX:-0}"

PGDATA="$STANDBY_DIR/pgdata"
WALDIR="$STANDBY_DIR/wal-restore"
DEC="age -d -i $BACKUP_AGE_KEY"

log() { echo "▶ [$(date -u +%FT%TZ)] $*"; }
die() { echo "✗ $*" >&2; exit 1; }

echo "════════════════════════════════════════════════════════════════════"
echo "  Hara Registry — standby bootstrap (wake from S3 PITR backups)"
echo "════════════════════════════════════════════════════════════════════"

# ── 0. Preflight ─────────────────────────────────────────────────────────────
log "Preflight"
for t in rclone age zstd tar docker; do command -v "$t" >/dev/null || die "$t not installed"; done
[ -f "$BACKUP_AGE_KEY" ] || die "age private key not found at $BACKUP_AGE_KEY (set BACKUP_AGE_KEY=…)"
rclone listremotes 2>/dev/null | grep -q "^${BASE_REMOTE%%:*}:" || die "rclone remote '${BASE_REMOTE%%:*}' not configured"
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  die "container $CONTAINER already exists — remove it first (docker rm -f $CONTAINER) or set CONTAINER="
fi
AVAIL_KB=$(df -Pk "$STANDBY_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)
echo "  target dir: $STANDBY_DIR ($(( AVAIL_KB / 1024 / 1024 )) GiB free)"
echo "  mode: ${RECOVERY_TARGET_TIME:+PITR to '$RECOVERY_TARGET_TIME'}${RECOVERY_TARGET_TIME:-replay-all-then-promote}"

rm -rf "$STANDBY_DIR" 2>/dev/null || sudo rm -rf "$STANDBY_DIR"
mkdir -p "$PGDATA" "$WALDIR" 2>/dev/null || { sudo mkdir -p "$PGDATA" "$WALDIR"; sudo chown -R "$(id -u)":"$(id -g)" "$STANDBY_DIR"; }

# ── 1. Latest base backup ────────────────────────────────────────────────────
log "Locating latest base backup in $BASE_REMOTE"
BASE_FILE=$(rclone lsf "$BASE_REMOTE/" 2>/dev/null | grep '\.age$' | sort | tail -1)
[ -n "$BASE_FILE" ] || die "no base backup (*.age) found in $BASE_REMOTE"
echo "  newest base: $BASE_FILE"
log "Downloading + decrypting base → $PGDATA"
rclone cat "$BASE_REMOTE/$BASE_FILE" \
  | $DEC \
  | zstd -d \
  | tar -xf - -C "$PGDATA"
echo "  base extracted ($(du -sh "$PGDATA" 2>/dev/null | cut -f1))"

# ── 2. WAL archive ───────────────────────────────────────────────────────────
log "Downloading + decrypting WAL segments → $WALDIR"
TMPWAL="$STANDBY_DIR/wal-enc"
mkdir -p "$TMPWAL"
rclone copy "$WAL_REMOTE/" "$TMPWAL/" --include '*.zst.age' --transfers 4 --checkers 8 --quiet
shopt -s nullglob
n=0
for f in "$TMPWAL"/*.zst.age; do
  seg=$(basename "$f"); seg=${seg%.zst.age}
  $DEC < "$f" | zstd -d > "$WALDIR/$seg"
  n=$((n + 1))
done
shopt -u nullglob
[ "$n" -gt 0 ] || die "no WAL segments restored from $WAL_REMOTE — cannot bring the base current"
echo "  restored $n WAL segment(s)"
rm -rf "$TMPWAL"

# ── 3. Arm archive recovery ──────────────────────────────────────────────────
log "Arming archive recovery"
# Ownership: postgres runs as uid 70 (alpine). The restored tree is owned by us;
# hand it to 70 so the container can use it.
sudo chown -R 70:70 "$PGDATA" "$WALDIR" 2>/dev/null || chown -R 70:70 "$PGDATA" "$WALDIR"
# Capture the base backup's start LSN now — backup_label is consumed (renamed to
# backup_label.old) once recovery reaches consistency, so it must be read before
# boot. Used post-promote to assert WAL replay actually advanced past the base.
BASE_START_LSN=$(sudo grep -m1 'START WAL LOCATION' "$PGDATA/backup_label" 2>/dev/null \
  | sed -E 's/.*: ([0-9A-Fa-f]+\/[0-9A-Fa-f]+).*/\1/' || true)
sudo touch "$PGDATA/recovery.signal" 2>/dev/null || touch "$PGDATA/recovery.signal"
# Build the recovery config, then append it. The data dir is now owned by 70:70
# (chown above), so the append needs sudo. Hard-fail if it doesn't land — a
# silently-missing restore_command/GUC block would promote at the base-only
# consistency point (losing every post-base write) and still look "ready".
RECOVERY_CONF=$(
  echo "restore_command = 'cp /wal-restore/%f %p'"
  echo "recovery_target_action = 'promote'"
  [ -n "${RECOVERY_TARGET_TIME:-}" ] && echo "recovery_target_time = '$RECOVERY_TARGET_TIME'"
  echo "archive_mode = 'off'"
  # GUCs must be >= primary or replay refuses to start.
  echo "max_connections = '$MAX_CONNECTIONS'"
  echo "max_worker_processes = '$MAX_WORKER_PROCESSES'"
  echo "max_wal_senders = '$MAX_WAL_SENDERS'"
  echo "max_locks_per_transaction = '$MAX_LOCKS'"
  echo "max_prepared_transactions = '$MAX_PREPARED_TX'"
)
printf '%s\n' "$RECOVERY_CONF" | sudo tee -a "$PGDATA/postgresql.auto.conf" >/dev/null \
  || die "could not write recovery config to $PGDATA/postgresql.auto.conf"
sudo grep -q "^restore_command" "$PGDATA/postgresql.auto.conf" \
  || die "recovery config did not land in postgresql.auto.conf — refusing to boot a mis-armed standby"

# ── 4. Boot the standby + replay to promote ──────────────────────────────────
log "Starting $CONTAINER over the restored data dir (replaying WAL → promote)"
docker run -d --name "$CONTAINER" \
  -v "$PGDATA:/var/lib/postgresql/data" \
  -v "$WALDIR:/wal-restore:ro" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  "$PG_IMAGE" >/dev/null

echo -n "  waiting for recovery to finish + promote "
PROMOTED=0
for i in $(seq 1 180); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    INREC=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery()" 2>/dev/null || echo t)
    if [ "$INREC" = "f" ]; then PROMOTED=1; echo " ✓ promoted"; break; fi
  fi
  echo -n "."; sleep 2
done
[ "$PROMOTED" = "1" ] || { echo; echo "✗ standby did not promote in time — last logs:"; docker logs --tail 30 "$CONTAINER"; exit 1; }

# ── 5. Report ────────────────────────────────────────────────────────────────
LATEST=$(docker exec "$CONTAINER" psql -U postgres -d hara_indexer -tAc \
  "SELECT max(block_number) FROM indexed_events" 2>/dev/null || echo "?")

# Freshness guard: confirm WAL replay extended the cluster PAST the base. If the
# restore_command silently fetched nothing, recovery would promote at the
# base-only consistency point — a stale standby that still "looks ready". Warn
# loudly rather than hard-fail (a real failover may legitimately have little WAL).
WAL_ADVANCED="unknown"
if [ -n "${BASE_START_LSN:-}" ]; then
  WAL_ADVANCED=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tAc \
    "SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '${BASE_START_LSN}'::pg_lsn) > 0" 2>/dev/null || echo "unknown")
  if [ "$WAL_ADVANCED" = "f" ]; then
    echo "⚠ WARNING: WAL replay did NOT advance past the base start LSN ($BASE_START_LSN)."
    echo "  The standby promoted at the base-only point — post-base writes are MISSING."
    echo "  Check that archived WAL shipped to $WAL_REMOTE and restore_command resolved it."
  fi
fi
echo
echo "════════════════════════════════════════════════════════════════════"
echo "✔ STANDBY READY (promoted, not yet serving prod traffic)"
echo "    container:        $CONTAINER  (127.0.0.1:${PG_PORT})"
echo "    restored base:    $BASE_FILE"
echo "    WAL replayed:     $n segment(s)"
echo "    replay advanced:  $([ "$WAL_ADVANCED" = t ] && echo "yes (past base)" || { [ "$WAL_ADVANCED" = f ] && echo "NO — base-only, STALE" || echo "unknown"; })"
echo "    indexer head:     block $LATEST"
echo "    recovery point:   ${RECOVERY_TARGET_TIME:-end of archived WAL}"
echo "════════════════════════════════════════════════════════════════════"
echo "CUTOVER (operator, when ready to fail over):"
echo "  1. Stop the dead primary (and ensure it stays down — avoid split-brain)."
echo "  2. Repoint services to this host's mesh IP, or migrate this data dir into"
echo "     the hara-registry-data project's postgres-data volume and bring up the"
echo "     normal compose (deploy/data/docker-compose.yml)."
echo "  3. Re-enable archive_mode (remove the archive_mode=off override) so the"
echo "     new primary resumes WAL shipping for the next standby."
echo "  4. Set STANDBY_HOST / STANDBY_HEALTH_URL in the console env so the"
echo "     Failover panel tracks the next standby."
