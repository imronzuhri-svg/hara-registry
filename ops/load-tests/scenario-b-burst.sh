#!/usr/bin/env bash
# Scenario B — Burst submission via the signer.
# Fires N requests in parallel, then waits for all to terminalize.
#
# Usage:  ./scenario-b-burst.sh [COUNT]   (default 100)
#
# What this tests:
#   - Signer nonce manager under concurrent contention (serialized via FOR UPDATE)
#   - Redis Streams queue depth (XADD throughput, XREADGROUP fairness)
#   - Broadcaster sustained throughput
#   - Postgres connection pool under burst

set -euo pipefail

COUNT=${1:-100}
SIGNER=${SIGNER_URL:-http://localhost:7000}
FROM=${FROM_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}
TOKEN=${TOKEN_ADDRESS:-0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0}
RECIPIENT=${RECIPIENT_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}
CONCURRENCY=${CONCURRENCY:-20}        # parallel requests in flight at once
TRANSFER_DATA="0xa9059cbb000000000000000000000000${RECIPIENT:2}0000000000000000000000000000000000000000000000000de0b6b3a7640000"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

START_TS=$(date +%s)

echo "═══════════════════════════════════════════════════════════════"
echo "  Scenario B — Burst, $COUNT transfers (concurrency=$CONCURRENCY)"
echo "═══════════════════════════════════════════════════════════════"
echo "▶ Phase 1: submitting $COUNT requests in parallel..."

submit_one() {
  local i=$1
  local resp
  resp=$(curl -sS -X POST "$SIGNER/v1/tx" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"$FROM\",\"to\":\"$TOKEN\",\"data\":\"$TRANSFER_DATA\"}")
  echo "$resp" | grep -oE '"txId":"[^"]+"' | sed 's/"txId":"//;s/"//' >> "$TMPDIR/tx_ids.txt" 2>/dev/null || \
    echo "submit-error: $resp" >&2
}
export -f submit_one
export SIGNER FROM TOKEN TRANSFER_DATA TMPDIR

# xargs -P fans out CONCURRENCY parallel curls
seq 1 $COUNT | xargs -P "$CONCURRENCY" -I {} bash -c 'submit_one "$@"' _ {}

SUBMITTED=$(wc -l < "$TMPDIR/tx_ids.txt")
SUBMIT_TS=$(date +%s)
SUBMIT_ELAPSED=$((SUBMIT_TS - START_TS))
echo "  ✔ Submitted $SUBMITTED in ${SUBMIT_ELAPSED}s"

echo "▶ Phase 2: waiting for all to reach a terminal state..."

SUCCESS=0
FAILED=0
TOTAL=$SUBMITTED
LAST_REPORT=$(date +%s)

while true; do
  # Count terminal txs
  CONFIRMED=$(curl -sS "$SIGNER/v1/tx/$(head -1 $TMPDIR/tx_ids.txt)" >/dev/null 2>&1 && \
    docker exec hara-postgres psql -U hara -d hara_indexer -tA -c \
      "SELECT count(*) FROM transactions WHERE tx_id IN ($(cat $TMPDIR/tx_ids.txt | sed \"s/.*/'&'/\" | paste -sd,)) AND status = 'CONFIRMED'" \
      2>/dev/null || echo 0)
  TERMINAL=$(docker exec hara-postgres psql -U hara -d hara_indexer -tA -c \
    "SELECT count(*) FROM transactions WHERE tx_id IN ($(cat $TMPDIR/tx_ids.txt | sed \"s/.*/'&'/\" | paste -sd,)) AND status IN ('CONFIRMED','REVERTED','FAILED')" \
    2>/dev/null || echo 0)

  NOW=$(date +%s)
  if [ "$((NOW - LAST_REPORT))" -ge 10 ]; then
    echo "  [$((NOW - START_TS))s] confirmed=$CONFIRMED terminal=$TERMINAL/$TOTAL"
    LAST_REPORT=$NOW
  fi

  if [ "$TERMINAL" -ge "$TOTAL" ]; then
    SUCCESS=$CONFIRMED
    FAILED=$((TERMINAL - CONFIRMED))
    break
  fi

  sleep 2
done

ELAPSED=$(( $(date +%s) - START_TS ))
TPS=$(awk "BEGIN{printf \"%.2f\", $SUCCESS / $ELAPSED}")

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  DONE — $SUCCESS / $TOTAL confirmed, $FAILED failed"
echo "  Submit phase: ${SUBMIT_ELAPSED}s  (${COUNT} POSTs)"
echo "  Total elapsed: ${ELAPSED}s   Effective rate: ${TPS} tx/s"
echo "  Run ./report.sh for a full breakdown."
echo "═══════════════════════════════════════════════════════════════"
