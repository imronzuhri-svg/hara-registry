# L5 — Technical explorer (Blockscout)

L5 puts a real block explorer in front of the chain so ops, devs, and reviewers can inspect blocks, transactions, contract calls, and decoded events without `cast`, `curl`, or raw SQL.

## Topology

```
Browser
   │
   │ http://localhost:4010
   ▼
┌──────────────────┐
│  Blockscout FE   │  (Next.js, port 3000 inside)
│  10.42.0.44      │
└────────┬─────────┘
         │ http://localhost:4000  (browser-side calls go here)
         │ http://blockscout:4000 (in-network)
         ▼
┌──────────────────┐         ┌──────────────────┐
│  Blockscout BE   │ ──RPC──►│  hara-lb         │
│  (Phoenix/OTP)   │         │  /rpc/read       │
│  10.42.0.43      │ ◄─WS────│  /rpc/read (ws)  │
└────────┬─────────┘         └──────────────────┘
         │
         ├── postgres :5432 / db=blockscout (shared hara-postgres)
         └── redis :6379 db=3
```

## What's new vs L4

| Component | L4 | L5 |
|---|---|---|
| Chain inspection | `cast` / `curl` / raw SQL on `indexed_events` | Web UI at http://localhost:4010 |
| Tx receipt detail | Manual `eth_getTransactionReceipt` | Decoded inputs, internal txs, logs, gas usage in UI |
| Contract verification | Source code only in repo | Verifiable via Blockscout Etherscan-compatible endpoint |
| Address page | Postgres query | Full balance / tx history / token transfers UI |
| ABI decoding | Indexer's `AbiRegistry` (limited to our contracts) | Blockscout's universal decoder + uploaded ABIs |
| Block-by-block analytics | Raw SQL | Built-in charts (daily txs, gas usage, addresses) |

## Bring-up

The L5 services were added to the existing hara-ledger compose, so a regular `make up` brings them up alongside everything else:

```bash
cd "C:/Projects/claude projects/hara-ledger"
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d \
    blockscout-db-init blockscout blockscout-fe
```

Health probes:
```bash
# Backend API (Phoenix)
curl http://localhost:4000/api/v2/stats

# Frontend (Next.js)
curl -I http://localhost:4010

# Block list via API
curl http://localhost:4000/api/v2/main-page/blocks
```

## Host endpoints

| Endpoint | URL |
|---|---|
| **Explorer UI** | http://localhost:4010 |
| Backend REST/GraphQL | http://localhost:4000/api/v2 |
| Backend OpenAPI docs | http://localhost:4000/api/v2/docs |

## L5 exit criteria

