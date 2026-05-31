# HaraLedger — Session State Handoff #3 (2026-05-28)

Comprehensive state-of-the-system after the long RPC reliability + scaling
investigation, the hara-did partner onboarding (twice), and the anvil-0
admin rotation. Picks up from `haraleder-vps-01.md` (state #2 was the
in-flight handoff during that session).

---

## ⚡ UPDATE 2026-06-01 — Phase 1 RPC-host migration COMPLETE

The Phase 1 migration described as priority #0 below (§17) is **done and live**.
Executed end-to-end over SSH from the operator laptop (no WSL).

**New topology (replaces the §1 / §2 "current" picture):**

| Host | Role | WG IP | Public IP |
|---|---|---|---|
| `hara-rpc-1` (NEW) | rpc-write + 2×rpc-read + HAProxy LB + autoheal | 10.43.0.21 | 103.169.206.237 |
| `hara-stateless-2` (NEW) | signer, broadcaster, indexer, rpc-cache, Blockscout BE/FE, obs, Caddy | 10.43.0.25 | 103.169.206.239 |
| `hara-stateful` | Vault / PG / Redis / MinIO | 10.43.0.40 | 103.67.244.250 (unchanged) |
| `hara-v1..v4` | validators | 10.43.0.11..14 | (unchanged) |
| ~~`hara-stateless`~~ | **DESTROYED** (was 10.43.0.20) | — | — |

- **DNS** (`rpc`/`explorer`/`grafana`) now → `103.169.206.239` (services host). `.237` is RPC-only (no public web). TTL back to 3600s.
- **hara-did partner** migrated to `http://10.43.0.21:8545/rpc/write`; verified active on `.21`, off `.20`. Packet: [haraledger-did-rpc-migration.md](haraledger-did-rpc-migration.md).
- Both new boxes were **bare** (cloud-init never applied) → bootstrapped from scratch; disk confirmed genuine NVMe (3.3–3.9 GB/s). Actual specs ran over plan: rpc-1 = 8 vCPU/23 GB/300 GB, stateless-2 = 6 vCPU/15 GB/200 GB.
- **Deviation from runbook:** indexer has no advisory lock → shared-DB writers (indexer, Blockscout, anchor-worker, signer, broadcaster) were **deferred to the cutover** (clean stop-old/start-new) instead of double-writing live Postgres during the parallel window.
- **New ops scripts (this session):** [bootstrap-newbox.sh](deploy/ops/bootstrap-newbox.sh), [wg-onboard-migration.sh](deploy/ops/wg-onboard-migration.sh), [cutover-phase-c.sh](deploy/ops/cutover-phase-c.sh), [decommission-old-stateless.sh](deploy/ops/decommission-old-stateless.sh).

**Now-open (supersedes §17 ordering):** (1) re-run 200×500 on the dedicated host; (2) harden new boxes — enable `ufw` + SSH hardening (deferred during migration to avoid lockout); (3) raise validators 8→16 GB RAM. The rest of §17 stands.

> Everything below this banner is the pre-migration 2026-05-28 handoff, kept for history. Where it conflicts with this banner, the banner wins.

---

## 0. TL;DR

- Chain still live, healthy, ~60K blocks deep on Nevacloud QBFT (chain ID **131216**, 2s blocks).
- **hara-did is a live integrated partner** (chain RPC + Postgres reader + WG mesh).
- **anvil-0 admin power has been rotated out** — new admin `0x944b237097A03E1e8CdE8A0F46605506319EC329`, anvil-0 drained to 1 wei, all 11 platform roles renounced.
- **RPC reliability root cause found and fixed** — it was Blockscout's internal-transaction fetcher hammering the read pool with `trace_block`. Disabled. Real RPC healthcheck + autoheal sidecar added for self-recovery.
- **200×500 stress test completes the workload but not the test** — software resilience is fully in place; the remaining gap is **block-import CPU contention on the shared host** (`hara-stateless` runs RPC + services + obs + edge, all fighting for CPU during 200-300M-gas blocks).
- **Decision: Phase 1 "Good" topology** — add one dedicated RPC VPS (`hara-rpc-1`), downsize the services host. Combined cutover runbook ready.
- 200×100 (19,800 events at 322 TPS) and 200×50 (9,800 at 213 TPS) **fully proven**. 200×500 partial runs reached ~90K real events. Single-block capacity observed: 45 executeChain × 499 hops = ~22K transfer events in one 2s block at ~300M gas.

