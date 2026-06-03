#!/usr/bin/env bash
# snapshot-postgres-wal.sh — ship continuously-archived Postgres WAL segments
# off-host, age-encrypted. Run on hara-stateful every ~10 min (systemd timer).
#
# This is the second half of point-in-time recovery (PITR). The first half is
# the periodic base backup (snapshot-postgres-basebackup.sh). Together:
#   base backup (baseline)  +  every WAL segment since  =  restore to ANY second.
#
# How it fits together:
#   • Postgres' archive_command (deploy/data/docker-compose.yml) copies each
#     completed WAL segment into the /wal-archive volume — fast, local, can't
#     reach for age/rclone (not in the PG container).
#   • THIS script (on the host, where age + rclone live) encrypts every
#     not-yet-shipped segment to $BACKUP_AGE_RECIPIENT and uploads it. Plaintext
#     WAL never leaves the VPS.
#
# Encryption / key handling is identical to snapshot-postgres.sh: the age
# private key lives ONLY on the operator workstation; the bucket sees ciphertext.
#
# Restore (operator workstation — see deploy/ops/RECOVERY.md for the full PITR
# procedure):
#   rclone copy nevacloud-s3:hara-backups-postgres-wal/ ./wal/ --include '*.age'
#   for f in wal/*.age; do age -d -i ~/.config/age/hara-backups.txt < "$f" \
#     | zstd -d > "restore-wal/$(basename "${f%.zst.age}")"; done
#   # ...then point recovery.conf/standby.signal restore_command at restore-wal/

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation, then put the age1 recipient in this VPS env}"

PG_CONTAINER="${PG_CONTAINER:-hara-postgres}"
BACKUP_DIR="/var/backups/hara/postgres-wal"
SHIPPED_DIR="${BACKUP_DIR}/.shipped"      # zero-byte markers: one per shipped segment
REMOTE="${PG_WAL_REMOTE:-nevacloud-s3:hara-backups-postgres-wal}"
LOCAL_KEEP_HOURS="${PG_WAL_LOCAL_KEEP_HOURS:-48}"   # prune shipped segments from the live archive after this
REMOTE_KEEP_DAYS="${PG_WAL_REMOTE_KEEP_DAYS:-14}"   # PITR window length on S3

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }
command -v zstd >/dev/null || { echo "✗ zstd not installed (apt install zstd)"; exit 1; }

# Find the host path of the /wal-archive volume the same way snapshot-validator.sh
# finds the Besu data dir. It's root-owned (postgres uid 70 wrote it), so reads go
# through sudo — hara has passwordless sudo per cloud-init.yaml.
ARCHIVE=$(docker inspect "$PG_CONTAINER" \
  --format '{{ range .Mounts }}{{ if eq .Destination "/wal-archive" }}{{ .Source }}{{ end }}{{ end }}' 2>/dev/null || true)
[ -z "$ARCHIVE" ] && { echo "✗ $PG_CONTAINER has no /wal-archive mount — is the PITR compose deployed?"; exit 1; }

mkdir -p "$BACKUP_DIR" "$SHIPPED_DIR"

REMOTE_OK=0
if rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
  REMOTE_OK=1
else
  echo "⚠ rclone remote '${REMOTE%%:*}' not configured — encrypting locally only, NOT shipping off-host."
fi

shipped=0
# List archived files oldest-first. Includes 24-hex WAL segments plus *.backup
# label files and *.history timeline files — all are needed for PITR, ship them all.
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  marker="${SHIPPED_DIR}/${seg}"
  [ -f "$marker" ] && continue                       # already shipped on a prior run
  OUT="${BACKUP_DIR}/${seg}.zst.age"
  # Stream: segment → zstd → age. Plaintext WAL never lands on disk un-encrypted.
  if ! sudo cat "${ARCHIVE}/${seg}" | zstd -3 -T0 | age -r "$BACKUP_AGE_RECIPIENT" > "$OUT"; then
    echo "  ✗ failed to encrypt $seg — will retry next run"; rm -f "$OUT"; continue
  fi
  chmod 600 "$OUT"
  if [ "$REMOTE_OK" = 1 ]; then
    # Nevacloud S3 rejects large single-PUTs; force chunked multipart (same flags
    # as snapshot-validator.sh). WAL segments are ≤16 MB so this is belt-and-braces.
    if rclone copy "$OUT" "$REMOTE/" \
        --s3-upload-cutoff 16Mi --s3-chunk-size 16Mi --s3-upload-concurrency 2 \
        --transfers 2 --checkers 4 --quiet; then
      touch "$marker"
      rm -f "$OUT"                                    # off-host copy is canonical; don't keep encrypted dupes locally
      shipped=$((shipped + 1))
    else
      echo "  ✗ upload failed for $seg — keeping $OUT, will retry next run"
    fi
  else
    touch "$marker"                                   # local-only mode: count as handled
    shipped=$((shipped + 1))
  fi
done < <(sudo ls -1 "$ARCHIVE" 2>/dev/null | sort)

if [ "$REMOTE_OK" = 1 ]; then
  echo "▶ [$(date -u +%FT%TZ)] shipped $shipped new WAL segment(s) → $REMOTE"
else
  echo "▶ [$(date -u +%FT%TZ)] encrypted $shipped new WAL segment(s) locally (no remote configured)"
fi

# ── Retention ────────────────────────────────────────────────────────────────
# Live archive: prune segments already shipped AND older than LOCAL_KEEP_HOURS.
# Safe because (a) we only delete after a successful upload marker exists, and
# (b) the off-host copy is what PITR restores from. This is what keeps the data
# disk from filling with WAL.
if [ "$REMOTE_OK" = 1 ]; then
  while IFS= read -r seg; do
    [ -z "$seg" ] && continue
    [ -f "${SHIPPED_DIR}/${seg}" ] || continue        # never delete an unshipped segment
    sudo find "${ARCHIVE}/${seg}" -mmin "+$((LOCAL_KEEP_HOURS * 60))" -delete 2>/dev/null || true
  done < <(sudo ls -1 "$ARCHIVE" 2>/dev/null)

  # Drop markers whose segment no longer exists in the live archive (keeps the
  # marker dir from growing forever).
  for m in "$SHIPPED_DIR"/*; do
    [ -e "$m" ] || continue
    sudo test -e "${ARCHIVE}/$(basename "$m")" 2>/dev/null || rm -f "$m"
  done

  # Remote: drop WAL older than the PITR window. rclone --min-age does the
  # time filtering for us (segment names aren't chronologically sortable).
  rclone delete "$REMOTE/" --min-age "${REMOTE_KEEP_DAYS}d" --quiet 2>/dev/null || true
fi

echo "✓ Postgres WAL ship complete ($(date -u +%FT%TZ))"
