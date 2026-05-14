#!/usr/bin/env bash
# Daily Postgres dump → Nevacloud Object Storage.
# Run on hara-data host at 02:00 local.

set -euo pipefail

DB_USER="${POSTGRES_USER:-hara}"
DB_NAME_INDEXER="${POSTGRES_DB:-hara_indexer}"
DB_NAME_BLOCKSCOUT="blockscout"
TODAY=$(date +%F)
BACKUP_DIR="/var/backups/hara/postgres"
REMOTE="nevacloud-s3:hara-backups-postgres"

mkdir -p "$BACKUP_DIR"

for db in "$DB_NAME_INDEXER" "$DB_NAME_BLOCKSCOUT"; do
  OUT="${BACKUP_DIR}/${db}-${TODAY}.sql.zst"
  echo "▶ [$(date -u +%FT%TZ)] Dumping $db ..."
  docker exec hara-postgres pg_dump -U "$DB_USER" -d "$db" --clean --if-exists \
    | zstd -3 -T0 > "$OUT"
  SIZE=$(du -h "$OUT" | cut -f1)
  echo "  Uploading $SIZE → $REMOTE/$db/"
  rclone copy "$OUT" "$REMOTE/$db/" --quiet
done

# Local retention: 7 days
find "$BACKUP_DIR" -name "*.sql.zst" -mtime +7 -delete

# Remote retention: 30 generations per DB
for db in "$DB_NAME_INDEXER" "$DB_NAME_BLOCKSCOUT"; do
  rclone lsf "$REMOTE/$db/" 2>/dev/null \
    | sort -r | tail -n +31 \
    | while read f; do rclone delete "$REMOTE/$db/$f"; done
done

echo "✔ [$(date -u +%FT%TZ)] Postgres snapshot complete"
