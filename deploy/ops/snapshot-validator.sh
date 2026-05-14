#!/usr/bin/env bash
# Daily backup of validator chain data to Nevacloud Object Storage.
# Run via cron at 03:00 local (off-peak), one validator at a time across the
# fleet so the chain never loses quorum.
#
# Requirements:
#   - rclone configured with a Nevacloud Object Storage remote named "nevacloud-s3"
#     (see rclone config setup; uses S3-compatible API)
#   - validator container is on this host (`docker ps | grep hara-validator`)
#
# Usage:
#   ./snapshot-validator.sh                 # auto-detects the validator on this host
#   ./snapshot-validator.sh validator1      # specify explicitly

set -euo pipefail

CONTAINER="${1:-$(docker ps --format '{{.Names}}' | grep -m1 '^hara-validator' || true)}"
[ -z "$CONTAINER" ] && { echo "✗ no hara-validator* container running on this host"; exit 1; }

TODAY=$(date +%F)
HOSTNAME_TAG=$(hostname -s)
BACKUP_DIR="/var/backups/hara"
TARBALL="${BACKUP_DIR}/${CONTAINER}-${HOSTNAME_TAG}-${TODAY}.tar.zst"
REMOTE_PATH="nevacloud-s3:hara-backups-validator/${HOSTNAME_TAG}/${CONTAINER}/"

mkdir -p "$BACKUP_DIR"

echo "▶ [$(date -u +%FT%TZ)] Snapshotting $CONTAINER on $HOSTNAME_TAG"

# Pause validator briefly (~30s — chain tolerates this if other validators are alive)
echo "  Stopping container..."
docker stop "$CONTAINER" >/dev/null

# Snapshot the volume contents — tar+zstd for speed and compressionVOLUME=$(docker inspect "$CONTAINER" --format '{{ range .Mounts }}{{ if eq .Destination "/opt/besu/data" }}{{ .Source }}{{ end }}{{ end }}')
echo "  Archive ← $VOLUME"
tar --use-compress-program='zstd -3 -T0' -cf "$TARBALL" -C "$(dirname "$VOLUME")" "$(basename "$VOLUME")"
SIZE=$(du -h "$TARBALL" | cut -f1)

# Restart validator immediately
echo "  Starting container..."
docker start "$CONTAINER" >/dev/null

# Upload to Nevacloud Object Storage
echo "  Uploading $SIZE → $REMOTE_PATH"
rclone copy "$TARBALL" "$REMOTE_PATH" --transfers 4 --checkers 4 --quiet

# Local retention: keep 3 most recent, delete older
find "$BACKUP_DIR" -name "${CONTAINER}-${HOSTNAME_TAG}-*.tar.zst" -type f \
  | sort -r | tail -n +4 | xargs -r rm -f

# Remote retention: keep 14 most recent
rclone lsf "$REMOTE_PATH" 2>/dev/null \
  | sort -r | tail -n +15 \
  | while read f; do rclone delete "$REMOTE_PATH$f"; done

echo "✔ [$(date -u +%FT%TZ)] $CONTAINER snapshot complete: $SIZE"
