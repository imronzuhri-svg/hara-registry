# Load test scenarios — token transfers, including chained traceability

> **TL;DR for "100 hops of ERC-1155 palm-oil custody"** (measured on this stack):
>
> | Approach | 100 hops | 10K hops (projected) | Audit trail |
> |---|---|---|---|
> | **Sequential** `safeTransferFrom`, wait for each receipt | **419 seconds (~7 min)** ✓ verified | ~11 hours | 99 canonical `TransferSingle` events |
> | **Batch relay** — one tx does all N hops via `executeChain()` | **29.8 seconds** ✓ verified | ~5–10 min | 99 canonical `TransferSingle` events (identical!) |
>
> **The batch relay is 14× faster with the same RSPO audit trail.** Each hop still emits a canonical `TransferSingle` event from the ERC-1155 contract — auditors see the exact same chain of custody, just delivered in one transaction.
>
> See [scenario-palm-oil-sequential.ts](scenario-palm-oil-sequential.ts) and [scenario-palm-oil-batch-relay.ts](scenario-palm-oil-batch-relay.ts).

---

# 

Three (+1 bonus) scenarios that exercise different layers of the stack. Each works for **100 transfers** (smoke test) or **10,000 transfers** (real load) — pass the count as an argument.

## The contract under test

`TestToken` — minimal ERC-20 (`HaraTest` / `HTST`), 1M supply minted to the deployer. Deployed via `forge script script/DeployTestToken.s.sol`. Each "transfer" in the scenarios below is a `transfer(recipient, 1 HTST)` call.

```
Address: 0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0   (on dev chain)
Sender:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   (Foundry anvil #0)
```

If you redeploy, the address changes — set `TOKEN_ADDRESS` as an env var or update the scripts.

> **⚠ Deployer key changed (2026-05-28).** Anvil #0 (`0xf39Fd6…92266`) was the
> funded deployer for these scripts, but it was **drained to 1 wei and stripped
> of all roles** during the platform admin rotation. Its ~9799 HARA moved to the
> new admin. **The scripts still DEFAULT to anvil #0, which is now empty** — any
> run without an override fails at funding/priming.
>
> Use a dedicated funded load-test deployer instead (keeps the admin key out of
> test churn):
> ```bash
> # one-time: generate + fund a test deployer from the new admin
> cast wallet new --json | jq 'if type=="array" then .[0] else . end' > ~/hara-ops/loadtest-deployer.json
> chmod 600 ~/hara-ops/loadtest-deployer.json
> LT_ADDR=$(jq -r .address ~/hara-ops/loadtest-deployer.json)
> NEW_ADMIN_KEY=$(jq -r 'if type=="array" then .[0] else . end | .private_key' ~/hara-ops/new-admin-2026-05-27.json)
> cast send --private-key $NEW_ADMIN_KEY --rpc-url https://rpc.ledger.haratrust.io/write/ \
>   --chain 131216 --gas-price 0 --legacy $LT_ADDR --value 1000ether
>
> # each session: export the key so scripts pick it up via ${DEPLOYER_PRIVATE_KEY:-…}
> export DEPLOYER_PRIVATE_KEY=$(jq -r .private_key ~/hara-ops/loadtest-deployer.json)
> ```
> All `scenario-*.ts` and `single-tx.ts` read `DEPLOYER_PRIVATE_KEY` (and
> `RPC_WRITE_URL` / `RPC_READ_URL`) from env.

## The 3 scenarios at a glance

| | Path | What it stresses | Realistic 10K time | Bottleneck |
|---|---|---|---|---|
| **A — Sequential via signer** | POST `/v1/tx` → wait for CONFIRMED → next | **End-to-end correctness** (nonce, sign, queue, broadcast, indexer) | ~11 hours @ 4s/tx | Block time |
| **B — Burst via signer** | POST `/v1/tx` × N concurrently → wait once | Signer's **nonce manager under contention** + queue depth + broadcaster throughput | ~5–10 min | Broadcaster + Postgres write rate |
| **C — Pre-signed batch via direct RPC** | Pre-sign N txs offline → `eth_sendRawTransaction` flood | **Maximum chain throughput** (mempool + QBFT block size) | ~1–3 min | Besu mempool + block production |
| **D (bonus) — Multi-wallet via signer** | N wallets × M tx parallel through signer | Multi-tenant signer + per-wallet nonce isolation | ~3–5 min | Mostly Postgres FK contention |

