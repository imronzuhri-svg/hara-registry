#!/usr/bin/env bash
# vault-raft-snapshot.sh — take a Raft snapshot, age-encrypt it, upload to
# object storage.
#
# Schedule via systemd timer or cron, daily at ~03:00 local (low traffic).
#
# Auth (pick ONE; AppRole is preferred for the unattended timer):
#   VAULT_APPROLE_ID + VAULT_APPROLE_SECRET
#                           the `vault-snapshot` AppRole from
#                           vault-approle-bootstrap.sh (policy haraledger-snapshot,
#                           cap = read sys/storage/raft/snapshot ONLY — NOT root).
#                           The script logs in and uses the short-lived token it
#                           gets back, so no long-lived token sits in the env.
#   VAULT_TOKEN             fallback — a token that already has the snapshot
#                           capability. Used only if no AppRole is set.
#
# Required env:
#   VAULT_ADDR              default http://127.0.0.1:8200
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

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh}"
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"

VAULT_APPROLE_ID="${VAULT_APPROLE_ID:-}"
VAULT_APPROLE_SECRET="${VAULT_APPROLE_SECRET:-}"

# Run vault inside the hara-vault container if present (host may lack the CLI
# or ship an unrelated `vault` binary — same guard as the other Vault scripts).
# IN_CONTAINER drives where `snapshot save` writes: the CLI writes the snapshot
# file wherever it runs, so the container case saves in-container and we
# docker-cp it out to the host afterwards.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hara-vault$'; then
  IN_CONTAINER=1
  vault() { docker exec -e VAULT_ADDR=http://127.0.0.1:8200 \
                    -e VAULT_TOKEN="${VAULT_TOKEN:-}" \
                    -i hara-vault vault "$@"; }
elif command -v vault >/dev/null 2>&1; then
  IN_CONTAINER=0
  vault() { command vault "$@"; }
else
  echo "✗ no usable Vault: hara-vault container not running AND no vault CLI on host" >&2
  exit 1
fi

# Prefer AppRole login (no long-lived token in the env). Fall back to a
# pre-supplied VAULT_TOKEN if no AppRole is configured.
if [ -n "$VAULT_APPROLE_ID" ] && [ -n "$VAULT_APPROLE_SECRET" ]; then
  echo "▶ Logging in via vault-snapshot AppRole"
  VAULT_TOKEN=$(vault write -field=token auth/approle/login \
    role_id="$VAULT_APPROLE_ID" secret_id="$VAULT_APPROLE_SECRET") \
    || { echo "✗ AppRole login failed" >&2; exit 1; }
  export VAULT_TOKEN
elif [ -n "${VAULT_TOKEN:-}" ]; then
  export VAULT_TOKEN
else
  echo "✗ no auth: set VAULT_APPROLE_ID+VAULT_APPROLE_SECRET (preferred) or VAULT_TOKEN" >&2
  exit 1
fi

SNAPSHOT_DIR="${SNAPSHOT_DIR:-./snapshots}"
RCLONE_TARGET="${RCLONE_TARGET:-}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
RAW="$SNAPSHOT_DIR/vault-raft-${TS}.snap"
OUT="${RAW}.age"

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }
mkdir -p "$SNAPSHOT_DIR"

echo "▶ Taking snapshot to $RAW (will encrypt + delete plaintext)"
if [ "$IN_CONTAINER" = "1" ]; then
  # Save inside the container, then copy the file out to the host landing dir.
  CONTAINER_RAW="/tmp/$(basename "$RAW")"
  vault operator raft snapshot save "$CONTAINER_RAW"
  docker cp "hara-vault:$CONTAINER_RAW" "$RAW"
  docker exec hara-vault rm -f "$CONTAINER_RAW" || true
else
  vault operator raft snapshot save "$RAW"
fi
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
