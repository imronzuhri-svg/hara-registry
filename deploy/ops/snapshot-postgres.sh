#!/usr/bin/env bash
# Daily Postgres dump → age-encrypted → Nevacloud Object Storage.
# Run on hara-stateful at 02:00 local (cron).
#
# Encryption: every snapshot is encrypted to the age recipient in
# $BACKUP_AGE_RECIPIENT BEFORE leaving the VPS. The private key lives ONLY
# on the operator workstation — Nevacloud (or anyone else who reads the
# bucket) sees ciphertext only.
#
# Restore is operator-side:
#   rclone copy nevacloud-s3:hara-backups-postgres/hara_indexer/<file>.age .
#   age -d -i ~/.config/age/hara-backups.txt < <file>.sql.zst.age \
#     | zstd -d | docker exec -i hara-postgres psql -U hara -d hara_indexer

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation, then put the age1 recipient in this VPS env}"

DB_USER="${POSTGRES_USER:-hara}"
DB_NAME_INDEXER="${POSTGRES_DB:-hara_indexer}"
DB_NAME_BLOCKSCOUT="blockscout"
TODAY=$(date +%F)
BACKUP_DIR="/var/backups/hara/postgres"
REMOTE="${PG_REMOTE:-nevacloud-s3:hara-backups-postgres}"

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }

mkdir -p "$BACKUP_DIR"

for db in "$DB_NAME_INDEXER" "$DB_NAME_BLOCKSCOUT"; do
  OUT="${BACKUP_DIR}/${db}-${TODAY}.sql.zst.age"
  echo "▶ [$(date -u +%FT%TZ)] Dumping + encrypting $db ..."
  # Stream: pg_dump → zstd → age. No plaintext ever touches disk.
  docker exec hara-postgres pg_dump -U "$DB_USER" -d "$db" --clean --if-exists \
    | zstd -3 -T0 \
    | age -r "$BACKUP_AGE_RECIPIENT" \
    > "$OUT"
  chmod 600 "$OUT"
  SIZE=$(du -h "$OUT" | cut -f1)
  # Upload only if the rclone remote is configured; otherwise keep local-only
  # so automated backups still run before the off-host target is wired.
  if rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
    echo "  Uploading $SIZE → $REMOTE/$db/"
    # Nevacloud S3 rejects large single-PUT objects (returns an HTML error), so
    # force chunked multipart — postgres dumps grow past the single-PUT limit.
    # (Same fix as snapshot-validator.sh; see incident 2026-06-02.)
    rclone copy "$OUT" "$REMOTE/$db/" \
      --s3-upload-cutoff 16Mi --s3-chunk-size 16Mi --s3-upload-concurrency 2 \
      --transfers 2 --checkers 4 --quiet
  else
    echo "  ⚠ rclone remote '${REMOTE%%:*}' not configured — LOCAL-ONLY at $OUT ($SIZE). Add the Nevacloud S3 endpoint to enable off-host upload."
  fi
done

# Local retention: 7 days (don't let a no-match/cleanup quirk fail the run —
# the actual backups above already succeeded under set -e)
find "$BACKUP_DIR" -name "*.sql.zst.age" -mtime +7 -delete || true

# Remote retention: keep 30 generations per DB. Only if the remote is configured;
# guarded so a cleanup quirk never fails the run after the dumps already uploaded.
if rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
  for db in "$DB_NAME_INDEXER" "$DB_NAME_BLOCKSCOUT"; do
    rclone lsf "$REMOTE/$db/" 2>/dev/null \
      | sort -r | tail -n +31 \
      | while read f; do rclone delete "$REMOTE/$db/$f"; done
  done
fi

echo "✔ [$(date -u +%FT%TZ)] Postgres snapshot complete (encrypted)"