If you only run one, run **B** — it's the most realistic stress test for the *deployed system as a whole* (signer pipeline being the throughput-limiting factor in production, not the chain itself).

## Files

```
ops/load-tests/
├── README.md                              # this file
├── scenario-a-sequential.sh               # one-by-one through signer, waits for each
├── scenario-b-burst.sh                    # N concurrent POSTs, then wait for all
├── scenario-c-direct-rpc.ts               # pre-sign offline, flood /rpc/write
├── scenario-d-multiwallet.sh              # bonus: parallel multi-wallet
└── report.sh                              # post-run summary query
```

## Running them

### Prerequisites

The whole hara-ledger stack must be up:
```bash
make platform-up
make bootstrap
make up
make deploy            # deploys ContractRegistry/Anchor/Governance
# Then deploy the test token (one-time):
cd contracts && forge script script/DeployTestToken.s.sol:DeployTestToken \
  --rpc-url http://localhost:8545/rpc/write --broadcast --legacy --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Scenario A — Sequential (good for first run)

```bash
cd ops/load-tests
./scenario-a-sequential.sh 100       # smoke test
./scenario-a-sequential.sh 10000     # full run
```

What you'll see: one tx every ~2–4 seconds. 100 transfers ≈ 5–7 minutes. 10K = several hours. The pace is set by chain block time, not pipeline capacity.

**Use this when**: you suspect a correctness bug and want each tx fully observed end-to-end before moving on.

### Scenario B — Burst (good for stress)

```bash
./scenario-b-burst.sh 100            # fires 100 in parallel, waits, reports
./scenario-b-burst.sh 10000          # ~5–10 min
```

What you'll see: 100 POSTs fire in <2 seconds, then the script polls until all are CONFIRMED. The signer's nonce manager serializes them automatically (sequential nonces, no conflicts). The broadcaster drains the queue at chain block-time pace.

**Use this when**: you want to verify the production pipeline can sustain a realistic burst (e.g., end-of-month batch certificate minting).

### Scenario C — Pre-signed batch (max throughput)

```bash
./scenario-c-direct-rpc.ts 100
./scenario-c-direct-rpc.ts 10000
```

What you'll see: all 10K txs pre-signed offline in TypeScript (takes ~10s), then flooded into the write RPC. Besu queues them in its mempool and the validators mine them as fast as QBFT allows (~100–200 TPS).

**Use this when**: you want to measure the chain's raw throughput separately from your application code. Establishes the upper bound that B can never beat.

### Scenario D — Multi-wallet (bonus, complex setup)

```bash
./scenario-d-multiwallet.sh 10000      # uses 10 wallets × 1000 each
```

Requires pre-funded secondary wallets in Vault. The script's `--setup` flag does this for you on first run.

**Use this when**: you want to verify the signer holds up with concurrent activity from different tenants.

## During the run — what to watch

Open **two terminals** alongside the test:

**1. Grafana dashboards** at http://localhost:3200
- "HaraLedger — Indexer (L3)": watch `hara_indexer_lag_blocks` — should stay near 0
- "HaraLedger — Besu overview": watch block production rate — should hold at ~2s
- "HaraLedger — Fleet overview": active alerts; if any fire, that's the failure point

**2. Live broadcast log** (Scenarios A, B, D):
```bash
docker logs -f hara-broadcaster | grep -E "broadcasted|confirmed|RETRYING|FAILED"
```

## After the run — `report.sh`

```bash
./report.sh
```

Outputs:
- Total tx count, success rate, reverted/failed breakdown
- p50/p95/p99 latency (DRAFT → CONFIRMED time)
- Avg gas used
- Block range covered
- Indexer lag at end of run

This is the same query you'd use after a production load event.

## Scaling 100 → 10,000

The scripts take a count argument; **no other changes needed up to 10,000**. Beyond that:

| Count | Bottleneck you'll hit | Tuning |
|---|---|---|
| ≤ 1,000 | None | – |
| 1,000–10,000 | Postgres connection pool under burst | Bump `POSTGRES_POOL_MAX` in `services/shared/src/db.ts` (currently 10) |
| 10,000–100,000 | Indexer batch size + memory | Increase `BATCH_SIZE=500` env on indexer + add `POOL_SIZE=20` |
| > 100,000 | Block gas limit (each block ~250 transfers @ 200 TPS) | Need ClickHouse for analytics (L9), not Postgres |

## Cleaning up after a run

These tests **don't break anything** — they just produce a lot of confirmed transactions in the `transactions` and `indexed_events` tables. If you want to reset:

```bash
docker exec hara-postgres psql -U hara -d hara_indexer -c \
  "TRUNCATE transactions, tx_attempts, indexed_events, indexed_blocks;
   UPDATE indexer_state SET last_indexed_block = -1 WHERE id = 1;
   UPDATE wallet_nonces SET last_reserved = -1, last_confirmed = -1;"

