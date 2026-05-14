# L3 — Event indexer + Postgres state DB runbook

L3 turns the chain into searchable application data. Applications no longer query the chain directly for "show me all halal certificate issuances last week" — they query Postgres tables populated by the indexer, which has already done the ABI decoding for them.

## Topology

```
Chain (via L1 LB)                  Indexer service (10.42.0.42)              Postgres
─────────────────                  ────────────────────────────              ────────
                ◄── eth_blockNumber                                          watched_contracts ─┐
                ◄── eth_getLogs    poll every 2s                                                │
/rpc/read       ─── logs ──────►   batch up to 200 blocks                    indexer_state    ◄┘
                                   decode against AbiRegistry                indexed_blocks
                ◄── eth_getBlock    write everything in one DB tx            indexed_events
                                   advance cursor atomically
                                   expose /metrics on :9100  ──► Prometheus ──► Grafana
```

## What's new vs L2

| Component | L2 | L3 |
|---|---|---|
| Apps query chain history via | `eth_getLogs` directly | `SELECT ... FROM indexed_events` |
| Event decoding | Each app's responsibility | Centralized in indexer's ABI registry |
| Migrations | 1 file (001_init) | 2 files (002_indexer_schema added) |
| Chain restart recovery | Manual | Auto (cursor in Postgres, idempotent inserts) |
| Schema watchable | wallets, transactions | + indexed_blocks, indexed_events, watched_contracts, indexer_state |
| Prometheus metrics | Besu + HAProxy | + indexer (lag, throughput, errors) |

## Transaction lifecycle (chain → indexer)

```
1. Validator mines a block with N events
2. Indexer's poll-tick hits, sees chain_head moved
3. Indexer calls eth_getLogs(addresses=[...], from, to)
4. For each log:
     - look up contract_name from watched_contracts (by address)
     - look up ABI from in-code AbiRegistry (by contract_name)
     - try decodeEventLog → on success, store name + decoded JSONB
     - on failure (event not in our ABI), store raw topics + data only
5. Bulk-insert blocks + events + cursor advance in ONE DB transaction
```

If the indexer crashes anywhere in step 5, the whole batch is rolled back. On restart it re-fetches the same range — `INSERT ... ON CONFLICT DO NOTHING` makes this idempotent.

## Bring-up

```bash
# Build the indexer image (and re-build migrate if you added a new SQL file)
docker compose -f chain/docker-compose.yml --env-file chain/.env build migrate indexer

# Apply new migration
docker compose -f chain/docker-compose.yml --env-file chain/.env run --rm migrate

# Start the indexer
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d indexer
```

Health probes:
```bash
curl http://localhost:9100/healthz     # → {"ok":true}
curl http://localhost:9100/metrics     # Prometheus exposition
```

## Adding a new contract to watch

```sql
-- 1. Add the row in Postgres
INSERT INTO watched_contracts (contract_address, name, from_block)
  VALUES ('0xabcdef...', 'MyNewContract', 12345);
```

```typescript
// 2. Add the events to services/indexer/src/abis.ts
export const AbiRegistry = {
  // ...existing...
  MyNewContract: parseAbi([
    "event MyEvent(address indexed who, uint256 amount)",
  ]),
};
```

```bash
# 3. Rebuild + restart indexer
docker compose -f chain/docker-compose.yml --env-file chain/.env build indexer
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d --no-deps indexer
```

Optional: reset the cursor to re-index from a specific block:
```sql
UPDATE indexer_state SET last_indexed_block = 1000 WHERE id = 1;
```

## L3 exit criteria

- [ ] `GET /healthz` returns `{"ok":true}`
- [ ] `GET /metrics` exposes `hara_indexer_last_indexed_block`, `chain_head_block`, `lag_blocks`
- [ ] Indexer lag stays ≤ 3 blocks under normal load
- [ ] Deploying contracts via `/rpc/write` results in decoded `ContractRegistered` + `ActiveVersionChanged` rows in `indexed_events` within ~10 seconds
- [ ] Events from contracts whose ABI is NOT in `AbiRegistry` are stored raw (event_name=NULL, decoded=NULL) — not lost
- [ ] **Indexer kill mid-stream: an event emitted while indexer is down is captured on restart** (chaos test verified ✓)
- [ ] Re-running `migrate` with no new SQL files is a no-op (`skip (already applied)`)
- [ ] Grafana "HaraLedger — Indexer (L3)" dashboard shows live lag + event rate

## End-to-end verification commands

### Submit a tx that emits an event, then query Postgres

```bash
# Call setEmergencyPause(true) on GovernanceContract
docker run --rm --network hara-chain \
  --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  send <GovernanceContractAddress> "setEmergencyPause(bool)" "true" \
    --rpc-url http://lb:8545/rpc/write \
    --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --legacy

# Watch the indexer pick it up
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT block_number, event_name, decoded FROM indexed_events
   WHERE event_name = 'EmergencyPauseChanged' ORDER BY block_number DESC LIMIT 1"
```

