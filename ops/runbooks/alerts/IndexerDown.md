# IndexerDown

**Severity**: critical
**Tier**: services
**Page on-call?** Yes.

## What this means

Prometheus has not received `/metrics` from the indexer for over a minute. Applications relying on `indexed_events` (dashboards, public APIs, verifier flows) will see stale data, growing with every block.

## First diagnostic steps

```bash
# 1. Is the container running?
docker compose -f chain/docker-compose.yml ps | grep indexer

# 2. Why did it exit (if it did)?
docker logs --tail 50 hara-indexer

# 3. Can we reach /healthz directly?
curl -sw "HTTP %{http_code}\n" http://localhost:9100/healthz
```

## Common causes

| Cause | Action |
|---|---|
| Container in restart loop | `docker logs hara-indexer` to find the crash reason; fix and `docker start hara-indexer` |
| Postgres unreachable / over connection limit | Check `hara-postgres` health; restart indexer to release stuck conns |
| OOM killed | `docker inspect hara-indexer --format '{{.State.OOMKilled}}'`; bump memory limit |
| RPC unreachable (LB or read-pool down) | Check L1 alerts; once RPC is back, indexer auto-recovers via the orphan-recovery sweep |
| Bad ABI change deployed | `abis.ts` parse failure → check logs for "TypeError" on startup; revert the change |

## Mitigation

```bash
docker restart hara-indexer
```

The indexer's startup sequence:
1. Connects to Postgres → loads watched_contracts
2. Connects to /rpc/read → reads chain head
3. Picks up the cursor (`indexer_state.last_indexed_block`)
4. Begins polling from cursor+1

Even after a long downtime, it catches up at ~200 blocks per batch (the `BATCH_SIZE` env var). For a 1-hour outage at 2s blocks = 1800 blocks, recovery is ~9 batches = 18s.

## Root cause investigation

If the container is exiting on its own (not OOM), grep for `FATAL` or `crashed` in the logs:

```bash
docker logs hara-indexer 2>&1 | grep -iE "fatal|crashed|uncaught"
```

Common patterns:
- `connect ECONNREFUSED postgres:5432` → Postgres race on startup; usually resolved by next restart since we have `depends_on: postgres: condition: service_healthy`
- `TypeError: Cannot read property ...` → bad ABI definition; check the most recent abis.ts change
- `Out of memory` → bump container memory limit and investigate if backlog is too large

## Escalation

Page tier-2 if:
- Indexer can't stay up > 60s across multiple restart attempts
- DB or RPC issue persists after restart
- Lag > 1000 blocks even after restart

## Related alerts

- `IndexerLagHigh` / `IndexerLagCritical` — usually fire in conjunction
- `ScrapeTargetMissing` — generic version of this alert; the indexer-specific one is more actionable