docker restart hara-indexer hara-broadcaster hara-signer
```

The chain itself keeps its history — only the app-tier views are reset.

---

# Palm-oil traceability chain (ERC-1155, RSPO-compliant)

Real palm-oil custody modeled as an ERC-1155 (`HaraPalmOil` contract). Each batch has on-chain metadata (RSPO certificate hash, plantation ID, production date) and the token amount represents liters. Each custody handover is a real `safeTransferFrom` emitting a `TransferSingle` event — the canonical audit trail RSPO Segregated supply chains require.

## Measured results (both scenarios verified on this stack)

### Approach 1: Sequential `safeTransferFrom`, wait for each receipt

```
═══ PALM-OIL SEQUENTIAL (ERC-1155) — 100 hops ═══
  Phase 2a (prime native HARA × 100):  11.8s
  Phase 2b (mintBatch):                 4.1s
  Phase 3 (99 hops × ~4s):            403.1s
  Total:                              419.1s
  Final custodian: 900 L  ✓
```

- Each hop is a separate tx: `safeTransferFrom(wallet[i], wallet[i+1], batchId, 900, "")`
- Wait for receipt before next hop (Besu QBFT requires this — see "Why we can't flood mempool" below)
- ~4 seconds per hop, dominated by chain block time

### Approach 2: Batch relay — N hops in 1 tx

```
═══ PALM-OIL BATCH RELAY (ERC-1155) — 100 hops in 1 tx ═══
  Phase 2a (prime native HARA × 100):    9.9s
  Phase 2b (mintBatch):                  4.1s
  Phase 2c (99 setApprovalForAll, par.): 7.2s
  Phase 3 (99 hops in 1 tx):             8.4s
  Total:                                29.8s
  Final custodian: 900 L  ✓
  Single tx gas used: 2,715,460
