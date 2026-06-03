#!/usr/bin/env bash
# snapshot-redis.sh — daily Redis RDB snapshot → age-encrypted → Nevacloud
# Object Storage. Run on hara-stateful at 02:30 local (systemd timer).
#
# Redis on this stack holds the tx-broadcast queue (Redis Streams), the
# rate-limit cache and the rpc-cache (see deploy/data/docker-compose.yml). Most
# of it is reconstructable, but the Streams queue can hold not-yet-broadcast
# transactions — losing it on a host failure means silently dropping in-flight
# work. A nightly off-host RDB closes that gap.
#
# Method: `redis-cli --rdb -` asks the server for a FRESH point-in-time RDB and
# streams it to stdout — we don't read the on-disk dump.rdb (which may be stale
# between the compose `--save 60 1000` checkpoints). Stream → zstd → age, so no
# plaintext snapshot ever lands on disk.
#
# Encryption / key handling identical to the other snapshot scripts: the age
# private key lives ONLY on the operator workstation.
#
# Restore (see deploy/ops/RECOVERY.md): decrypt → place as dump.rdb in the redis
# volume while the container is stopped → start; Redis loads it on boot.

set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required — run deploy/ops/backup-setup.sh on operator workstation}"

REDIS_CONTAINER="${REDIS_CONTAINER:-hara-redis}"
TODAY=$(date +%F)
BACKUP_DIR="/var/backups/hara/redis"
OUT="${BACKUP_DIR}/redis-${TODAY}.rdb.zst.age"
REMOTE="${REDIS_REMOTE:-nevacloud-s3:hara-backups-redis}"
LOCAL_KEEP="${REDIS_LOCAL_KEEP:-7}"
REMOTE_KEEP_DAYS="${REDIS_REMOTE_KEEP_DAYS:-30}"

command -v age >/dev/null || { echo "✗ age not installed (apt install age)"; exit 1; }
command -v zstd >/dev/null || { echo "✗ zstd not installed (apt install zstd)"; exit 1; }

# Optional AUTH (compose currently sets no requirepass, but support it for the day
# we add one). REDIS_PASSWORD comes from the env file if present.
AUTH_ARGS=()
[ -n "${REDIS_PASSWORD:-}" ] && AUTH_ARGS=(--no-auth-warning -a "$REDIS_PASSWORD")

mkdir -p "$BACKUP_DIR"

echo "▶ [$(date -u +%FT%TZ)] Dumping + encrypting Redis RDB from $REDIS_CONTAINER ..."
# redis-cli --rdb - writes the RDB payload to stdout and progress to stderr;
# drop stderr so only the binary RDB reaches the pipe.
docker exec "$REDIS_CONTAINER" redis-cli "${AUTH_ARGS[@]}" --rdb - 2>/dev/null \
  | zstd -3 -T0 \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  > "$OUT"
chmod 600 "$OUT"
# Guard against an empty/truncated snapshot (e.g. AUTH failure swallowed by the
# stderr redirect) silently passing as success.
[ -s "$OUT" ] || { echo "✗ snapshot is empty — Redis dump failed (auth? container down?)"; rm -f "$OUT"; exit 1; }
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
ls -1t "$BACKUP_DIR"/redis-*.rdb.zst.age 2>/dev/null | tail -n "+$((LOCAL_KEEP + 1))" | xargs -r rm -f

echo "✓ Redis snapshot complete ($(date -u +%FT%TZ))"
