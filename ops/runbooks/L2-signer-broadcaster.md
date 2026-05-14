# L2 — Signer + nonce manager + queue + broadcaster runbook

L2 lights up the application service tier: client apps no longer talk to the chain RPC directly. Instead they POST unsigned transactions to the signer, which manages nonces, signs with a Vault-held key, and queues to a broadcaster that handles submission, receipt polling, and retries.

## Topology

```
Client app
   │
   │ POST /v1/tx  { from, to, data, value, gasLimit? }
   ▼
┌──────────────┐                       ┌──────────────┐
│  signer      │  (1) reserve nonce    │  Postgres    │
│ :7000 (10.42 │ ◄────────────────────►│ wallet_nonces│
│  .0.40)      │  (2) record tx        │ transactions │
└──────┬───────┘                       └──────────────┘
       │ (3) fetch key from Vault
       │     (in-memory cache, never disk)
       │
       │ (4) sign (legacy tx, chainId 131216, gasPrice=0)
       │
       │ (5) XADD hara:tx:outbound
       ▼
┌──────────────┐                       ┌──────────────┐
│  Redis       │ ◄───── consume ────── │ broadcaster  │
│ Streams      │      (XREADGROUP)     │ (10.42.0.41) │
└──────────────┘                       └──────┬───────┘
                                              │
                                              │ POST eth_sendRawTransaction
                                              ▼
                                       /rpc/write (via HAProxy)
                                              │
                                              │ poll eth_getTransactionReceipt every 2s
                                              ▼
                                       /rpc/read (via HAProxy)
                                              │
                                              ▼
                                       update transactions.status = CONFIRMED
```

## Transaction lifecycle

```
DRAFT  ─►  QUEUED  ─►  BROADCASTED  ─►  CONFIRMED
                                     └►  REVERTED  (mined but status=0)
   │           │
   │           ├►  RETRYING ──►  QUEUED  (with retry_count++)
   │
   └────────────►  FAILED  (sign failed, or max retries exceeded)
```

SIGNED is transient (between sign and XADD, sub-millisecond).

## What's new vs L1

| Component | L1 | L2 |
|---|---|---|
| Apps submit tx via | RPC `/rpc/write` directly (need to sign in app) | `POST /v1/tx` to signer (key stays in Vault) |
| Nonce coordination | App's problem | Centralized in Postgres `wallet_nonces` |
| Tx submission failures | App handles retry | Broadcaster retries with backoff up to 3 times |
| Tx status tracking | None — app polls RPC | `GET /v1/tx/:id` returns status + block + gas |
| Signing keys | None managed | Vault `secret/haraledger/signer-keys/<label>` |
| Postgres | Idle | Schema initialised by `migrate` one-shot |
| Redis | Idle | Hosts `hara:tx:outbound` stream + `broadcaster` consumer group |

## Bring-up

If you have L1 already running, services come up on top:

```bash
docker compose -f chain/docker-compose.yml --env-file chain/.env build migrate signer broadcaster
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d
```

The `migrate` service runs once, applies all SQL in `services/migrations/`, then exits. Both signer and broadcaster depend on `migrate: service_completed_successfully`.

If migrations were already applied and you just changed signer/broadcaster code:

```bash
docker compose -f chain/docker-compose.yml --env-file chain/.env build signer broadcaster
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d --no-deps signer broadcaster
```

## L2 exit criteria

- [ ] `GET http://localhost:7000/healthz` returns `{"ok":true}`
- [ ] `POST /v1/tx` accepts a tx and returns a UUID + `status: QUEUED`
- [ ] `GET /v1/tx/:id` shows the tx progressing DRAFT → QUEUED → BROADCASTED → CONFIRMED within ~10s
- [ ] **5 concurrent `POST /v1/tx` requests all confirm with sequential unique nonces** (chaos test)
- [ ] Killing the broadcaster mid-tx: tx stays in BROADCASTED, gets confirmed once the broadcaster restarts and resumes polling (graceful pickup via PENDING entries)
- [ ] Restart of signer doesn't drop in-flight DB records (Postgres is the source of truth, not in-memory)
- [ ] Vault key is never written to local filesystem inside any service container
- [ ] No nonce gaps or duplicates after 100 sequential tx submissions

## End-to-end verification commands

### Healthcheck

```bash
curl http://localhost:7000/healthz
```

### Submit a transaction

```bash
curl -X POST http://localhost:7000/v1/tx \
  -H "Content-Type: application/json" \
  -d '{
    "from":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "to":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "value":"1000000000000000000"
  }'
# → {"txId":"...","status":"QUEUED"}
```