```

- Each holder pre-approves the relay (`setApprovalForAll(relay, true)`) — fired in parallel from 99 different wallets, all confirmed in 7.2s
- One call to `relay.executeChain(token, batchId, amount, holders[])` does all 99 hops atomically
- Each hop still emits a canonical `TransferSingle` event from the `HaraPalmOil` contract → **audit trail is identical to sequential**

### Why this matters for RSPO

The canonical audit record for ERC-1155 supply chains is the on-chain `TransferSingle` event. Both approaches emit exactly the same chain of these events. The batch relay just packages them into one transaction. An auditor querying the chain sees:

```
TransferSingle(operator=relay, from=wallet[0], to=wallet[1], id=batchId, amount=900)
TransferSingle(operator=relay, from=wallet[1], to=wallet[2], id=batchId, amount=900)
...
TransferSingle(operator=relay, from=wallet[98], to=wallet[99], id=batchId, amount=900)
```

The `operator` field is the relay (vs the holder themselves in the sequential case), but the **chain of custody** is fully preserved. The Foundry test `test_RelayEmits4TransferSingleEvents` asserts this invariant.

## Scaling projection — 10,000 hops

| Phase | Sequential | Batch relay |
|---|---|---|
| Prime native HARA × 10K | ~16 min (10K sequential nonces from deployer) | same |
| mintBatch (1 tx) | 4s | 4s |
| Approvals × 10K (parallel, throttled C=10) | n/a | ~12 min |
| Execution | 10K × 4s = **~11 hours** | 1 tx per ~200 hops × 50 batches × ~16s = **~14 min** |
| **Total** | **~11.5 hours** | **~42 minutes** |

The batch relay scales linearly with hop count up to per-tx gas limits (~200–500 transfers per tx). Above that, split into multiple `executeChain` calls.

## Why we can't just pre-sign and flood (mempool flood approach)

We tried. Besu QBFT's block builder does not preserve mempool insertion order strictly enough — within a single block, txs from different senders can execute in arbitrary order, breaking dependency chains. Result: ~98% revert rate.

That's why for ERC-20/ERC-1155 chained-dependency transfers, the only two correct patterns are:

1. **Sequential with receipts** (1 dependent tx at a time) — safe, slow
2. **Single atomic tx via relay** (N hops execute in deterministic order inside one tx) — safe, fast

## Files

```
contracts/src/HaraPalmOil.sol                 ERC-1155 with RSPO metadata
contracts/src/TraceabilityBatchRelay.sol      executeChain(token, batchId, amount, holders[])
contracts/script/DeployPalmOil.s.sol          Deploys both
contracts/test/HaraPalmOil.t.sol              4 tests (transfer, dup batch, relay chain, event count)

ops/load-tests/scenario-palm-oil-sequential.ts    Approach 1 (verified working)
ops/load-tests/scenario-palm-oil-batch-relay.ts   Approach 2 (verified working)
```

## Running them yourself

After the platform + hara-ledger stacks are up and contracts are deployed:

```bash
# Sequential (~7 min for 100 hops)
docker cp ops/load-tests/scenario-palm-oil-sequential.ts hara-indexer:/tmp/seq.ts
docker exec hara-indexer sh -c "cd /app/indexer && node_modules/.bin/tsx /tmp/seq.ts 100"

# Batch relay (~30 sec for 100 hops)
docker cp ops/load-tests/scenario-palm-oil-batch-relay.ts hara-indexer:/tmp/relay.ts
docker exec hara-indexer sh -c "cd /app/indexer && node_modules/.bin/tsx /tmp/relay.ts 100"
```

Pass any count: `./scenario-palm-oil-batch-relay.ts 1000` etc.

---

# Traceability chain transfer (Scenario T)

The supply-chain pattern: tokens move through a chain of distinct holders, A → B → C → ... → Z. Each hop **requires the previous hop to have completed** (B can't transfer until B has received from A). Used for palm-oil custody, halal batch chain-of-custody, etc.

## The three approaches, ranked

| Approach | 100 hops | 10K hops | Works on Besu QBFT? | Verdict |
|---|---|---|---|---|
| **A. Sequential with receipt** (implemented) | **~7 min** | **~11 hours** | ✓ verified | Slow but correct. Use for live supply chains where hops are hours/days apart anyway. |
| **B. Pre-sign and flood** (we tried; failed) | ~30s submit | – | ✗ ~98% revert rate | Doesn't work — Besu's block builder reorders txs within blocks, breaking the dependency chain. |
| **C. Batch via relay contract** (not yet built) | ~2s (1 tx) | ~200s (100 batches) | ✓ but needs new contract | Fastest. Requires a `TraceabilityRelay` contract + per-wallet `approve` or EIP-2612 Permit. |

## What we built — Approach A (the working one)

```bash
# Run from inside the indexer container (has viem + tsx ready)
docker cp ops/load-tests/scenario-traceability.ts hara-indexer:/tmp/scenario.ts
docker exec -e RPC_WRITE_URL=http://rpc-write:8545 \
            -e RPC_READ_URL=http://rpc-read-1:8545 \
            -e SEED="run-$(date +%s)" \
            hara-indexer sh -c "cd /app/indexer && node_modules/.bin/tsx /tmp/scenario.ts 100"