---

## 1. Production deployment — current hosts

| Host | Role | WG IP | Public IP | Notes |
|---|---|---|---|---|
| `hara-stateful` | Vault Raft + Postgres + Redis + MinIO | 10.43.0.40 | 103.67.244.250 | unchanged this session |
| `hara-stateless` | RPC tier + services + obs + edge (Caddy) | 10.43.0.20 | 202.155.91.66 | **overloaded** — to be relieved in Phase 1 migration |
| `hara-v1..v4` | Besu QBFT validators | 10.43.0.11..14 | 202.155.18.234 / 103.169.206.46 / 103.169.206.127 / 160.19.166.23 | healthy, ≥3/4 quorum throughout |
| `hara-did-stg` (partner) | hara-did api-gateway + anchor-oracle | 10.43.0.50 | 103.67.244.109 | onboarded 2026-05-28 (Jakarta) |

Chain state: ~60K+ blocks, validators producing every 2s, 4/4 healthy.

---

## 2. Architecture — current and planned

### Current (today)

```
WG mesh 10.43.0.0/24, docker bridge 10.42.0.0/24

┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ hara-v1 .11  │  │ hara-v2 .12  │  │ hara-v3 .13  │  │ hara-v4 .14  │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
┌──────────────────────┐     ┌──────────────────────────────────────────┐
│ hara-stateful .40    │     │ hara-stateless .20  (overloaded)          │
│ Vault / PG / Redis / │     │ rpc-write + 2×rpc-read + lb + rpc-cache + │
│ MinIO                │     │ signer + broadcaster + indexer + Caddy +  │
└──────────────────────┘     │ Blockscout BE/FE + Prom/Graf/Loki/AM      │
                             └──────────────────────────────────────────┘
                                                  ▲
                                                  │ WG peer
                                       ┌──────────────────────┐
                                       │ hara-did-stg .50     │  (partner)
                                       │ api-gateway +        │
                                       │ anchor-oracle        │
                                       └──────────────────────┘
```

### Phase 1 target (the decided next step)

Same picture, but split `hara-stateless` into two boxes:

```
hara-rpc-1 (NEW, 8 vCPU / 16 GB / 200 GB NVMe)
  ↳ rpc-write + 2×rpc-read + lb + autoheal
  ↳ WG IP 10.43.0.21

hara-stateless-2 (4 vCPU / 16 GB / 200 GB NVMe — replaces hara-stateless)
  ↳ signer + broadcaster + indexer + rpc-cache + Blockscout BE/FE + obs + Caddy
  ↳ WG IP 10.43.0.25 (during parallel-run; old .20 decommissioned)
```

Migration is a **single-window combined cutover** — both new boxes brought up in parallel, one DNS/Caddy switch, decommission old. Fully reversible until decommission. Runbook: [deploy/runbook-rpc-host-migration.md](deploy/runbook-rpc-host-migration.md).

### Phase 2 (later, when load/HA demands)

Split write onto its own host (`hara-rpc-w`) with reads on `hara-rpc-r`, HAProxy `balance source` for sender affinity. Design + sizing: [deploy/rpc-scaling-design.md](deploy/rpc-scaling-design.md).

---

## 3. Network split (critical, unchanged)

```
WG mesh:        10.43.0.0/24   (cross-host service endpoints)
Docker bridge:  10.42.0.0/24   (container-local per host only)
```

- Intra-host: docker DNS (`vault`, `postgres`, etc.)
- Cross-host: `<remote-host-wg-ip>:<port>`
- Services on hara-stateful bind to wg-IP for cross-host reach
- Compose env: `${VAR:-docker-dns-default}` for sim; prod `.env` overrides to wg-IP

