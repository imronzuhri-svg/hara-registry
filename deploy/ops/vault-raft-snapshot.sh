#!/usr/bin/env bash
# vault-raft-snapshot.sh — take a Raft snapshot, age-encrypt it, upload to
# object storage.
#
# Schedule via systemd timer or cron, daily at ~03:00 local (low traffic).
#
# Required env:
#   VAULT_ADDR              default http://127.0.0.1:8200
#   VAULT_TOKEN             token with snapshot capability on
#                           sys/storage/raft/snapshot (default policy includes
#                           it). AppRole-issued snapshotter token in prod.
#   BACKUP_AGE_RECIPIENT    age1… recipient — every snapshot is encrypted
#                           to this key before leaving the VPS. Set via
#                           deploy/ops/backup-setup.sh on operator workstation.
#   SNAPSHOT_DIR            local landing dir (default ./snapshots)
#   RCLONE_TARGET           optional, e.g. nevacloud-s3:hara-backups-vault — if
#                           set, the encrypted snapshot is uploaded.
#
# Restore (operator workstation, the host that holds the age private key):
#   rclone copy $RCLONE_TARGET/vault-raft-<ts>.snap.age .
#   age -d -i ~/.config/age/hara-backups.txt < vault-raft-<ts>.snap.age \
#       > vault-raft-<ts>.snap
#   scp vault-raft-<ts>.snap hara@hara-stateful:/tmp/
#   ssh hara@hara-stateful 'vault operator raft snapshot restore /tmp/vault-raft-<ts>.snap'

set -euo pipefail

: "${VAULT_TOKEN:?VAULT_TOKEN required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh}"
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_TOKEN

SNAPSHOT_DIR="${SNAPSHOT_DIR:-./snapshots}"
RCLONE_TARGET="${RCLONE_TARGET:-}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
RAW="$SNAPSHOT_DIR/vault-raft-${TS}.snap"
OUT="${RAW}.age"

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }
mkdir -p "$SNAPSHOT_DIR"

echo "▶ Taking snapshot to $RAW (will encrypt + delete plaintext)"
vault operator raft snapshot save "$RAW"
chmod 600 "$RAW"

echo "▶ Encrypting → $OUT"
age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT" "$RAW"
chmod 600 "$OUT"
shred -u "$RAW" 2>/dev/null || rm -f "$RAW"
echo "✓ Encrypted snapshot ($(stat -c %s "$OUT" 2>/dev/null || wc -c <"$OUT") bytes)"

if [ -n "$RCLONE_TARGET" ]; then
  command -v rclone >/dev/null || { echo "✗ rclone not installed" >&2; exit 1; }
  echo "▶ Uploading to $RCLONE_TARGET"
  rclone copy "$OUT" "$RCLONE_TARGET"
  echo "✓ Uploaded"
fi

# Retention: keep last 14 local; remote retention managed by the bucket policy.
ls -1t "$SNAPSHOT_DIR"/vault-raft-*.snap.age 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "✓ Pruned local snapshots > 14 days"