```

What it does:

1. **Phase 1** — derive 100 deterministic wallets from `keccak256("$SEED-$i")`
2. **Phase 2a** — deployer sends 1 wei native HARA to each wallet (Besu's block selector excludes txs from senders with 0 native balance, even at gasPrice=0)
3. **Phase 2b** — deployer transfers `INITIAL_AMOUNT` HTST to wallet[0]
4. **Phase 3** — pre-sign all 99 hop transactions offline (~10ms each)
5. **Phase 4** — for each hop: `sendRawTransaction` → `waitForTransactionReceipt` → next. This is the loop that takes 4s/hop.
6. **Phase 5/6** — verify wallet[99] has the expected balance.

Measured at 100 hops:
- Pre-sign: 1.3s
- Submit + confirm sequential: 404s (4.0s/hop average)
- Total: 426s
- Final balance check: 900 HTST at wallet[99] ✓

## Why not faster? — Approach B failure mode

We initially tried pre-signing all 99 hops then flooding them to the mempool in one go, expecting Besu to mine them in submission order. **It doesn't.** With all txs at gasPrice=0, the QBFT block builder picks them in an order that doesn't preserve mempool insertion strictly enough — wallet[5]'s tx can land in a block before wallet[3]'s, but wallet[5] won't have tokens yet, so it reverts.

We observed: 99 txs went into mempool, mined across 4 blocks, but only the first transfer (hop 0) succeeded. The other 98 reverted because they were selected out of dependency order.

**Conclusion**: pre-sign-and-flood is great for *independent* high-throughput tx loads (Scenario C in the earlier "TPS" benchmarks) but **not safe for chain-dependent transfers**.

## Approach C — the fast path that needs a contract (recommended for production)

If 4s/hop is too slow for your traceability use case (e.g., you're batch-importing historical custody records), the architectural fix is a relay contract:

```solidity
contract TraceabilityRelay {
    /// Executes a chain of transfers atomically. Each holder must have pre-approved
    /// this contract to spend tokens on their behalf (or use EIP-2612 Permit).
    function executeChain(
        IERC20 token,
        address[] calldata holders,    // [from0, from1, ..., fromN-1]
        address[] calldata recipients, // [to0, to1, ..., toN-1]
        uint256[] calldata amounts
    ) external {
        for (uint i = 0; i < holders.length; i++) {
            token.transferFrom(holders[i], recipients[i], amounts[i]);
        }
    }
}
```

Throughput: **100 hops fit in one tx in one block (~2 seconds)**. For 10K hops, split into 100 batches of 100 (gas limit caps a single tx around 100–200 transfers). Total wall time: ~200 seconds vs 11 hours sequential.

The cost: each wallet must approve the relay once. Options:
- **One-time approval**: each wallet signs a `permit` (EIP-2612) off-chain (no gas needed) and the relay batches everything in one tx. Requires the token to inherit from `ERC20Permit`.
- **Custodial relay**: tokens are held by the relay itself; "transfers" are bookkeeping in the contract's storage. Loses the "each holder is a real EOA" property but is fastest.

Not built yet — talk to me if/when traceability load becomes the bottleneck.

## When to use which

| Real-world scenario | Use |
|---|---|
| Live palm-oil shipment (hops are hours/days apart anyway) | **A — sequential** (4s is invisible) |
| Backfilling 5 years of historical custody from legacy DB | **C — batch relay** |
| Auditing a specific 10-hop chain | **A — sequential**, with custom indexing of each receipt |
| Stress test: 100 parallel supply chains × 50 hops each | **A in parallel across chains** (5K hops in ~3–4 min via parallelism, no contract needed) |

---

## What none of these test

- **Token contract correctness** under adversarial input (use Foundry fuzz tests for that)
- **Network partition tolerance** (use chaos tools like Pumba)
- **HSM signing latency** under load (we're in dev-Vault mode here)
- **Indexer reorg handling** (QBFT doesn't reorg in normal operation)

Those belong in stage-specific runbooks, not load tests.
