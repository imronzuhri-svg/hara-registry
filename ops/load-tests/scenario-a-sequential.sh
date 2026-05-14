#!/usr/bin/env bash
# Scenario A — Sequential token transfers through the signer API.
# Each tx waits for CONFIRMED before submitting the next.
#
# Usage:  ./scenario-a-sequential.sh [COUNT]   (default 100)
#
# What this tests:
#   - Nonce manager (each call hits chain → reserve → DB)
#   - Signer → broadcaster handoff
#   - Receipt polling
#   - End-to-end correctness — if any tx fails or stalls, the script exits

set -euo pipefail

COUNT=${1:-100}
SIGNER=${SIGNER_URL:-http://localhost:7000}
FROM=${FROM_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}
TOKEN=${TOKEN_ADDRESS:-0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0}
RECIPIENT=${RECIPIENT_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}

# ABI-encoded calldata for `transfer(address,uint256)` with recipient + 1 token (1e18 wei)
# selector: 0xa9059cbb
TRANSFER_DATA="0xa9059cbb000000000000000000000000${RECIPIENT:2}0000000000000000000000000000000000000000000000000de0b6b3a7640000"

START_TS=$(date +%s)
SUCCESS=0
FAILED=0

echo "═══════════════════════════════════════════════════════════════"
echo "  Scenario A — Sequential, $COUNT transfers"
echo "  Signer:    $SIGNER"
echo "  Token:     $TOKEN"
echo "  From:      $FROM"
echo "  Recipient: $RECIPIENT"
echo "═══════════════════════════════════════════════════════════════"

for i in $(seq 1 $COUNT); do
  RESP=$(curl -sS -X POST "$SIGNER/v1/tx" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"$FROM\",\"to\":\"$TOKEN\",\"data\":\"$TRANSFER_DATA\"}")
  TX_ID=$(echo "$RESP" | grep -oE '"txId":"[^"]+"' | sed 's/"txId":"//;s/"//')

  if [ -z "$TX_ID" ]; then
    echo "[$i/$COUNT] ✗ submit failed: $RESP"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Wait for CONFIRMED (or terminal failure)
  while true; do
    STATUS=$(curl -sS "$SIGNER/v1/tx/$TX_ID" | grep -oE '"status":"[^"]+"' | head -1 | sed 's/"status":"//;s/"//')
    case "$STATUS" in
      CONFIRMED)   SUCCESS=$((SUCCESS + 1)); break ;;
      REVERTED|FAILED) FAILED=$((FAILED + 1)); echo "[$i/$COUNT] tx $TX_ID terminal state: $STATUS"; break ;;
      *)           sleep 1 ;;
    esac
  done

  if [ $((i % 10)) -eq 0 ]; then
    ELAPSED=$(( $(date +%s) - START_TS ))
    echo "[$i/$COUNT] success=$SUCCESS failed=$FAILED elapsed=${ELAPSED}s"
  fi
done

ELAPSED=$(( $(date +%s) - START_TS ))
TPS=$(awk "BEGIN{printf \"%.2f\", $SUCCESS / $ELAPSED}")

echo
echo "═══════════════════════════════════════════════════════════════"
echo "  DONE — $SUCCESS / $COUNT succeeded, $FAILED failed"
echo "  Elapsed: ${ELAPSED}s   Effective rate: ${TPS} tx/s"
echo "  Run ./report.sh for a full breakdown."
echo "═══════════════════════════════════════════════════════════════"