---

## 4. Stack

| Layer | Choice | Version |
|---|---|---|
| Consensus | Besu QBFT | **26.4.0** |
| Storage | Bonsai | RocksDB; jemalloc confirmed active |
| Mesh | WireGuard | 10.43.0.0/24 |
| Secrets | HashiCorp Vault Raft | 1.17 (5/3 unseal) |
| DB | Postgres | 16-alpine (indexer + Blockscout, separate DBs) |
| Cache | Redis | 7-alpine |
| Object storage | MinIO | RELEASE.2025-09-07 |
| Edge / TLS | Caddy | 2.8-alpine (auto LE) |
| LB | HAProxy | 2.9-alpine |
| Observability | Prom + Grafana + Loki + Tempo + Alertmanager | — |
| Services | Node 22 + TypeScript + viem + Fastify | signer, broadcaster, indexer, rpc-cache, anchor-worker |
| Contracts | Solidity 0.8.26 | Foundry/forge |
| PQ crypto | `@noble/post-quantum` ML-DSA-65 (FIPS 204) | anchor-worker |
| Backup encryption | age (X25519) | all snapshots |
| Watchdog | willfarrell/autoheal | 1.2.0 (NEW this session — restarts unhealthy containers) |

JVM (rpc nodes, confirmed via `/proc/1/cmdline`):
- besu.sh launcher applies + LD_PRELOAD=libjemalloc.so
- Heap pinned `-Xms6g -Xmx6g`
- `-Dvertx.options.workerPoolSize=64`
- Besu's GC defaults left to stand (`-XX:MaxGCPauseMillis=100`, `MaxHeapFreeRatio=30 / MinHeapFreeRatio=10`)
- JFR runs by default (small overhead)

---

## 5. Public endpoints

| URL | Backend |
|---|---|
| `https://rpc.ledger.haratrust.io/read/` | rpc-cache → HAProxy → rpc-read-1/2 |
| `https://rpc.ledger.haratrust.io/write/` | HAProxy → rpc-write |
| `https://rpc.ledger.haratrust.io/ws` | HAProxy → rpc-read WS |
| `https://explorer.ledger.haratrust.io/` | Blockscout FE (+ `/api/*` `/socket/*` → BE) |
| `https://grafana.platform.haratrust.io/` | Grafana |

Caddy holds LE certs. DNS via GoDaddy. **Lower DNS TTL to 300s before the RPC migration window.**

---

## 6. Deployed contracts (chain 131216)

| Contract | Address | Notes |
|---|---|---|
| ContractRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | versioned by name |
| AnchorRegistry (legacy ECDSA) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | kept for compat |
| GovernanceContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | |
| HaraPalmOil (ERC-1155) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | event-based traceability |
| TraceabilityBatchRelay | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | stateless relay |
| PQAnchorRegistry | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | production ML-DSA-65 |

Plus **hara-did's 7 contracts** (deployed by their `0x240a40dc19f452d1771855393d16c7ae9bce965b` deployer; addresses in their repo, registered in `ContractRegistry` by name).

---

## 7. Admin keys (post anvil-0 rotation, 2026-05-28)

