#!/usr/bin/env bash
# Daily backup of validator chain data → age-encrypted → Nevacloud Object Storage.
# Run via cron at 03:00 local (off-peak), one validator at a time across the
# fleet so the chain never loses quorum.
#
# Requirements:
#   - rclone configured with a Nevacloud remote named "nevacloud-s3"
#   - age installed (apt install age)
#   - BACKUP_AGE_RECIPIENT env (set via deploy/ops/backup-setup.sh on operator workstation)
#   - validator container is on this host (`docker ps | grep hara-validator`)
#
# Usage:
#   ./snapshot-validator.sh                 # auto-detects the validator on this host
#   ./snapshot-validator.sh validator1      # specify explicitly
#
# Restore (operator workstation):
#   rclone copy nevacloud-s3:hara-backups-validator/hara-v1/hara-validator1/<file>.age .
#   age -d -i ~/.config/age/hara-backups.txt < <file>.tar.zst.age | zstd -d \
#     | tar -xC /restore-target/

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation}"

CONTAINER="${1:-$(docker ps --format '{{.Names}}' | grep -m1 '^hara-validator' || true)}"
[ -z "$CONTAINER" ] && { echo "✗ no hara-validator* container running on this host"; exit 1; }

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }

TODAY=$(date +%F)
HOSTNAME_TAG=$(hostname -s)
BACKUP_DIR="/var/backups/hara"
TARBALL="${BACKUP_DIR}/${CONTAINER}-${HOSTNAME_TAG}-${TODAY}.tar.zst.age"
REMOTE_PATH="nevacloud-s3:hara-backups-validator/${HOSTNAME_TAG}/${CONTAINER}/"

mkdir -p "$BACKUP_DIR"

echo "▶ [$(date -u +%FT%TZ)] Snapshotting $CONTAINER on $HOSTNAME_TAG"

# Discover the Besu data-dir bind-mount BEFORE we stop the container.
VOLUME=$(docker inspect "$CONTAINER" \
  --format '{{ range .Mounts }}{{ if eq .Destination "/opt/besu/data" }}{{ .Source }}{{ end }}{{ end }}')
[ -z "$VOLUME" ] && { echo "✗ could not find /opt/besu/data mount on $CONTAINER"; exit 1; }
echo "  Source ← $VOLUME"

# Pause validator briefly (~30s — chain tolerates this if other validators are alive)
echo "  Stopping container..."
docker stop "$CONTAINER" >/dev/null

# CRITICAL: from this point the validator is DOWN. Guarantee it restarts no
# matter how this script exits (archive failure, signal, etc.) — otherwise a
# failed backup leaves the validator dead and (across the fleet) halts the chain.
# (This exact bug halted the chain on 2026-06-02.) The explicit start below
# clears the trap on the happy path.
trap 'echo "  ⚠ restarting $CONTAINER on exit"; docker start "$CONTAINER" >/dev/null 2>&1 || true' EXIT

# Stream: tar → zstd → age. Plaintext never lands on disk. The Besu data volume
# is root-owned, so read it via sudo (the snapshot service runs as an unprivileged
# user). sudo failure no longer strands the validator — the trap restarts it.
echo "  Archiving + encrypting ..."
sudo tar --use-compress-program='zstd -3 -T0' \
    -cf - -C "$(dirname "$VOLUME")" "$(basename "$VOLUME")" \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  > "$TARBALL"
chmod 600 "$TARBALL"
SIZE=$(du -h "$TARBALL" | cut -f1)

# Restart validator immediately, then clear the safety trap.
echo "  Starting container..."
docker start "$CONTAINER" >/dev/null
trap - EXIT

# Upload to Nevacloud Object Storage
echo "  Uploading $SIZE → $REMOTE_PATH"
rclone copy "$TARBALL" "$REMOTE_PATH" --transfers 4 --checkers 4 --quiet

# Local retention: keep 3 most recent, delete older
find "$BACKUP_DIR" -name "${CONTAINER}-${HOSTNAME_TAG}-*.tar.zst.age" -type f \
  | sort -r | tail -n +4 | xargs -r rm -f

# Remote retention: keep 14 most recent
rclone lsf "$REMOTE_PATH" 2>/dev/null \
  | sort -r | tail -n +15 \
  | while read f; do rclone delete "$REMOTE_PATH$f"; done

echo "✔ [$(date -u +%FT%TZ)] $CONTAINER snapshot complete (encrypted): $SIZE"