- [ ] Frontend at http://localhost:4010 loads
- [ ] Blocks list shows the current chain head
- [ ] Submitting a tx via the signer (POST /v1/tx) → the tx appears under `/api/v2/transactions/<hash>` within ~10s
- [ ] Searching by contract address (e.g. ContractRegistry) shows its tx history
- [ ] Internal transactions are visible on the tx detail page
- [ ] Backend exposes Prometheus metrics at `http://blockscout:4000/api/v2/metrics` and Prometheus is scraping (visible at http://localhost:9090/targets as job=`blockscout`)
- [ ] Killing the backend → frontend gracefully shows "no data" instead of crashing
- [ ] Restarting both → chain history fully reindexes from the cursor

## Configuration files

```
chain/blockscout/
├── envs/
│   ├── common-blockscout.env   # Backend env: DB, RPC, chain ID, secret keys
│   └── common-frontend.env     # Frontend env: API host, network name, branding
└── init-db.sh                  # One-shot script — creates 'blockscout' DB in shared postgres
```

### Adjusting the network identity (name shown in UI)

Edit `chain/blockscout/envs/common-frontend.env`:

```
NEXT_PUBLIC_NETWORK_NAME=HaraLedger
NEXT_PUBLIC_NETWORK_CURRENCY_NAME=HARA
NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL=HARA
```

Then recreate the frontend:

```bash
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d --force-recreate blockscout-fe
```

### Pointing at a different RPC

Edit `chain/blockscout/envs/common-blockscout.env`:

```
ETHEREUM_JSONRPC_HTTP_URL=http://lb:8545/rpc/read
ETHEREUM_JSONRPC_TRACE_URL=http://lb:8545/rpc/read
ETHEREUM_JSONRPC_WS_URL=ws://lb:8546/rpc/read
```

In P2 production, point at a dedicated archive node (e.g., `http://archive-1:8545`) so Blockscout doesn't share read capacity with the application indexer.

## Contract verification (optional, post-L5)

Blockscout exposes an Etherscan-compatible verification API. To verify the L0 contracts:

```bash
cd contracts

# Single-file verification (no constructor args)
docker run --rm --network hara-platform \
  -v "$(pwd -W):/work" -w //work \
  --entrypoint forge ghcr.io/foundry-rs/foundry:latest \
  verify-contract \
  <DEPLOYED_ADDR> \
  src/ContractRegistry.sol:ContractRegistry \
  --verifier blockscout \
  --verifier-url http://blockscout:4000/api \
  --constructor-args $(cast abi-encode "constructor(address)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
```

After successful verification, the contract page in Blockscout shows the source, ABI, and lets you call read/write methods directly from the UI.

This is **not** part of L5 exit criteria — it's the natural next step.

## Common issues

### "blocks API returns [] but the chain has blocks"

The backend is still in initial sync. Watch the indexer logs:
```bash
docker logs -f hara-blockscout 2>&1 | grep -E "(fetcher|catchup|realtime)"
```
Catch-up indexing through ~2000 blocks of a fresh dev chain takes 30–60 seconds.

### "Frontend container is stuck in Restarting"

The frontend's startup script (`check-envs.sh`) does strict env-variable validation. If you've added a new `NEXT_PUBLIC_*` var that isn't recognized by this image version, it exits with "Congruity check failed" / "ENVs validation failed".

Fix: read `docker logs hara-blockscout-fe` to see which var failed, then either remove it from `common-frontend.env` or set it to a valid enum value.

### "Tx submitted via signer doesn't show up in Blockscout"

Three places to look:
1. **Signer DB** — `SELECT status, tx_hash FROM transactions ORDER BY created_at DESC LIMIT 1`
2. **Chain directly** — `cast tx <hash> --rpc-url http://localhost:8545/rpc/read`
3. **Blockscout backend** — `curl http://localhost:4000/api/v2/transactions/<hash>`

If chain has it but Blockscout doesn't, the backend's realtime indexer may be lagging. Check `docker logs hara-blockscout | grep realtime`.

### "Phoenix backend crashed with `:database_connection_error`"

The `blockscout-db-init` one-shot probably didn't run, or hara-postgres wasn't healthy when Blockscout started. Fix:

```bash
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d --force-recreate \
  blockscout-db-init blockscout
```

### "RPC errors flood the backend logs"

Blockscout uses `debug_traceTransaction` for internal-tx extraction. We have DEBUG api enabled on our RPC nodes but if the call fails (e.g., backend is asking for a block that doesn't exist yet), errors get logged. Normal and harmless during catchup.

## Storage footprint

After indexing ~2000 blocks of dev chain:
- Postgres `blockscout` database: ~50 MB
- Redis cache: ~5 MB
- Blockscout container memory: ~700 MB

Production budget per million blocks: ~5 GB Postgres + ~500 MB Redis. Plan archive storage accordingly in P2.

## What L5 does NOT include

- **Stats / Visualizer microservices**: Blockscout has optional `stats`, `visualizer`, `sig-provider` and `smart-contract-verifier` services. Skipped in L5 to keep the footprint manageable. Add per project need.
- **TLS / auth**: Blockscout is internal-only at L5. P1 adds TLS termination + an authenticating reverse proxy.
- **CDN for static assets**: frontend ships with all assets at host:4010. P2 fronts it with Cloudflare for global UX.
- **Contract source upload UI**: works via the verifier API but no Etherscan-style import flow yet.
- **GraphQL endpoint**: enabled by default at `/graphql`. Not tested in L5 because the REST API covers everything we need.

## Files added in L5

```
chain/blockscout/envs/common-blockscout.env      Backend config
chain/blockscout/envs/common-frontend.env        Frontend config
chain/blockscout/init-db.sh                      One-shot DB creation
chain/docker-compose.yml                         3 new services: blockscout-db-init, blockscout, blockscout-fe
_platform/prometheus/prometheus.yml              new scrape job: blockscout
ops/runbooks/L5-blockscout.md                    this file
```

## Up next

**L6 — Multi-validator consortium**. Stand up 3 additional validators on separate Docker hosts (or simulated separate hosts via separate compose projects) to exercise QBFT under realistic operator separation. Validator onboarding flow + cross-operator monitoring.