| Key | Address | Holds | Stored |
|---|---|---|---|
| **Platform admin (new)** | `0x944b237097A03E1e8CdE8A0F46605506319EC329` | `DEFAULT_ADMIN_ROLE` + specific roles on all 5 platform contracts; ~9799 HARA | `~/hara-ops/new-admin-2026-05-27.json` (laptop, 0600) + Vault `secret/haraledger/admin-keys/admin-2026-05-27` |
| **anvil-0 (RETIRED)** | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` / key `0xac0974…ff80` | nothing — all 11 roles renounced, drained to 1 wei | well-known dev key; safe that it's public |
| **Load-test deployer** | `0x6A1E6cd7a016a83ac9e630D47C3a453903f9570C` | `MINTER_ROLE` on HaraPalmOil (granted 2026-05-28); ~1000 HARA | `~/hara-ops/loadtest-deployer.json` |
| **hara-did deployer (current)** | `0x240a40dc19f452d1771855393d16c7ae9bce965b` | `DEFAULT_ADMIN_ROLE` on PQAnchorRegistry + `REGISTRAR_ROLE` on ContractRegistry; ~100 HARA | hara-did's side |
| **hara-did anchor signer** | (hara-did rotated theirs; current address from their docs) | `ANCHOR_ROLE` + `KEY_ROTATOR_ROLE` on PQAnchorRegistry | hara-did's Vault |
| Anchor-worker ECDSA | `0x1083b82AB0F9dC35827edAdf5f7B489cBE10C433` | our own anchoring signer | Vault `secret/haraledger/signer-keys/anchor-worker` |

**Important:** anvil-0 still appears in stress-test scripts as the default deployer (`scenario-*.ts` use `${DEPLOYER_PRIVATE_KEY:-0xac09…}`) — test-only, fine. The load-test deployer key is what you actually set in `DEPLOYER_PRIVATE_KEY` env var when running.

---

## 8. APIs

### Indexer trace-api (port 9100 inside container, host: `127.0.0.1:9101`)

- `GET /v1/batches?limit=N` — list ERC-1155 batches
- `GET /v1/batches/<id>/graph?aggregate=true` — custody DAG (nodes + edges)
- `GET /metrics` — Prometheus
- `GET /healthz`

### Anchor-worker (port 9102)

- `GET /metrics` — anchor count, sig bytes, latency

### Chain RPC

- `eth_*`, `net_*`, `web3_*`, `qbft_*`, `txpool_*` enabled on RPC nodes
- `DEBUG`, `TRACE` enabled but **no longer continuously hammered** (Blockscout fetcher disabled — see §10)
- `admin_*` NOT enabled (security hardening)

---

## 9. Schemas

### `watched_contracts` (Postgres, `hara_indexer`)
```sql
contract_address character(42) PRIMARY KEY,
name             text NOT NULL,
from_block       bigint NOT NULL DEFAULT 0,
enabled          boolean NOT NULL DEFAULT true
```
ABI registry at `services/indexer/src/abis.ts` — keyed by `name`. Adding a contract = edit file + INSERT + restart indexer.

### `pq_anchor_signatures`
```sql
commitment_hash bytea(32) PRIMARY KEY,
algo            text NOT NULL,            -- 'ml-dsa-65'
signer_did      text NOT NULL,
anchor_tx_hash  bytea(32) NOT NULL,
bucket          text DEFAULT 'hara-pq-anchors',
object_key      text NOT NULL,
size_bytes      integer NOT NULL,
created_at      timestamptz DEFAULT now()
```
hara-did reads this via PG role `pq_indexer_reader` (SELECT-only) during their migration window. Their plan: eventually move this table to their own DB.

---

## 10. RPC reliability — the big investigation this session

### Root cause (CONFIRMED, fixed)

**Blockscout's internal-transaction fetcher.** It calls `trace_block`/`debug_traceBlockByNumber` on every new block — each re-executes the whole block. On our 200-300M-gas blocks (full of 499-hop executeChains), one trace call ties up a Vert.x worker for seconds. Run continuously, it exhausts the rpc-read pool's worker threads → JSON-RPC listener stops accepting while the node still looks "healthy" → **the recurring read-node hang** (under load AND at rest).

### Fix (deployed)

- `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true` in `deploy/services/blockscout/envs/common-blockscout.env` (gitignored — apply on-host).
- Safe: traceability is event-based (`TransferSingle` per hop, indexed via `eth_getLogs`); only loses Blockscout's "Internal Transactions" UI tab. The relay contract was explicitly designed this way.

### Defense in depth (deployed in same session)

- **Real RPC healthcheck** on the besu-common compose anchor — POSTs `eth_blockNumber`; a wedged listener goes `unhealthy` after ~1 min (instead of falsely showing healthy via the base image's built-in check).
- **autoheal sidecar** (`willfarrell/autoheal:1.2.0`) restarts containers labeled `autoheal=true`. Self-recovery in ~1 min. (Plain Docker won't restart on unhealthy — only on exit. Autoheal closes that gap.)
- `--sync-min-peers=2` (default 5 was unreachable on 4-validator net; left RPC nodes idle 11 min after restart).
- **Heap pinned** `-Xms6g=-Xmx6g`; removed our `-XX:MaxGCPauseMillis=200` which was overriding besu.sh's tuned 100 (last-flag-wins).
- **Client-side retry** in `scenario-stress-200x500.ts`:
  - `batchSendRawTxs` retries on 503 / "not enabled" / "not yet in sync" up to 12× per chunk; treats "already known" / "Known transaction" as success (computes hash from raw via `keccak256`).
  - `waitForReceiptResilient` retries `waitForTransactionReceipt` on 503 / HTML / BlockNotFound / sync errors until an overall deadline (was killed by 503s in the receipt-poll path).
- **HAProxy** `rise 1 fall 3 inter 3s` (was 2/2/2) — tolerates transient out-of-sync flips so brief evictions don't permanently mark a backend down.
- **rpc-cache** gracefully wraps non-JSON upstream errors in JSON-RPC envelopes (was 500ing with `JSON.parse` errors on HAProxy 503 HTML pages).

### Tx-pool flip-flop (mitigated, not fully solved)

Besu's `SyncState.isInSync` gating fires on every block; when a node briefly falls 1 block behind under heavy load, the tx pool toggles off → `eth_sendRawTransaction` rejects with "Transaction pool not enabled." Besu #6001 fixed it only for *initial* full-sync, not steady-state. No public flag to widen tolerance. Mitigations: keep node from falling behind (Phase 1 dedicated host) + client retry (shipped).

### Vert.x worker exhaustion (the underlying mechanism)

Besu issues [#3373](https://github.com/hyperledger/besu/issues/3373), [#3381](https://github.com/hyperledger/besu/issues/3381), [#3758](https://github.com/hyperledger/besu/issues/3758). Heavy sync handlers (debug/trace) pin workers; once exhausted, listener wedges and never self-heals. Default `--rpc-http-max-active-connections`=80 was the historical trigger; we're at 4000 (not the issue for us). Batch capped at 200 (default 1024). With the trace fetcher disabled, the main worker-pinning source is gone.

---

## 11. Stress test results (proven)

| Test | Events | Wall clock | Effective TPS | Notes |
|---|---|---|---|---|
| 5×50 (smoke) | 245 | 14.0s | 17 | baseline ✓ |
| **200×50** | **9,800** | **46.0s** | **213** | clean ✓ |
| **200×100** | **19,800** | **61.4s** | **322** | clean ✓ |
| 200×500 (24/27 chunks) | ~90,000 | ~25 min | — | software resilience riding through degradation; rpc-write CPU contention |

**Single-block capacity observed:** 45 executeChain × 499 hops = **~22,000 transfer events in one 2-second block at ~300M gas** (validators packed it before the 1499ms cap fired in earlier runs; cap now raised to 8000ms). Per-executeChain sim cost ~33ms, not the 7.5s I'd initially estimated.

**The 200×500 wall** is not a chain limit — chain proved it can do ~22K events/block. It's **block-import CPU contention on hara-stateless** (all 3 RPC nodes + services + Blockscout + indexer + obs competing for the same 8 vCPU). Phase 1 dedicated RPC host expected to clear it.

---

## 12. Files added / changed this session

### Committed (in order)

- `3d7c9f6` `fix(rpc,load-tests): mitigate JSON-RPC HTTP listener deadlock under load` — heap, vertx, batch-size + Phase A/B/C verification
- `0280b00` `perf(chain,load-tests): raise validator block-build cap and skip per-chunk receipt wait` — `--block-txs-selection-max-time=8000`, `--tx-pool-enable-save-restore=false`
- `2e1e148` `perf(chain): raise per-sender future nonce limit to 2000` — `--tx-pool-max-future-by-sender=2000`
- `07e40ce` `fix(load-tests): reduce Phase C chunkSize to 15 to keep rpc-write in sync`
- `899e3c3` `fix(rpc-cache,lb): handle non-JSON upstream errors; relax HAProxy rise/fall`
- `61da270` `ops: admin rotation + WG peer onboarding scripts, partner integration doc` — `rotate-anvil0-admin.sh`, `wg-add-peer.sh`, `haraledger-info-did.md`, `single-tx.ts`
- `e1fee5e` `fix(ops): rotate-anvil0-admin handles cast array output + big-number drain` — jq array, python3 bignum
- `e58d53e` `chore(load-tests): env-overridable deployer in single-tx.ts + README note`
- `27a525d` `feat(load-tests): retry batchSendRawTxs through rpc-write sync-flips`
- `ab54d97` `feat(load-tests): resilient receipt-wait + funded-deployer MINTER_ROLE note`
- `f3c7e75` `fix(rpc): pin heap, stop overriding Besu GC pause target, sync-min-peers note`
- `55a91b2` `fix(rpc): real RPC healthcheck + autoheal sidecar for self-recovery`
- `ffb3272` `docs: RPC tier scaling design — dedicated host + multi-write LB`
- `211a7c2` `docs(rpc-scaling): lock decision — "Good" now -> "Best" later`
- `70bd2ec` `docs: runbook for combined RPC-host + services-downsize cutover`

### Notable new files

- **`deploy/ops/rotate-anvil0-admin.sh`** — 3-phase admin rotation (grant/verify/renounce) with dry-run; idempotent.
- **`deploy/ops/wg-add-peer.sh`** — two-phase (prepare/finalize) incremental WG peer onboarding. Reusable.
- **`deploy/rpc-scaling-design.md`** — the "why" of the topology change + Phase 1/2 sizing.
- **`deploy/runbook-rpc-host-migration.md`** — the executable cutover (single window).
- **`haraledger-info-did.md`** — partner handoff doc that hara-did used.
- **`ops/load-tests/single-tx.ts`** — env-overridable diagnostic (mines one tx, polls).
- **`haraleder-vps-01.md`** — original session handoff (now committed).

### Gitignored (apply on-host)

- `deploy/services/blockscout/envs/common-blockscout.env` — must re-apply `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true` + the `ETHEREUM_JSONRPC_*_URL` repoint after any migration.

---

## 13. hara-did partner state

Live integration against prod chain since 2026-05-27. See `memory:hara-did-partner` for details.

**What they use from us:**
- Chain RPC over WG: `http://10.43.0.20:8545/rpc/write` (will become `10.43.0.21:8545` after Phase 1 migration — they'll need notice)
- Postgres `pq_indexer_reader` (SELECT on `pq_anchor_signatures` only, `10.43.0.40:5432`) — short-lived, they're moving the table off ours
- WG mesh peer at `10.43.0.50`, public IP `103.67.244.109`

