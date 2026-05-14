#!/usr/bin/env bash
# Post-run summary. Queries Postgres for the most recent N transactions and
# reports success rate, latency percentiles, gas, block range, indexer lag.
#
# Usage:  ./report.sh [LIMIT]   (default 10000 — covers a 10K run)

set -euo pipefail
LIMIT=${1:-10000}

docker exec -i hara-postgres psql -U hara -d hara_indexer <<SQL
\timing off
\echo
\echo === Last ${LIMIT} transactions: status breakdown ===
SELECT status, count(*)
  FROM (SELECT * FROM transactions ORDER BY created_at DESC LIMIT ${LIMIT}) t
 GROUP BY status
 ORDER BY count DESC;

\echo
\echo === DRAFT → CONFIRMED latency percentiles (ms) ===
SELECT
  percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000) AS p99_ms,
  MIN(EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000)::INT AS min_ms,
  MAX(EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000)::INT AS max_ms,
  AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at)) * 1000)::INT AS avg_ms
  FROM (SELECT * FROM transactions ORDER BY created_at DESC LIMIT ${LIMIT}) t
 WHERE status = 'CONFIRMED';

\echo
\echo === Gas + block coverage ===
SELECT
  COUNT(*)               AS tx_count,
  MIN(block_number)      AS first_block,
  MAX(block_number)      AS last_block,
  MAX(block_number) - MIN(block_number) + 1 AS block_span,
  AVG(gas_used)::INT     AS avg_gas,
  SUM(gas_used)          AS total_gas
  FROM (SELECT * FROM transactions ORDER BY created_at DESC LIMIT ${LIMIT}) t
 WHERE status = 'CONFIRMED';

\echo
\echo === Retries observed ===
SELECT retry_count, count(*)
  FROM (SELECT * FROM transactions ORDER BY created_at DESC LIMIT ${LIMIT}) t
 GROUP BY retry_count
 ORDER BY retry_count;

\echo
\echo === Indexer state now ===
SELECT
  (SELECT MAX(number) FROM (SELECT block_number AS number FROM indexed_blocks ORDER BY block_number DESC LIMIT 1) s) AS last_indexed_block,
  (SELECT last_indexed_block FROM indexer_state)                                                                       AS state_cursor;

\echo
\echo === Indexed Transfer events (token contract) ===
SELECT count(*) AS transfer_events_indexed
  FROM indexed_events
 WHERE contract_address = lower('${TOKEN_ADDRESS:-0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0}');

SQL
