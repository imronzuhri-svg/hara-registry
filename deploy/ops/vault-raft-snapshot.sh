#!/usr/bin/env bash
# vault-raft-snapshot.sh — take a Raft snapshot and upload to object storage.
#
# Schedule via systemd timer or cron, daily at ~03:00 local (low traffic).
# Restore is a one-liner: `vault operator raft snapshot restore <file>`.
#
# Required env:
#   VAULT_ADDR     default http://127.0.0.1:8200
#   VAULT_TOKEN    a token with policy `default` (snapshot capability is
#                  on sys/storage/raft/snapshot, default policy includes it)
#                  -- in practice an AppRole-issued token from a `snapshotter`
#                  role works; for simplicity here we accept a token from env.
#   SNAPSHOT_DIR   where to land snapshots (default ./snapshots)
#   RCLONE_TARGET  optional, e.g. nevacloud:hara-backups/vault — if set,
#                  the snapshot is uploaded with rclone after creation.

set -euo pipefail

: "${VAULT_TOKEN:?VAULT_TOKEN required}"
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_TOKEN

SNAPSHOT_DIR="${SNAPSHOT_DIR:-./snapshots}"
RCLONE_TARGET="${RCLONE_TARGET:-}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAPSHOT_DIR/vault-raft-${TS}.snap"

mkdir -p "$SNAPSHOT_DIR"

echo "▶ Taking snapshot to $OUT"
vault operator raft snapshot save "$OUT"
chmod 600 "$OUT"
echo "✓ Snapshot saved ($(stat -c %s "$OUT" 2>/dev/null || wc -c <"$OUT") bytes)"

if [ -n "$RCLONE_TARGET" ]; then
  command -v rclone >/dev/null || { echo "✗ rclone not installed" >&2; exit 1; }
  echo "▶ Uploading to $RCLONE_TARGET"
  rclone copy "$OUT" "$RCLONE_TARGET"
  echo "✓ Uploaded"
fi

# Retention: keep last 14 local; remote retention managed by the bucket policy.
ls -1t "$SNAPSHOT_DIR"/vault-raft-*.snap 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "✓ Pruned local snapshots > 14 days"