### Read a transaction

```bash
curl http://localhost:7000/v1/tx/<txId>
```

### Stress test (10 concurrent)

```bash
for i in $(seq 1 10); do
  curl -s -X POST http://localhost:7000/v1/tx \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\",
         \"to\":\"0x70997970C51812dc3A010C7d01b50e0d17dc79C8\",
         \"value\":\"$i\"}" &
done
wait
sleep 20
# Verify no duplicates, no gaps:
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT nonce, status, block_number FROM transactions
   WHERE from_address='0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
   ORDER BY nonce"
```

### Vault key inspection (proof keys never touch disk)

```bash
# Vault stores the key
curl -H "X-Vault-Token: haraledger-dev-root" \
  http://localhost:8200/v1/secret/data/haraledger/signer-keys/deployer

# Signer container has NO key file
docker exec hara-signer find / -name "*.key" 2>/dev/null   # expect: nothing
docker exec hara-signer find / -name "private*" 2>/dev/null
```

### Broadcaster crash + recovery

```bash
# Submit a tx, immediately kill the broadcaster
curl -s -X POST http://localhost:7000/v1/tx -H "Content-Type: application/json" \
  -d '{"from":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","to":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","value":"42"}'
docker stop hara-broadcaster

# Check tx is stuck in QUEUED
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT status, retry_count FROM transactions ORDER BY created_at DESC LIMIT 1"

# Restart broadcaster
docker start hara-broadcaster
sleep 10

# Tx should now be CONFIRMED
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "SELECT status, block_number FROM transactions ORDER BY created_at DESC LIMIT 1"
```

## Common issues

### "Signer returns 400: unknown wallet"

The wallet isn't in the `wallets` table or its key isn't in Vault. Bootstrap via the init container adds only the default deployer. To add more wallets:

```sql
INSERT INTO wallets (address, vault_path, label)
  VALUES ('0x...', 'secret/haraledger/signer-keys/my-key', 'my service');
INSERT INTO wallet_nonces (address) VALUES ('0x...');
```

And then push the private key to Vault at that path.

### "Broadcaster keeps marking txs as FAILED with `nonce too low`"

Means the chain advanced the wallet's nonce out-of-band (e.g. someone used Foundry's `forge script` against `/rpc/write` with the same private key). Reconcile:

```sql
UPDATE wallet_nonces
   SET last_reserved = (SELECT MAX(nonce) FROM transactions
                          WHERE from_address = '0x...' AND status='CONFIRMED'),
       updated_at = now()
 WHERE address = '0x...';
```

Or just `make clean && make bootstrap` if it's dev.

### "Receipt timeout — tx submitted but never confirmed"

Usually means the tx hash returned by the RPC differs from what we signed (rare, RPC node bug). The broadcaster logs both. Or the chain stalled — check validator status.

## What L2 does NOT include

Deferred to later stages:

- **Indexing of contract events.** Transactions are tracked, but Transfer / certificate events are not extracted. Lands in L3.
- **AppRole-based Vault auth.** L2 dev uses the root token. Production needs per-service AppRoles. Wired in P1.
- **Multiple writer instances.** A single broadcaster avoids nonce coordination complexity. Multi-broadcaster with leader election lands in P1.
- **Rate limiting on the signer API.** Apply at the LB or in front of the signer via API gateway. Add when external traffic appears.
- **Tx replacement** (speed-up / cancel via same-nonce higher-gas). Not relevant on free-gas chain, but lands in P3 when migrating to Avalanche with native fees.
- **DID/Certificate domain endpoints.** L2 is generic — `POST /v1/tx` accepts any encoded calldata. Higher-level APIs (`POST /v1/certificates`) build on top of L2 and live in product roadmaps.

## Files in this stage

```
services/migrations/001_init.sql                    Postgres schema
services/migrate/                                   one-shot migration runner
services/shared/                                    common: Vault, DB, Redis, logger, types
services/signer/                                    Fastify API + nonce manager + sign
services/broadcaster/                               Redis Streams consumer + RPC submit + retry
chain/init/init.sh                                  (extended) loads signer key into Vault
chain/docker-compose.yml                            (extended) adds migrate, signer, broadcaster
ops/runbooks/L2-signer-broadcaster.md               this file
```

## Next stage

When L2 exit criteria are ticked: **L3 — Event indexer + Postgres state DB**. Indexer subscribes to chain events, decodes ABIs, populates derived tables that apps query instead of the chain directly.
