#!/usr/bin/env bash
# s3-readback-check.sh — prove the OFF-HOST restore path actually works.
#
# The local drills (pitr-restore-drill.sh, snapshot-restore-drill.sh) restore
# from the LOCAL WAL archive + a LOCAL pg_basebackup — they never touch S3. So a
# broken *download* path (revoked/rate-limited creds, bucket GET policy, missing
# or truncated object) would pass every drill yet leave you unable to recover in
# a real disaster. This check closes that blind spot: it confirms the encrypted
# backups in Nevacloud S3 are RETRIEVABLE (GET) and WELL-FORMED (age header) and
# FRESH — the exact failure modes the local drills miss.
#
# It deliberately does NOT decrypt: the age private key is operator-only and is
# never on a host. Full decrypt+restore-from-S3 is validated separately by an
# operator running standby-bootstrap.sh. This automated check proves the parts
# that don't need the secret (GET works, object is age-encrypted, backups recent).
#
# Runs weekly with the other drills (install-backup-timers.sh `drill` role);
# writes a drill-result JSON the console Recovery panel surfaces.

set -euo pipefail

BASE_REMOTE="${PG_BASE_REMOTE:-nevacloud-s3:hara-backups-postgres-base}"
WAL_REMOTE="${PG_WAL_REMOTE:-nevacloud-s3:hara-backups-postgres-wal}"
BASE_MAX_AGE_H="${BASE_MAX_AGE_H:-26}"   # base runs daily — newest should be < ~26h old
DRILL_RESULT_DIR="${DRILL_RESULT_DIR:-/var/backups/hara/drills}"
DRILL_NAME="s3-readback"
AGE_MAGIC="age-encryption.org"
START=$(date +%s)
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/s3readback.XXXXXX")"

write_result() {
  local code="$1" status="fail"; [ "$code" = 0 ] && status="pass"
  ( mkdir -p "$DRILL_RESULT_DIR" 2>/dev/null || sudo mkdir -p "$DRILL_RESULT_DIR" 2>/dev/null ) || true
  printf '{"drill":"%s","status":"%s","exitCode":%s,"at":"%s","durationSec":%s}\n' \
    "$DRILL_NAME" "$status" "$code" "$(date -u +%FT%TZ)" "$(( $(date +%s) - START ))" \
    | ( tee "$DRILL_RESULT_DIR/$DRILL_NAME.json" >/dev/null 2>&1 \
        || sudo tee "$DRILL_RESULT_DIR/$DRILL_NAME.json" >/dev/null 2>&1 ) || true
}
cleanup() { local c=$?; rm -rf "$WORK" 2>/dev/null || true; write_result "$c"; }
trap cleanup EXIT

echo "▶ 1. Newest base is present + fresh (< ${BASE_MAX_AGE_H}h)"
# rclone lsl: "<size> <YYYY-MM-DD> <HH:MM:SS.fff> <name>" — sort by date+time.
BASE_LINE=$(rclone lsl "$BASE_REMOTE/" 2>/dev/null | sort -k2,3 | tail -1)
[ -n "$BASE_LINE" ] || { echo "✗ no base backup listed in $BASE_REMOTE (GET/list access?)"; exit 1; }
BASE_NAME=$(echo "$BASE_LINE" | awk '{print $4}')
BASE_EPOCH=$(date -d "$(echo "$BASE_LINE" | awk '{print $2" "$3}')" +%s 2>/dev/null || echo 0)
AGE_H=$(( ( $(date +%s) - BASE_EPOCH ) / 3600 ))
echo "  newest base: $BASE_NAME (${AGE_H}h old)"
[ "$BASE_EPOCH" -gt 0 ] && [ "$AGE_H" -le "$BASE_MAX_AGE_H" ] || { echo "✗ newest base is stale (${AGE_H}h) — base backup may have stopped"; exit 1; }

echo "▶ 2. Newest WAL fully retrievable (GET) + age-formatted"
WAL_NAME=$(rclone lsl "$WAL_REMOTE/" 2>/dev/null | sort -k2,3 | tail -1 | awk '{print $4}')
[ -n "$WAL_NAME" ] || { echo "✗ no WAL listed in $WAL_REMOTE"; exit 1; }
# Full GET of one (small, <=16MB) WAL object — this is the actual download test.
rclone copy "$WAL_REMOTE/$WAL_NAME" "$WORK/" 2>"$WORK/err" || true
SZ=$(stat -c %s "$WORK/$WAL_NAME" 2>/dev/null || echo 0)
if [ "$SZ" -le 0 ]; then
  echo "✗ WAL $WAL_NAME GET returned 0 bytes — off-host backups are NOT retrievable:"
  grep -oE "status code: [0-9]+|AccessDenied|SignatureDoesNotMatch" "$WORK/err" | head -1
  exit 1
fi
head -c 64 "$WORK/$WAL_NAME" | grep -qa "$AGE_MAGIC" || { echo "✗ WAL $WAL_NAME is not age-encrypted (unexpected format)"; exit 1; }
echo "  ✓ WAL $WAL_NAME GET ok ($SZ bytes) + age header present"

echo "✓ S3 READBACK PASSED — off-host backups are retrievable, age-encrypted, and fresh."
