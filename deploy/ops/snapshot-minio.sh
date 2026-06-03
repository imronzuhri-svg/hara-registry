#!/usr/bin/env bash
# snapshot-minio.sh — daily backup of the MinIO data volume → age-encrypted →
# Nevacloud Object Storage. Run on hara-stateful at 02:45 local (systemd timer).
#
# MinIO holds two buckets (deploy/data/docker-compose.minio.yml):
#   • hara-chain-config — genesis.json + static-nodes.json (write-once).
#   • hara-pq-anchors   — ML-DSA-65 post-quantum signature blobs per ADR-0010,
#                         referenced by the Postgres pq_anchor_signatures index.
# The PQ anchors are the audit trail behind every on-chain anchor — they have no
# other copy, so they MUST be backed up off-host.
#
# Method: tar the whole MinIO data volume (single-node `server /data` FS backend)
# → zstd → age, same shape as snapshot-validator.sh. This captures buckets +
# their on-disk metadata as one restorable image. MinIO is left running; these
# buckets are append-only / write-once so a live tar is consistent enough (an
# object mid-upload would simply be absent, not corrupt). For an object-level
# alternative, `mc mirror` each bucket to a staging dir instead — noted but not
# needed at this scale.
#
# Encryption / key handling identical to the other snapshot scripts: the age
# private key lives ONLY on the operator workstation.
#
# Restore (see deploy/ops/RECOVERY.md): decrypt → untar into a fresh MinIO data
# volume while the container is stopped → start.

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation}"

MINIO_CONTAINER="${MINIO_CONTAINER:-hara-minio}"
TODAY=$(date +%F)
BACKUP_DIR="/var/backups/hara/minio"
OUT="${BACKUP_DIR}/minio-${TODAY}.tar.zst.age"
REMOTE="${MINIO_REMOTE:-nevacloud-s3:hara-backups-minio}"
LOCAL_KEEP="${MINIO_LOCAL_KEEP:-3}"
REMOTE_KEEP_DAYS="${MINIO_REMOTE_KEEP_DAYS:-30}"

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }

# Find the host path of the MinIO /data volume (root-owned → read via sudo, same
# as snapshot-validator.sh reads the Besu data dir).
VOLUME=$(docker inspect "$MINIO_CONTAINER" \
  --format '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Source }}{{ end }}{{ end }}' 2>/dev/null || true)
[ -z "$VOLUME" ] && { echo "✗ could not find /data mount on $MINIO_CONTAINER — is MinIO running?"; exit 1; }

mkdir -p "$BACKUP_DIR"

echo "▶ [$(date -u +%FT%TZ)] Archiving + encrypting MinIO data ($VOLUME) ..."
# Stream: tar → zstd → age. Plaintext bucket data never lands on disk.
sudo tar --use-compress-program='zstd -3 -T0' \
    -cf - -C "$(dirname "$VOLUME")" "$(basename "$VOLUME")" \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  > "$OUT"
chmod 600 "$OUT"
[ -s "$OUT" ] || { echo "✗ snapshot is empty — MinIO archive failed"; rm -f "$OUT"; exit 1; }
SIZE=$(du -h "$OUT" | cut -f1)
echo "  Wrote $OUT ($SIZE)"

if rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
  echo "  Uploading $SIZE → $REMOTE/"
  rclone copy "$OUT" "$REMOTE/" \
    --s3-upload-cutoff 16Mi --s3-chunk-size 16Mi --s3-upload-concurrency 2 \
    --transfers 2 --checkers 4 --quiet
  rclone delete "$REMOTE/" --min-age "${REMOTE_KEEP_DAYS}d" --quiet 2>/dev/null || true
else
  echo "  ⚠ rclone remote '${REMOTE%%:*}' not configured — LOCAL-ONLY at $OUT ($SIZE)."
fi

# Local retention: keep the N most recent.
ls -1t "$BACKUP_DIR"/minio-*.tar.zst.age 2>/dev/null | tail -n "+$((LOCAL_KEEP + 1))" | xargs -r rm -f

echo "✓ MinIO snapshot complete ($(date -u +%FT%TZ))"
