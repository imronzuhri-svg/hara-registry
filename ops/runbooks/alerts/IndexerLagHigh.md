# IndexerLagHigh / IndexerLagCritical

**Severity**: warning (>50 blocks) / critical (>500 blocks)
**Tier**: services

## What this means

The indexer is processing blocks slower than the chain produces them. Lag is the gap (chain head - last indexed). Dashboard data is fresh-ish at warning level; at critical level applications are using minutes-old data.

## First diagnostic steps

```bash
# Current numbers
curl -s http://localhost:9100/metrics | grep -E "hara_indexer_(last|chain|lag|batch_duration)"

# Is the indexer running at all?
docker compose -f chain/docker-compose.yml ps indexer

# Recent batch processing times
docker logs --tail 20 hara-indexer 2>&1 | grep "range indexed"
```

## Common causes

| Cause | Signal | Action |
|---|---|---|
| RPC slow (read pool degraded) | `batch_duration_ms` >5s | Check L1 alerts; if RPC is healthy but slow, restart read pool |
| Postgres write contention | DB CPU pegged; long-running query elsewhere | `pg_stat_activity` to find blockers |
| Chain producing big batches of logs | `events_indexed_total` rate is huge | Increase `BATCH_SIZE` env var (currently 200) |
| Indexer error loop | `errors_total` increasing | See IndexerErrorsFiring runbook |
| Just restarted, catching up | Lag dropping fast | Wait — should stabilize at ≤3 blocks once caught up |

## Mitigation

If catch-up is slow but progressing:
- **Increase batch size** to reduce per-tick RPC overhead:
  ```bash
  # Edit docker-compose.yml: indexer environment BATCH_SIZE=500
  docker compose -f chain/docker-compose.yml --env-file chain/.env up -d --no-deps indexer
  ```
- Reduce `POLL_INTERVAL_MS` so it ticks more frequently (default 2000).

If completely stuck:
```bash
docker restart hara-indexer
```

## Root cause investigation

Check whether the slow batch is RPC-bound or DB-bound:

```bash
# Average batch duration over last 10m
curl -s 'http://localhost:9090/api/v1/query?query=avg_over_time(hara_indexer_batch_duration_ms[10m])'

# Compare to chain block-time rate
curl -s 'http://localhost:9090/api/v1/query?query=rate(besu_blockchain_chain_head_block_number[10m])'
```

If batch duration is 2× block production rate, the indexer can never catch up — bottleneck must be removed.

For DB bottleneck:
```sql
-- Long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
  FROM pg_stat_activity
 WHERE state != 'idle'
 ORDER BY duration DESC LIMIT 10;

-- Index health
SELECT relname, n_dead_tup, n_live_tup FROM pg_stat_user_tables
 ORDER BY n_dead_tup DESC LIMIT 5;
-- VACUUM ANALYZE indexed_events;  -- if dead tuples > 10% of live
```

## Escalation

Page tier-2 if:
- Critical lag persists > 10 minutes after a restart
- Batch duration consistently > 10s
- DB CPU at 100% with no obvious blocker

## Capacity tuning thresholds

| Phase | Expected steady-state lag |
|---|---|
| P0 (1 validator, dev) | 0–3 blocks |
| P1 (4 validators, ~50 ops/sec) | 0–5 blocks |
| P2 (15 validators, ~100 ops/sec) | 0–10 blocks |
| P3 (multi-region) | 0–20 blocks |

If steady-state lag exceeds these targets, infrastructure capacity must grow — not just a tuning fix.
