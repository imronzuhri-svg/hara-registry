#!/usr/bin/env bash
# snapshot-postgres-basebackup.sh — periodic physical base backup of the whole
# Postgres cluster → age-encrypted → Nevacloud Object Storage. Run on
# hara-stateful nightly (systemd timer), an hour before the logical dump.
#
# This is the PITR baseline. A base backup + the archived WAL since it was taken
# (shipped by snapshot-postgres-wal.sh) lets you restore the cluster to ANY point
# in time within the WAL retention window.
#
# Relationship to the other two Postgres jobs:
#   snapshot-postgres.sh            logical pg_dump per database — easy single-DB
#                                   / cross-version restore, table-level grep.
#   snapshot-postgres-basebackup.sh THIS — physical cluster image, the PITR base.
#   snapshot-postgres-wal.sh        continuous WAL — replayed on top of a base.
# All three are encrypted off-host; they answer different recovery questions.
#
# Encryption / key handling identical to the other snapshot scripts: the age
# private key lives ONLY on the operator workstation.
#
# Restore: see deploy/ops/RECOVERY.md (§ "Postgres — point-in-time recovery").

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation}"

PG_CONTAINER="${PG_CONTAINER:-hara-postgres}"
DB_USER="${POSTGRES_USER:-hara}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="/var/backups/hara/postgres-base"
OUT="${BACKUP_DIR}/base-${TS}.tar.zst.age"
REMOTE="${PG_BASE_REMOTE:-nevacloud-s3:hara-backups-postgres-base}"
LOCAL_KEEP="${PG_BASE_LOCAL_KEEP:-3}"               # most-recent base backups kept on the VPS
REMOTE_KEEP_DAYS="${PG_BASE_REMOTE_KEEP_DAYS:-21}"  # > WAL window (14d) so a base older than the window edge always exists

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }
command -v zstd >/dev/null || { echo "✗ zstd not installed (apt install zstd)"; exit 1; }

mkdir -p "$BACKUP_DIR"

echo "▶ [$(date -u +%FT%TZ)] pg_basebackup of cluster on $PG_CONTAINER ..."
# -Ft -D -  : write a single tar of the cluster to stdout (one tablespace).
# -X fetch  : bundle the WAL generated during the backup so the base alone is
#             internally consistent (replay archived WAL on top for PITR).
# -c fast   : immediate checkpoint so the backup starts now, not at the next
#             scheduled checkpoint.
# Auth uses the local socket (trust), same path pg_dump uses in snapshot-postgres.sh.
# Stream: base.tar → zstd → age. No plaintext cluster image touches disk.
docker exec "$PG_CONTAINER" pg_basebackup -U "$DB_USER" -D - -Ft -X fetch -c fast \
  | zstd -3 -T0 \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  > "$OUT"
chmod 600 "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "  Wrote $OUT ($SIZE)"

if rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
  echo "  Uploading $SIZE → $REMOTE/"
  rclone copy "$OUT" "$REMOTE/" \
    --s3-upload-cutoff 16Mi --s3-chunk-size 16Mi --s3-upload-concurrency 2 \
    --transfers 2 --checkers 4 --quiet
  # Remote retention: drop base backups older than the window (always keeps the
  # most recent regardless of age via --min-age semantics on the older ones).
  rclone delete "$REMOTE/" --min-age "${REMOTE_KEEP_DAYS}d" --quiet 2>/dev/null || true
else
  echo "  ⚠ rclone remote '${REMOTE%%:*}' not configured — LOCAL-ONLY at $OUT ($SIZE)."
fi

# Local retention: keep the N most recent base backups.
ls -1t "$BACKUP_DIR"/base-*.tar.zst.age 2>/dev/null | tail -n "+$((LOCAL_KEEP + 1))" | xargs -r rm -f

echo "✓ Postgres base backup complete ($(date -u +%FT%TZ))"