### Aggregate query (the point of L3)

```sql
-- Total events per contract per day
SELECT
  date_trunc('day', to_timestamp(b.timestamp_unix)) AS day,
  e.contract_name,
  e.event_name,
  count(*)
FROM indexed_events e
JOIN indexed_blocks b USING (block_number)
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;
```

### Chaos test (kill indexer mid-stream)

```bash
# Snapshot indexer state
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT last_indexed_block, count FROM indexer_state, (SELECT count(*) FROM indexed_events) t"

# Kill
docker stop hara-indexer

# Emit an event on chain while indexer is down
docker run --rm --network hara-chain --entrypoint cast \
  ghcr.io/foundry-rs/foundry:latest send <GovernanceContract> "setEmergencyPause(bool)" "false" \
  --rpc-url http://lb:8545/rpc/write \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --legacy

# Restart — event should appear in indexed_events within ~10s
docker start hara-indexer
sleep 10
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT block_number, event_name, decoded FROM indexed_events
   WHERE event_name='EmergencyPauseChanged' ORDER BY block_number DESC LIMIT 5"
```

## Common issues

### "No events showing up after deploy"

The deployed contract addresses don't match `watched_contracts` rows. This happens after a chain wipe because deployer nonce resets but `watched_contracts` still has old addresses, or after a re-deploy where the deployer's nonce advanced.

Fix:
```sql
DELETE FROM watched_contracts;
INSERT INTO watched_contracts (contract_address, name) VALUES
  ('<actual-deployed-address>', 'ContractRegistry'),
  ...;
UPDATE indexer_state SET last_indexed_block = -1 WHERE id = 1;
```
Then `docker restart hara-indexer`.

You can read the actual deployed addresses from `contracts/broadcast/Deploy.s.sol/131216/run-latest.json`.

### "Indexer lag growing unbounded"

Usually means the indexer is hitting the RPC and either:
- Getting throttled by HAProxy's rate limit → check `/stats` for HTTP 429s
- RPC node is down → check HAProxy backend status
- DB writes are slow → check `hara_indexer_batch_duration_ms`

### "event_name = NULL for events I expected to be decoded"

The ABI signature doesn't match what was emitted. Check:
1. The event is listed in `services/indexer/src/abis.ts` under the right contract name
2. The signature exactly matches (param types, indexed-ness)
3. You rebuilt the indexer image after editing abis.ts

The raw `topics` + `data` are still stored, so no data is lost — you can re-decode after fixing the ABI.

## What L3 does NOT include

Deferred to later stages:

- **Reorg handling** — QBFT has instant finality so reorgs don't happen in normal operation, but the schema supports it. Active reorg detection lands in P2 when multi-chain anchoring is wired.
- **ClickHouse for analytics** — Postgres handles current state + history fine up to ~100M events. Past that, lands in **L9** with ClickHouse as the analytics layer.
- **WebSocket subscriptions** — current model is polling. Real-time push streams land in P1 when WebSocket RPC is added to the LB.
- **Per-event-type derived tables** — e.g., a `token_transfers` table that joins TransferSingle/TransferBatch into one view. Lands per-contract as those contracts deploy (DID, certificates, etc.) — not in core infra.
- **Backfill UI** — manual SQL `UPDATE indexer_state SET last_indexed_block = N` for now. Admin endpoint lands in P1.
- **Multi-instance indexer** — single writer for now. Sharded indexers with leader-elected coordination land in P2 (when chain throughput justifies it).

## Files added in L3

```
services/migrations/002_indexer_schema.sql         schema + watched_contracts seed
services/indexer/                                  new service
  package.json
  tsconfig.json
  Dockerfile
  src/config.ts                                    polling tuning
  src/abis.ts                                      AbiRegistry (parseAbi from viem)
  src/metrics.ts                                   prom-client gauges + counters
  src/index.ts                                     main loop: poll → getLogs → decode → upsert → checkpoint
services/package.json                              workspace adds "indexer"
services/pnpm-workspace.yaml                       workspace adds "indexer"
chain/docker-compose.yml                           adds indexer service (10.42.0.42, :9100)
chain/prometheus.yml                               scrapes indexer:9100/metrics
chain/grafana/provisioning/dashboards/indexer.json indexer dashboard
ops/runbooks/L3-indexer.md                         this file
```

## Next stage

L0 → L1 → L2 → **L3 ✔**.

**L4 — Monitoring stack expansion**: custom Besu/RPC/pipeline/indexer exporters, alert rules, on-call runbook structure. Most of the metrics infrastructure is already in place from L0–L3; L4 formalizes the alerting + dashboarding.