**What they DON'T use:** Vault. Their signer/PQ keys are theirs. The `haradid-anchor-oracle` AppRole we briefly set up was revoked (mutual misunderstanding — keys were never ours).

**Their deployer / on-chain roles:** `0x240a40dc...965b` holds `DEFAULT_ADMIN_ROLE` on PQAnchorRegistry + `REGISTRAR_ROLE` on ContractRegistry. They use that delegation to grant `ANCHOR_ROLE`/`KEY_ROTATOR_ROLE` to their own anchor-oracle signer.

**Lost-key recovery happened once (2026-05-28):** original deployer/signer keys lost when their in-memory dev Vault wiped. We re-funded + re-granted a fresh deployer and revoked the orphaned roles. They now have durable key storage.

---

## 14. Unresolved issues

| Item | Status | Resolution path |
|---|---|---|
| **200×500 full completion** | Software resilience done; wall is shared-host import CPU | **Phase 1 RPC migration** (priority #0) |
| Tx-pool steady-state flip-flop | Besu has no public tolerance flag | Phase 1 host (won't fall behind) + retry shipped |
| rpc-cache null-receipt fix `f46d2be` | Pushed but unclear if it's the live image build path | Verify on-host after Phase 1; not blocking (clients use `/write/` if `/read/` is funky) |
| Blockscout internal-tx UI tab | Gone (we disabled the fetcher) | Acceptable — traceability is event-based; restore only if a UX need surfaces |
| Snapshot crons (Phase 8) | Scripts exist, systemd timers + rclone not configured | Phase 8 work — separate effort |
| GitHub branch protection (Phase 9) | Not yet | Phase 9 |
| Single-key admin (vs multisig) | Single-key is fine for staging; external partner is now live | Consider Gnosis Safe migration when scale or compliance demands |

---

## 15. Constraints (unchanged)

- Gas price chain-wide is **0** (zeroBaseFee in genesis)
- Anvil-0 (`0xf39Fd6...92266`) deployer key is well-known — **now powerless** (rotated 2026-05-28), still funded with 1 wei
- Block gas limit `0x1fffffffffffff` (~9 PETA) — effectively unbounded
- HAProxy LB: 32K concurrent, 5K req/10s per IP rate limit
- Vault root token + 5 unseal keys in `~/hara-ops/vault-init-keys-v2.json` (laptop) + password manager
- Age private key for backups in `~/.config/age/hara-backups.txt` + password manager
- Anchor-worker ECDSA key at Vault `secret/haraledger/signer-keys/anchor-worker`
- SSH ed25519: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxywCp9uJ1ZANpmRzWpJc41oZfVoeA5Xpt7V5SKwVUV ops@haratrust`

---

## 16. Coding conventions

- All shell scripts: `set -euo pipefail`
- Compose env vars: `${VAR:-docker-dns-default}` for sim; prod `.env` overrides to wg-IP
- Image tags: `${IMAGE_REGISTRY}` prefix on every image (empty for local builds, `ghcr.io/imronzuhri-svg/` for prod)
- Per-role `.env`: `BACKUP_AGE_RECIPIENT` required everywhere
- Docker bridge subnet stays `10.42.0.0/24`; container IPs unchanged
- Test scripts in `ops/load-tests/` use viem directly; `DEPLOYER_PRIVATE_KEY` env override (anvil-0 default is empty post-rotation — must override with a funded key)
- **New (this session):** **bash arithmetic overflows above 9.2e18** — for wei amounts use `python3 -c "print($BAL - 1)"`. Bit us in the anvil-0 drain.
- **New (this session):** **`cast wallet new --json` returns an ARRAY** `[{...}]`, not an object. Handle with `jq 'if type=="array" then .[0] else . end'`. Bit the rotation script.
- Bash apostrophe in `${VAR:?msg}` breaks the parser — long-standing rule.

---

## 17. Next priorities (order)

0. **Provision `hara-rpc-1` + `hara-stateless-2`; run the cutover.** See [deploy/runbook-rpc-host-migration.md](deploy/runbook-rpc-host-migration.md). This clears the 200×500 wall, isolates RPC from services, downsizes the overloaded host. ~1 maintenance window. Memory pointer: `memory:next-priorities` item #0.
1. **Re-run 200×500** post-cutover; expected to complete cleanly. Get the headline TPS for 99,800 events.
2. **Validator RAM bump 8→16 GB** (next time validators are touched; pin heap to 8 GB).
3. **Deploy `f46d2be` rpc-cache null-receipt fix** to live image (verify it's in the running rpc-cache container after the cutover image rebuild).
4. **Phase 8 — snapshot crons** (rclone + systemd timers).
5. **Phase 9 — GitHub branch protection.**
6. **Vault snapshot restore drill** on hara-stateful.
7. **Consider Gnosis Safe multisig** for platform admin (single-key post-rotation is fine for staging, less so as more partners integrate).

---

## 18. Important lessons (carry forward)

1. **"Container healthy" ≠ "RPC working"** — the base besu image's healthcheck passed while the Vert.x listener was wedged. Always use a real RPC-probing healthcheck (POST `eth_blockNumber`, expect `result`) + an autoheal mechanism (plain Docker does not restart unhealthy containers).
2. **Vert.x worker deadlocks are sticky** — once wedged, never self-heal. "Found it hung after idle" is almost always "wedged earlier under load, discovered later." Attack the trigger AND add self-recovery.
3. **Blockscout's internal-tx fetcher = silent killer on heavy chains** — calls `trace_block` per block, each re-executes the whole block. Always set `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true` for chains with heavy txs unless the call-tree UI is genuinely needed.
4. **Rolling restart of RPC nodes leaves rpc-write at 0 peers** — confirmed multiple times. The only working recovery is **simultaneous full-cluster restart** (validators + RPC + LB). With `--sync-min-peers=2` this is less likely now, but the playbook is in `memory:rpc-node-hang-bug`.
5. **Test verification gates are gold** — Phase A `getBalance > 0` check caught silent un-funded wallets; Phase B `isApprovedForAll` check would have prevented the Phase-C-all-reverts run. Status-1 receipt ≠ success; check gas to spot reverts that "completed."
6. **Validator txpool zombies** (stuck txs from failed runs with `SenderBalanceChecker` exceptions) require a **simultaneous validator restart** to clear — they persist in-memory and gossip between validators. Pool isn't file-persisted in our setup but the in-memory state survives single-node restarts via peer gossip. Playbook: `memory:validator-pool-zombies`.
7. **Don't override Besu's launcher GC defaults** — besu.sh sets `MaxGCPauseMillis=100` (tuned) + jemalloc; our `BESU_OPTS=…MaxGCPauseMillis=200…` overrode it to a worse value (last-flag-wins). Only override what you measured.
8. **Read load dominates write load in steady state** for explorer + indexer + partner chains. When splitting RPC, isolating *reads* often matters more than isolating *writes* — counterintuitive but correct for our workload mix. Write-on-its-own-host is Phase 2, not Phase 1.
9. **Multi-write LB requires sender affinity** — naive round-robin breaks nonce consistency (per-node mempool views diverge). HAProxy `balance source` is the cheap version; client-side nonce management + retry is the complementary half.
10. **The fast way to "downsize" a stateless host is a fresh-box redeploy**, not in-place resize — exploits the stateless-by-design property and sidesteps disk-shrink limits. Fold into the next migration window instead of doing it separately.

---

## 19. Memory index (for next-session warm start)

In `~/.claude/projects/.../memory/`:

- `MEMORY.md` — index
- `user-role.md` — operator profile
- `project-overview.md` — chain + hosts + stack quickstart
- `network-split.md` — WG 10.43 vs docker 10.42 (critical rule)
- `active-blockers.md` — open issues snapshot
- `validator-pool-zombies.md` — zombie tx detection + simultaneous-restart playbook
- `rpc-node-hang-bug.md` — **the long one** — Vert.x worker exhaustion, the Blockscout root cause find, all 26.x research findings + fixes
- `stress-test-results.md` — TPS table + per-block capacity findings
- `hara-did-partner.md` — partner integration state
- `next-priorities.md` — top of queue is RPC host migration
- `coding-conventions.md` — set -euo pipefail, env defaulting, bash apostrophe
- `sim-vs-prod-gaps.md` — what sim doesn't catch
- `secrets-locations.md` — key file paths + Vault paths

Open these (or have a fresh session load them) and the next operator picks up at item #0 with full context: provision two VPSes, follow the runbook, run 200×500.

---

## End

If you're reading this in a fresh session: the chain is live, partners are integrated, the RPC reliability investigation is closed (Blockscout fetcher was the killer), all software fixes are deployed, and the one piece of infra work that finishes the 200×500 story has a runbook ready. Top of the priority queue (priority #0) tells you the exact next step.
