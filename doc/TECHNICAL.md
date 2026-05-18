# HaraLedger — Technical Reference

**Audience:** engineers building on or operating HaraLedger; auditors reviewing the platform.
**Companion docs:** `PRODUCT.md` for product-level overview, `deploy/topology.md` for the 6-VPS deployment plan, `doc/hara-ledger state 2.md` for the carry-on context snapshot, `doc/audit-security-quantum-performance.md` for the full security rationale.
**Snapshot date:** 2026-05-15.

This document is the consolidated technical reference. It is intentionally redundant with the more focused docs above; if you need to know one thing about HaraLedger, look here first.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Network topology](#2-network-topology)
3. [Smart contracts](#3-smart-contracts)
4. [Services](#4-services)
5. [Data model](#5-data-model)
6. [APIs](#6-apis)
7. [Security model](#7-security-model)
8. [Deployment](#8-deployment)
9. [Operations](#9-operations)
10. [Coding conventions](#10-coding-conventions)
11. [CI / CD](#11-ci--cd)
12. [Failure modes & recovery](#12-failure-modes--recovery)
13. [Lessons learned](#13-lessons-learned-do-not-repeat)
14. [Build & test](#14-build--test)
15. [Reference card](#15-reference-card)

---

## 1. Architecture overview

HaraLedger is a layered system. Each layer has a clear contract with the layers above and below.

```
╔════════════════════════════════════════════════════════════════════════╗
║  Application layer (companion repos)                                   ║
║    hara-did / hara-halal-passport / hara-xchange                       ║
║                                                                        ║
║  Reads + writes via:                                                   ║
║    • JSON-RPC (POST /rpc/write, /rpc/read) ──┐                         ║
║    • WebSocket subscriptions ────────────────┼─── Caddy edge (TLS)     ║
║    • Indexer REST (/trace/*) ────────────────┘                         ║
╠════════════════════════════════════════════════════════════════════════╣
║  Service tier (TypeScript, pnpm workspace)                             ║
║                                                                        ║
║    signer          rpc-cache         indexer                           ║
║      │              │                  │                               ║
║      ▼              ▼                  ▼                               ║
║    broadcaster    HAProxy LB ──→ Besu RPC nodes ──→ validators (P2P)   ║
║                                                                        ║
║    migrate, shared (lib)                                               ║
╠════════════════════════════════════════════════════════════════════════╣
║  Storage tier (long-lived state)                                       ║
║                                                                        ║
║    Postgres (hara_indexer)     Vault Raft     MinIO buckets            ║
║      • indexed_events           • validators   • hara-chain-config     ║
║      • watched_contracts        • signer-keys  • hara-pq-anchors       ║
║      • pq_anchor_signatures     • anchor                               ║
║      • tx pipeline tables                                              ║
║                                                                        ║
║    Redis (Streams + KV)                                                ║
║      • DBs 0–5 hara-ledger  • DBs 6–8 hara-did  • DBs 9–11 hara-passport║
╠════════════════════════════════════════════════════════════════════════╣
║  Chain layer (Besu QBFT, chain ID 131216)                              ║
║                                                                        ║
║    validator-1 (10.42.0.11)  validator-2 (10.42.0.12)                  ║
║    validator-3 (10.42.0.13)  validator-4 (10.42.0.14)                  ║
║                                                                        ║
║    Smart contracts: ContractRegistry, AnchorRegistry, PQAnchorRegistry,║
║      GovernanceContract, HaraPalmOil, TraceabilityBatchRelay           ║
╠════════════════════════════════════════════════════════════════════════╣
║  Observability                                                         ║
║    Prometheus · Grafana · Loki · Promtail · Alertmanager · alert-sink  ║
╚════════════════════════════════════════════════════════════════════════╝
```

### 1.1 Locked-in choices (do not re-litigate)

| Layer | Choice | Why |
|---|---|---|
| Consensus | Besu QBFT | Instant finality, IBFT successor, mature, Java/Hyperledger ecosystem |
| Contract lang | Solidity via Foundry | Speed of iteration; in-tree forge tests |
| EVM target | London (not Shanghai) | PUSH0 broke Besu deploys; pinned + `--legacy` txs |
| Service lang | TypeScript + pnpm workspaces | One language across the service tier |
| RPC client | viem | Modern; better types than ethers v5 |
| Queue | Redis Streams | Lightweight, already on stack; revisit at P2 if partitioning needed |
| Secrets | HashiCorp Vault | AppRole + Raft is well-trodden |
| Explorer | Blockscout | EVM-native, self-host, open source |
| Container | Docker Compose (P0–P1) → K3s (P2+) | Avoids k8s overhead at our size |
| Post-quantum | Hybrid ECDSA + ML-DSA-65, off-chain sig + on-chain commitment hash | On-chain verifier costs ~5 M gas today |

Explicit deferrals (state-2 §6): Avalanche Subnet (P3), Polygon CDK (parallel track), zk-rollup with public L1 settlement (P3+).

---

## 2. Network topology

### 2.1 Static IP allocation (10.42.0.0/24)

The same plan in local Docker Compose and the production WireGuard mesh — `static-nodes.json` works unchanged.

| IP | Role | Notes |
|---|---|---|
| 10.42.0.1 | Gateway | bridge / WG default route |
| 10.42.0.2 | Vault (dev) / Caddy (prod) | Vault moves to .40 in prod |
| 10.42.0.3 | Prometheus | |
| 10.42.0.4 | Alertmanager | |
| 10.42.0.5 | alert-sink | webhook receiver |
| 10.42.0.6 | Loki | |
| 10.42.0.7 | Grafana | |
| 10.42.0.8 | Promtail | log shipper |
| 10.42.0.11–14 | validator-1..4 | static enodes |
| 10.42.0.20 / .21 | RPC read / write LB binding | dual-IP on hara-stateless |
| 10.42.0.30 | Postgres | |
| 10.42.0.31 | Redis | |
| 10.42.0.40 | Vault (prod, Raft) | |
| 10.42.0.42 | MinIO | |
| 10.42.0.45 | Postgres (alternate; see compose) | actual binding |
| **10.42.0.50–69** | **Reserved for hara-did** | |
| **10.42.0.70–89** | **Reserved for hara-halal-passport** | |

### 2.2 Public-facing surface

Only three hostnames are exposed via Caddy → Let's Encrypt → reverse-proxy on hara-stateless:

```
rpc.hara.id        /read/*   → rpc-cache:8088
                   /write/*  → HAProxy LB:8545
                   /ws       → HAProxy LB:8546

explorer.hara.id   /         → Blockscout FE:3000
                   /api/*    → Blockscout BE:4000

grafana.hara.id    /         → Grafana:3000
```

Vault is **never** publicly exposed. Operator access via SSH tunnel only.

---

## 3. Smart contracts

All contracts live in `contracts/src/`. Tests in `contracts/test/`. Deploy scripts in `contracts/script/`. Toolchain: Foundry. `foundry.toml` pins `evm_version = "london"`, optimizer on.

### 3.1 ContractRegistry

```
contracts/src/ContractRegistry.sol
```

Address book for the platform. Maps `bytes32 name → (version → address)` with a single active version per name. Lets services discover contract addresses without hardcoding.

**Constructor:** `ContractRegistry(address admin)` — `admin` gets `REGISTRAR_ROLE`.

**Key functions:**
- `register(bytes32 name, uint16 version, address impl)` — add a new version.
- `getActive(bytes32 name) → address` — fetch current.
- `setActiveVersion(bytes32 name, uint16 version)` — bump active version.

**Tests:** `ContractRegistry.t.sol` — 6 tests covering first-version auto-activation, duplicate-version reverts, non-registrar reverts, zero-address reverts.

### 3.2 AnchorRegistry

```
contracts/src/AnchorRegistry.sol
```

Classical-only audit anchor commitments. Records Merkle roots of event ranges with optional external-chain confirmation (IOTA tx hash, Ethereum L1 tx hash).

**Constructor:** `AnchorRegistry(address admin)` — `admin` gets `ANCHOR_ROLE`.

**Key functions:**
- `recordAnchor(bytes32 merkleRoot, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain) → uint256 anchorId`
- `confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)` — record the external chain's tx hash.

**Tests:** `AnchorRegistry.t.sol` — 4 tests covering record, external confirm, empty-range revert, not-found revert.

### 3.3 PQAnchorRegistry (post-quantum)

```
contracts/src/PQAnchorRegistry.sol
```

Hybrid quantum-ready version of AnchorRegistry. Commits a `keccak256(ML-DSA-65 signature)` on-chain; the actual signature lives off-chain in MinIO per ADR-0010 (hara-did repo).

**Constructor:** `PQAnchorRegistry(address admin, bytes32 initialPQKeyHash, string initialAlgorithm)`. Admin gets `DEFAULT_ADMIN_ROLE`, `ANCHOR_ROLE`, `KEY_ROTATOR_ROLE`.

**Key functions:**
- `recordAnchor(merkleRoot, sha3Root, blockFrom, blockTo, eventCount, anchorChain, pqSignatureHash)` — reverts on `EmptyRange` or `MissingPQCommitment` (sig hash = 0 is disallowed).
- `confirmExternalAnchor(anchorId, anchorTxHash)`
- `rotatePQKey(bytes32 newKeyHash, string newAlgorithm)` — KEY_ROTATOR_ROLE only.

**Why hybrid:** verifying ML-DSA-65 on-chain costs ~5 M gas (state-2 §2). Commit-only is ~30 k gas. Off-chain blob in MinIO + on-chain hash gives quantum-safe verification at audit time without the verifier cost. When EVM precompiles for ML-DSA arrive (2027–2029 est.), add `verifyPQ()` and switch.

**Tests:** `PQAnchorRegistry.t.sol` — 13 tests covering construction, recordAnchor happy + reverts, AccessControl, rotation (including that existing anchors keep their frozen `pqKeyHash`), granted-rotator path.

### 3.4 GovernanceContract

```
contracts/src/GovernanceContract.sol
```

N-of-M multisig with emergency-pause. P0 ships as 1-of-1 (deployer-only); P1+ promotes to 3-of-5 for system contract operations.

**Constructor:** `GovernanceContract(address[] governors, uint256 threshold)`.

**Tests:** `GovernanceContract.t.sol` — 4 tests covering propose/execute 2-of-3, double-approve revert, execute-before-threshold revert, emergency pause.

### 3.5 HaraPalmOil

```
contracts/src/HaraPalmOil.sol
```

ERC-1155 representing **litres** of sustainable palm oil. One token ID per batch.

**Per-batch metadata:**
- `rspoCertificateHash` (bytes32)
- `plantationId` (bytes32)
- `productionDate` (uint64)

**Mass-balance invariant:** ERC-1155 mechanics ensure you cannot transfer more litres than you hold. Mint is governance-gated.

**Tests:** `HaraPalmOil.t.sol` — 4 tests covering mint+transfer, duplicate batch revert, relay-emits-4-TransferSingle, relay-executes-chain.

### 3.6 TraceabilityBatchRelay

```
contracts/src/TraceabilityBatchRelay.sol
```

Bundles N supply-chain hops into one transaction. Solves a real Besu QBFT pain point: the block builder does not preserve mempool order, so chained txs (sender A → B → C in sequence) can land out of order and fail. **Within a single tx, execution is deterministic** — so the relay just sequences N transfers inside one `executeChain` / `executeChainVariable` / `executeHops` call.

Anyone writing chained-tx flows must use this relay; using raw `transferFrom` chains across separate txs is a known footgun (state-2 §9 #7, §12).

### 3.7 TestToken

```
contracts/src/TestToken.sol
```

Minimal ERC-20 with mintable role, used only by `ops/load-tests/`. Initial supply 1 000 000 HTST to deployer.

**Tests:** `TestToken.t.sol` — 9 tests covering metadata, role assignment, mint by minter / granted-minter / non-minter, transfer + balance accounting, approve + transferFrom + allowance decrement, `ERC20InsufficientBalance` / `ERC20InsufficientAllowance` reverts.

### 3.8 Deploy + register flow

Both lines in one shot:

```
make deploy-all
```

Under the hood:
1. `forge script Deploy.s.sol:Deploy --legacy --skip-simulation` — deploys ContractRegistry, AnchorRegistry, GovernanceContract; auto-registers in ContractRegistry.
2. `scripts/register-from-broadcast.sh` parses `broadcast/*/131216/run-latest.json` and upserts every CREATE-tx into `watched_contracts` so the indexer picks them up.
3. `forge script DeployPalmOil.s.sol:DeployPalmOil` + register.
4. `forge script DeployPQAnchor.s.sol:DeployPQAnchor` — reads `CONTRACT_REGISTRY` from env (passed in from step 1's broadcast file) so the new PQAnchorRegistry registers itself; pre-deploys with a placeholder PQ key hash that **must be rotated** before any real anchor.

### 3.9 Test totals

```
AnchorRegistry         4 tests
ContractRegistry       6 tests
GovernanceContract     4 tests
HaraPalmOil            4 tests
PQAnchorRegistry      13 tests
TestToken              9 tests
─────────────────────────────
                      40 tests, all green
```

---

## 4. Services

Eight workspace packages in `services/`. All TypeScript, all ES modules, all use pnpm workspace protocol.

### 4.1 shared (library)

```
services/shared/src/
  vault.ts    — Vault client with AppRole + token caching + 403 retry
  db.ts       — Postgres pool
  rpc.ts      — viem helpers
  logger.ts   — pino setup
  index.ts    — re-exports
```

`vault.ts` auth priority:
1. `VAULT_APPROLE_ID` + `VAULT_APPROLE_SECRET` set → AppRole login, token cached in module-scope, refreshed `TOKEN_REFRESH_SLACK_SEC` (30s) before expiry. Concurrent-login coalescing (N parallel cold callers do ONE login, not N).
2. `VAULT_TOKEN` set → use directly (local dev).
3. Neither set → throw at first read.

403 retry-once on the AppRole path handles the race where Vault rotates between cache and use.

### 4.2 signer

```
services/signer/
```

Nonce-safe transaction signer.

**Pipeline:**
1. Accept signed-tx request via HTTP POST (`POST /sign`).
2. `SELECT FOR UPDATE` on `nonces` row for the from-address.
3. Build tx with the reserved nonce, sign with key fetched from Vault (`secret/haraledger/signer-keys/<role>`).
4. Bump `last_reserved` in `nonces` table.
5. Push signed tx to Redis Stream `tx:outbound`.
6. Return tx_id + tx_hash.

Health: `GET /healthz` → `{ok: true}`.

### 4.3 broadcaster

```
services/broadcaster/
```

Drains the `tx:outbound` Redis Stream, submits to the write RPC endpoint, tracks status.

**Tx state machine (Postgres `transactions.status` enum):**

```
DRAFT → QUEUED → SIGNED → BROADCASTED → CONFIRMED
                                      ↘ REVERTED
                  ↘ FAILED ↗ RETRYING (transient)
```

Each `tx_attempts` row records one broadcast attempt with rpc_response JSONB for debugging.

Exponential backoff on transient failures: `2000 * 2^retry_count` ms.

### 4.4 indexer

```
services/indexer/
```

Block follower + REST API.

**Boot:**
- Reads `watched_contracts` (6 rows after `make deploy-all`).
- Reads `indexer_state.last_indexed_block` cursor.
- Subscribes to `newHeads` via WebSocket.

**Per-block:**
- Fetch block + receipts via batch RPC.
- For each log matching a `watched_contracts` address, decode against the contract ABI, write to `indexed_events`.
- Advance cursor.

**REST API (`/trace/*`):**
- `GET /trace/batches` — list batches.
- `GET /trace/batch/:id` — full batch detail.
- `GET /trace/batch/:id/hops` — hops in order.
- `GET /trace/batch/:id/graph` — graph JSON (used by viewer).

**Metrics:** Prometheus on `:9100/metrics` with `hara_indexer_*` prefix.

### 4.5 rpc-cache

```
services/rpc-cache/
```

Fastify proxy in front of read RPC. Method-specific TTLs:

| Method | TTL |
|---|---|
| `eth_blockNumber` | 1 s |
| `eth_chainId` | 24 h |
| `eth_getBlockByNumber` (finalized) | 1 h |
| `eth_getBlockByNumber` (latest) | 1 s |
| `eth_getLogs` (with fromBlock+toBlock, both ≤ latest-32) | 1 h |
| Others | pass-through, no cache |

**99 % cache hit rate measured** on representative read workload (state-2 §2). Cuts validator load 40–60 % under read pressure.

Prometheus metrics: hit / miss / bypass / errors per method.

Warmup on boot: fires the top-10 most-cacheable methods so the cache isn't cold at first traffic. Can be disabled with `WARMUP_ON_START=0`.

### 4.6 migrate

```
services/migrate/
```

Schema migration runner. Walks `services/migrations/*.sql` in lexical order, applies any not already in `_migrations` table, per-file transaction.

Current migrations:
- `001_init.sql` — wallets, wallet_nonces, transactions, tx_attempts.
- `002_indexer_schema.sql` — indexer_state, watched_contracts, indexed_blocks, indexed_events.
- `003_traceability_view.sql` — custody_hops + batch_summary views. INSERTs removed in commit a858bf3 (deploy-driven registration).
- `004_pq_anchor_signatures.sql` — off-chain PQ signature index per ADR-0010.

### 4.7 No NestJS / Go yet

The `nevacloud-proposal.md` § "Core HaraLedger" stack line mentions "NestJS/Go sequencer." The actual current implementation is TypeScript via the signer + broadcaster pair. The line is aspirational; rewrite only if perf demands.

---

## 5. Data model

### 5.1 Postgres — `hara_indexer` DB on hara-stateful

#### Migrations 001 (tx pipeline)
```sql
wallets(address PK, vault_path, label, created_at)
wallet_nonces(address PK FK, last_reserved, last_confirmed, updated_at)

transactions(
  tx_id UUID PK, from_address, to_address, data TEXT,
  value NUMERIC(78,0), gas_limit, nonce BIGINT, chain_id BIGINT,
  raw_tx TEXT, tx_hash CHAR(66),
  status tx_status ENUM, receipt_status SMALLINT,
  block_number, gas_used, error_message,
  retry_count SMALLINT, submitted_by TEXT,
  created_at, updated_at, confirmed_at
)

tx_attempts(attempt_id BIGSERIAL PK, tx_id FK, attempt_number,
            tx_hash, rpc_response JSONB, error_message, attempted_at)
```

Indexes on status, from_address, tx_hash (partial), created_at DESC.

#### Migrations 002 (indexer)
```sql
indexer_state(id=1 PK, last_indexed_block BIGINT, last_indexed_at)
watched_contracts(contract_address CHAR(42) PK, name, from_block, enabled, created_at)
indexed_blocks(block_number PK, block_hash, parent_hash, timestamp_unix, tx_count, indexed_at)
indexed_events(event_id BIGSERIAL PK, block_number, block_hash, tx_hash,
               log_index, contract_address, contract_name, event_signature, event_name,
               topics TEXT[], data TEXT, decoded JSONB, indexed_at,
               UNIQUE(block_hash, tx_hash, log_index))
```

#### Migrations 003 (traceability views)
```sql
custody_hops VIEW   — flat per-hop projection over indexed_events
batch_summary VIEW  — per-batch aggregate (current_holder, hop_count, mint info)
```

#### Migration 004 (PQ anchor index, per ADR-0010)
```sql
pq_anchor_signatures(
  commitment_hash BYTEA PK (32),  -- == on-chain keccak256(sig)
  algo TEXT,                       -- 'ml-dsa-65'
  signer_did TEXT,
  anchor_tx_hash BYTEA (32),
  bucket TEXT DEFAULT 'hara-pq-anchors',
  object_key TEXT,                 -- 'ml-dsa-65/<hex>.sig'
  size_bytes INTEGER,
  created_at TIMESTAMPTZ,
  CHECK octet_length(commitment_hash) = 32,
  CHECK octet_length(anchor_tx_hash)  = 32,
  CHECK size_bytes > 0
)
```

The blob itself is **never** in Postgres — keeps base backups flat.

### 5.2 Redis

Logical DB allocation (single Redis instance):
- DB 0 — broadcaster `tx:outbound` stream
- DB 1 — rpc-cache key/value
- DB 2 — signer nonce coordination locks
- DB 3 — indexer cursor checkpoints
- DB 4 — Blockscout cache
- DB 5 — alert-sink deduplication
- **DB 6–8 — reserved for hara-did**
- **DB 9–11 — reserved for hara-halal-passport**

### 5.3 Vault (KV v2 at `secret/`)

Path convention:
```
secret/haraledger/validators/{1..4}          # validator private keys
secret/haraledger/signer-keys/<role>         # deployer, anchor-worker, etc.
secret/haraledger/anchor/<period>            # produced by anchor worker

secret/haradid/signer-keys/<role>            # hara-did namespace
secret/haradid/...

secret/harapassport/signer-keys/<role>       # hara-passport namespace
```

AppRoles (created by `vault-approle-bootstrap.sh`):
- `validator` → policy `haraledger-validator` (read `validators/*`)
- `signer` → policy `haraledger-signer` (read `signer-keys/*`)
- `anchor-worker` → policy `haraledger-anchor` (read signer key + RW under `anchor/*`)

### 5.4 MinIO buckets

| Bucket | Access | Purpose |
|---|---|---|
| `hara-chain-config` | anonymous read (mesh-internal) | `genesis.json` + `static-nodes.json`; written once by chain init |
| `hara-pq-anchors` | private | ML-DSA-65 signature blobs per ADR-0010; key `ml-dsa-65/<hex>.sig` |

---

## 6. APIs

### 6.1 JSON-RPC

| Endpoint | Path |
|---|---|
| Read | `POST https://rpc.hara.id/read/` (prod) · `http://localhost:8545` (dev) |
| Write | `POST https://rpc.hara.id/write/` (prod) · `http://localhost:8545` (dev) |
| WebSocket | `wss://rpc.hara.id/ws` (prod) · `ws://localhost:8546` (dev) |

Methods supported: full Ethereum JSON-RPC + Besu admin extensions where appropriate.

**Read path always goes through rpc-cache.** Sending a write to the read endpoint will succeed but bypasses the LB's write-affinity and racing nonces can land out of order — always direct writes to the write endpoint.

### 6.2 Indexer REST

| Method | Path | Returns |
|---|---|---|
| GET | `/trace/batches?limit=N&offset=N` | List of batches with summary stats |
| GET | `/trace/batch/:id` | Full batch detail (mint info, RSPO hash, current holder, hop count) |
| GET | `/trace/batch/:id/hops` | Ordered hops `[{from, to, qty, tx_hash, block, ts}, …]` |
| GET | `/trace/batch/:id/graph` | Cytoscape/G6-compatible JSON (nodes + edges) |
| GET | `/metrics` | Prometheus exposition |
| GET | `/healthz` | `{ok: true}` |

### 6.3 Signer

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/sign` | `{from, to, data, value?, gasLimit?}` | `{tx_id, tx_hash, nonce}` |
| GET | `/healthz` | — | `{ok: true}` |
| GET | `/metrics` | — | Prometheus exposition |

---

## 7. Security model

### 7.1 Key custody

- **Validator keys** — generated by chain init, immediately written to Vault, local files wiped. Validators fetch via AppRole at startup; never on disk.
- **Signer key** — same pattern; deployer key (anvil #0 in dev, generated in prod) lives in Vault.
- **Anchor-worker key** — Vault, AppRole-scoped, with write permission only under `secret/haraledger/anchor/*`.

No `VAULT_TOKEN` root token is distributed to any production VPS. Each VPS gets a `VAULT_APPROLE_ID` + `VAULT_APPROLE_SECRET` pair for the role it actually plays (one of validator / signer / anchor-worker).

### 7.2 TLS

Caddy on hara-stateless terminates public TLS. Auto-renewed Let's Encrypt certs.

All upstream traffic from Caddy is plaintext over the WireGuard mesh. No per-service TLS complexity.

Vault is **never** proxied through Caddy. Operator access via SSH tunnel.

### 7.3 Post-quantum

Hybrid signing pattern (audit-security-quantum-performance.md §"Layer 2"):

```
At anchor time:
  ECDSA(Merkle root)   → on-chain in AnchorRegistry (or PQAnchorRegistry)
  ML-DSA-65(Merkle root) → off-chain blob in MinIO
                          keccak256(blob) committed on-chain in PQAnchorRegistry

At audit time (today):
  1. Fetch blob from MinIO by commitment hash.
  2. Verify keccak256(blob) matches on-chain commit.
  3. Verify ML-DSA-65 signature against signer's PQ public key
     (in hara-did's DID document).

At audit time (post-2030, after a CRQC exists):
  Classical ECDSA forgery is possible. The ML-DSA-65 signature is the
  authoritative proof because Dilithium 3 is lattice-based and CRQC-safe.
```

### 7.4 WireGuard mesh

All inter-VPS traffic is WireGuard-encrypted. 6 hosts × 5 peers each = 30 mesh edges, each validated by `wg-bootstrap.sh` (PASS verifies handshake completed, not just IP routing).

Local validation script in `deploy/ops/wg-local-test.sh` proves the same primitives at scale=2.

### 7.5 Static analysis & secret scanning

- **Slither** runs on every push to `contracts/**`. Fails CI on high/critical findings; medium/low are reports.
- **Gitleaks** runs on every push with project allowlist in `.gitleaks.toml`.
- **CodeQL** workflow exists, gated on repo visibility / GHAS (private repo without GHAS = skipped).

### 7.6 Conventional invariants (do not break)

- `gasPrice = 0` is invariant. No gas-priced paths.
- `chain ID = 131216` is invariant.
- Every wallet must have ≥ 1 wei native HARA before its first tx (Besu silently drops zero-balance senders even at `gasPrice=0`). The `prefund-vault-key.sh` hook in hara-did's `infra/scripts/` automates this.

---

## 8. Deployment

See `deploy/topology.md` for the full 6-VPS layout. Summary:

| VPS | Specs | Role | Compose files |
|---|---|---|---|
| hara-v1..v4 | 4 vCPU / 8 GB / 100 GB | Validators (one per host) | `chain/docker-compose.validator-only.yml` (with `VALIDATOR_ID=N`) |
| hara-stateful | 8 vCPU / 32 GB / 1 TB | Postgres + Redis + Vault Raft + MinIO + chain init | `platform/docker-compose.secrets.yml`, `data/docker-compose.yml`, `data/docker-compose.minio.yml` |
| hara-stateless | 8 vCPU / 32 GB / 500 GB | RPC + LB + signer + broadcaster + indexer + rpc-cache + Blockscout + observability + Caddy | `rpc/`, `services/`, `platform/docker-compose.obs.yml`, `edge/docker-compose.yml` |

**Pre-VPS gating checklist (topology.md §9):**

| Gate | Status |
|---|---|
| 1. Vault Raft HA migration | ✅ done |
| 2. WireGuard mesh validated locally | ✅ done — `wg-local-test.sh` |
| 3. Snapshot+restore drill — Postgres | ✅ done — `snapshot-restore-drill.sh` |
| 3b. Snapshot+restore drill — validator data | ⏳ |
| 4. TLS plan ready (Caddy + DNS) | ✅ Caddy done; DNS still to register |
| 5. `secrets-bootstrap.sh` dry-run | ⏳ |
| 6. Compose file split | ✅ done |
| 7. First-VPS smoke test on Nevacloud | ⏳ |

**Bring-up sequence (topology.md §4):**
1. Panel-create 6 VPSes with `deploy/ops/cloud-init.yaml` in user-data.
2. `./deploy/ops/wg-bootstrap.sh` from operator laptop with `vps-hosts.env`.
3. On hara-stateful: `docker compose -f deploy/platform/docker-compose.secrets.yml up -d` → `./deploy/ops/vault-raft-init.sh` → `./deploy/ops/vault-approle-bootstrap.sh` → bring up data + MinIO → chain init.
4. On each hara-v1..v4: `docker compose -f deploy/chain/docker-compose.validator-only.yml up -d`.
5. On hara-stateless: bring up rpc/, services/, obs, edge.
6. `make deploy-all` (contracts).

---

## 9. Operations

### 9.1 Snapshots

| What | Script | Frequency | Destination |
|---|---|---|---|
| Postgres dump | `deploy/ops/snapshot-postgres.sh` | nightly 02:00 | object storage via rclone |
| Validator data | `deploy/ops/snapshot-validator.sh` | nightly 03:00 | object storage |
| Vault Raft snapshot | `deploy/ops/vault-raft-snapshot.sh` | nightly 04:00 | object storage |

Local retention: 7 days. Remote retention: 30 generations.

Round-trip validation script: `deploy/ops/snapshot-restore-drill.sh` (re-run after any schema migration).

### 9.2 Reset workflows

| Scenario | Procedure |
|---|---|
| Indexer cursor drift after chain wipe | `truncate indexed_events; update indexer_state set last_indexed_block=-1;` (TODO: `make reset-indexer`) |
| Chain wipe + redeploy | `make clean && make bootstrap && make up && make deploy-all` |
| Vault dev-mode key loss | re-run `chain/init/init.sh` via `make bootstrap` (DESTRUCTIVE on local; for prod, restore Vault Raft snapshot instead) |

### 9.3 Observability access

| Tool | URL (local) | URL (prod) |
|---|---|---|
| Grafana | http://localhost:3200 | https://grafana.hara.id |
| Prometheus | http://localhost:9090 | mesh-internal only |
| Loki | http://localhost:3201 | mesh-internal only |
| Alertmanager | http://localhost:9093 | mesh-internal only |
| Blockscout | http://localhost:4010 | https://explorer.hara.id |

### 9.4 Alert routing

Alertmanager → `alert-sink` webhook → (P0) Slack via `nevacloud-proposal.md` configured channel.

40+ pre-built alert rules in `deploy/platform/prometheus/alert_rules.yml`: validator down, block production stalled, RPC latency p99 > 500 ms, indexer lag > 60 blocks, rpc-cache miss rate > 20 %, Postgres replication lag (P1+), Vault sealed.

---

## 10. Coding conventions

### 10.1 TypeScript

- `strict: true` always.
- Never `any` in shared types. `catch (err: any)` is the house style for catch handlers (matched across all services).
- Use viem `Hex` / `Address` types over `string`.
- ES modules (`"type": "module"`).
- `pnpm` only — never `npm` or `yarn`.

### 10.2 Solidity

- OpenZeppelin v5 imports.
- `pragma solidity ^0.8.26;`.
- `evm_version = "london"` in `foundry.toml` — **invariant**, PUSH0 breaks Besu.
- Custom errors over `require(string)`.
- Tests use `import {Test, Vm} from "forge-std/Test.sol";` (`Vm` required for cheatcodes).
- **Foundry-test footgun:** `vm.prank()` only applies to the next call. Don't read role constants inside an `expectRevert` encoder under a prank — hoist them into locals first. Pattern:

```solidity
bytes32 anchorRole = registry.ANCHOR_ROLE();  // hoist OUT of the prank window
vm.prank(stranger);
vm.expectRevert(abi.encodeWithSelector(
  IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, anchorRole));
registry.recordAnchor(...);
```

Caused 3 false positives during the PQAnchorRegistry test session.

### 10.3 Transaction sending

- `--legacy` always.
- `gasPrice = 0` always.
- Pre-fund any new wallet with 1 wei before its first tx.
- For load tests: bypass HAProxy LB (rate-limit at 5 000 req/10 s nukes throughput); go direct to `rpc-write`.

### 10.4 Wallets in tests

Seed from `Date.now()` to avoid stale-state poisoning between runs.

### 10.5 Commit messages

Conventional-ish prefixes: `docs:`, `feat:`, `fix:`, `chore:`, `test:`, `ci:`, scope optional. Sign-off:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### 10.6 Linear history

No merge commits. Squash or rebase merge only. Branch protection (state-2 §11 #1) enforces once enabled.

---

## 11. CI / CD

Five workflows in `.github/workflows/`:

| Workflow | Triggers | Steps |
|---|---|---|
| `contracts.yml` | push/PR on `contracts/**` or workflow | forge build + 40 forge tests |
| `services.yml` | push/PR on `services/**` or workflow | pnpm install + per-package `tsc -b` matrix (shared, signer, broadcaster, indexer, migrate, rpc-cache) + docker build smoke |
| `slither.yml` | push/PR on `contracts/**` or workflow | Slither static analysis; SARIF upload guarded for private repos |
| `secret-scan.yml` | push/PR + weekly cron | gitleaks with project allowlist |
| `codeql.yml` | push/PR + weekly cron | CodeQL JS/TS; skipped on private repos without GHAS |

All include `workflow_dispatch` for manual re-runs.

**Branch protection (when enabled):**
- Required checks: `secret-scan`, `services`, `contracts / forge build + test`, `slither / Slither static analysis`
- Optional: `codeql` (until repo public or GHAS enabled)
- Require linear history, PR before merge, 1 reviewer, no force push, no deletions

---

## 12. Failure modes & recovery

### 12.1 Per-VPS failure matrix (production)

| What dies | Effect | Recovery |
|---|---|---|
| 1 of hara-v1..v4 | Chain keeps producing (QBFT needs 3 of 4) | Reprovision, cloud-init, pull key from Vault, rejoin. ~10 min |
| 2 of hara-v1..v4 | Chain HALTS (no quorum) | Restore one validator from snapshot. ~30 min |
| hara-stateful | Chain produces but writes hang (signer can't reach Postgres) | Restore Postgres + Vault from snapshots. ~15–30 min |
| hara-stateless | Public API offline; chain unaffected | Re-provision; pull images. ~5 min |
| Object storage | Backups stop landing; chain unaffected | Reconfigure rclone target |

Validator quorum risk is the only one without a fast-recovery answer — by design (BFT). Mitigation: geo-spread validators across two Nevacloud regions (P1).

### 12.2 Common operational gotchas

1. **Besu QBFT mempool ordering** — chained txs use `TraceabilityBatchRelay`. State-2 §9 #7.
2. **Zero-balance sender drop** — pre-fund 1 wei. `prefund-vault-key.sh` automates.
3. **Vault dev-mode restart** — chain stalls; restore via re-init (DESTRUCTIVE) or Raft snapshot (clean).
4. **MSYS path mangling** on `docker cp` from Git Bash — use stdin pipes or `MSYS_NO_PATHCONV=1`.
5. **`vm.prank()` consumed by role-constant read** — see §10.2 above.
6. **HAProxy rate limit in load tests** — bypass to direct write endpoint.
7. **Hardcoded deterministic addresses in migrations** — fixed in commit a858bf3 (deploy-driven registration).

---

## 13. Lessons learned (do not repeat)

From the in-tree project state-2 §12, expanded with this session's findings:

- Don't trust mempool ordering on Besu QBFT for chained txs → use the relay.
- Don't ship Shanghai bytecode → `evm_version = "london"` + `--legacy`.
- Don't leave wallets at zero native balance even when gas is free → pre-fund 1 wei.
- Don't route load tests through HAProxy → bypass to `rpc-write`.
- Don't reuse wallet seeds across runs → seed from `Date.now()`.
- Don't benchmark with `curl` on Windows → ~200 ms/call overhead. Use Node single-process.
- Don't try to verify ML-DSA on-chain today → ~5 M gas. Commit-only.
- Don't use `wget` healthcheck on Vault → use `vault status` CLI.
- Don't put hostnames in Besu enode URLs → "Invalid ip address". Use static IPs.
- Don't run Vault in dev-mode on a host that may reboot → Raft mode in production.
- Don't hardcode contract addresses in migrations → deploy-driven via `scripts/register-from-broadcast.sh`.
- Don't read role constants under an active `vm.prank()` → hoist out first.
- Don't pipe Windows `pg_dump` through `docker cp` → use stdin pipes.

---

## 14. Build & test

### 14.1 Contracts

```
make test                                  # forge test -vv
# or directly:
cd contracts && forge test                 # 40 tests
cd contracts && forge test --gas-report    # with gas accounting
```

### 14.2 Services

```
cd services
pnpm install
for p in shared signer broadcaster indexer migrate rpc-cache; do
  (cd "$p" && pnpm exec tsc -b)
done
```

`tsc -b` (not `tsc --noEmit`) because broadcaster/indexer/etc. use TS project references to `@hara/shared` via `composite: true`. CI uses the same command.

### 14.3 End-to-end smoke

```
make platform-up          # Vault + Prometheus + Grafana + Loki + Alertmanager
make bootstrap            # Generate QBFT genesis + validator keys + seed Vault
make up                   # Bring up validators + RPC + signer + broadcaster + indexer + cache
make deploy-all           # Deploy 6 contracts + register in watched_contracts
make status               # Show running services + block height
```

After 30 seconds, `make status` should show block production:

```
▶ Block height:
"result":"0x..."          # advancing, > 0
```

### 14.4 Local mesh validation

```
./deploy/ops/wg-local-test.sh             # 2-peer WireGuard mesh smoke
./deploy/ops/snapshot-restore-drill.sh    # Postgres dump → restore → verify
```

Both passed 2026-05-15.

---

## 15. Reference card

```
Repo:                https://github.com/imronzuhri-svg/hara-ledger
Chain ID:            131216
Native token:        HARA (gas price 0)
Block time:          ~2 s
Finality:            instant (QBFT)
Validators:          4 (10.42.0.11–14)
RPC read (local):    http://localhost:8545
RPC write (local):   http://localhost:8545 (same endpoint via LB)
WebSocket (local):   ws://localhost:8546
rpc-cache:           http://localhost:8088
Signer:              http://localhost:7000
Indexer:             http://localhost:9100
Blockscout:          http://localhost:4010
Grafana:             http://localhost:3200
Prometheus:          http://localhost:9090
Loki:                http://localhost:3201
Vault (dev):         http://localhost:8200  (token haraledger-dev-root)

Besu image:          hyperledger/besu:26.4.0
EVM version:         london
Solidity:            ^0.8.26
DID method:          did:hara
Anvil dev key:       0xac0974b... (fixtures only, never prod)

Maintainer:          @imronzuhri-svg
Companion repos:     hara-did, hara-halal-passport, hara-xchange

Pre-VPS gate status: see deploy/topology.md §9
```
