# HaraLedger — Technical Document

**Document type:** comprehensive technical reference.
**Audience:** engineers building on or operating HaraLedger; security auditors; ops on-call; ZK / PQ specialists.
**Companion:** `doc/haraledger - product document.md` (product-level overview).
**Snapshot:** 2026-05-19.

This document is the canonical technical reference for HaraLedger. It covers the chain layer, the service tier, the shared platform tier (and the boundary between them), every smart contract module, every service module, the post-quantum + privacy-by-design implementation, the deployed and planned infrastructure, ops procedures, and conventions.

If you need to know one technical thing about HaraLedger, look here first.

---

## Table of Contents

1. [Architecture & layering](#1-architecture--layering)
2. [HaraLedger vs HARA Platform separation](#2-haraledger-vs-hara-platform-separation)
3. [Network topology — 10.42.0.0/24](#3-network-topology--1042000024)
4. [Smart contracts — full module reference](#4-smart-contracts--full-module-reference)
5. [TraceabilityBatchRelay deep dive](#5-traceabilitybatchrelay-deep-dive)
6. [Services — full module reference](#6-services--full-module-reference)
7. [Anchor-worker module](#7-anchor-worker-module)
8. [Data model](#8-data-model)
9. [APIs](#9-apis)
10. [Privacy by Design — implementation](#10-privacy-by-design--implementation)
11. [Quantum-proof implementation](#11-quantum-proof-implementation)
12. [Security model](#12-security-model)
13. [Infrastructure — deployed today](#13-infrastructure--deployed-today)
14. [Infrastructure — planned (Nevacloud + Huawei)](#14-infrastructure--planned-nevacloud--huawei)
15. [Operations & runbooks](#15-operations--runbooks)
16. [Observability & tracing](#16-observability--tracing)
17. [CI / CD](#17-ci--cd)
18. [Coding conventions](#18-coding-conventions)
19. [Failure modes & recovery](#19-failure-modes--recovery)
20. [Lessons learned](#20-lessons-learned-do-not-repeat)
21. [Build & test](#21-build--test)
22. [Reference card](#22-reference-card)

---

## 1. Architecture & layering

HaraLedger is a five-tier system. Each tier has explicit contracts with the tiers above and below.

```
╔══════════════════════════════════════════════════════════════════════╗
║  Tier 5 — Application layer (companion product repos)                ║
║    hara-did       /  hara-halal-passport  /  hara-xchange            ║
║                                                                      ║
║    Read/write to chain via:                                          ║
║      • JSON-RPC          POST /rpc/write, /rpc/read  ─┐              ║
║      • WebSocket         /ws subscriptions            ├─ Caddy (TLS) ║
║      • Indexer REST      /trace/*                     │              ║
║      • PQAnchor verify   off-chain via MinIO blob     ┘              ║
║                                                                      ║
║    Owns: own contracts, own services, own Vault sub-tree.            ║
╠══════════════════════════════════════════════════════════════════════╣
║  Tier 4 — HaraLedger service tier (TypeScript, pnpm workspace)       ║
║                                                                      ║
║    signer          rpc-cache        indexer        anchor-worker     ║
║      │              │                  │              │              ║
║      ▼              ▼                  ▼              ▼              ║
║    broadcaster    HAProxy LB ─→ Besu RPC nodes ─→ validators (P2P)   ║
║                                                                      ║
║    migrate (Postgres schema), shared (lib)                           ║
╠══════════════════════════════════════════════════════════════════════╣
║  Tier 3 — HaraLedger chain tier                                      ║
║                                                                      ║
║    Besu QBFT, chain ID 131216, 2-second blocks, instant finality     ║
║    4 validators (10.42.0.11–14), 2 RPC read + 1 RPC write            ║
║                                                                      ║
║    Smart contracts: ContractRegistry, AnchorRegistry, PQAnchorReg,   ║
║      GovernanceContract, HaraPalmOil, TraceabilityBatchRelay,        ║
║      IssuerRegistry, TestToken                                       ║
╠══════════════════════════════════════════════════════════════════════╣
║  Tier 2 — HARA Platform — shared infrastructure                      ║
║    (sibling repo `_platform/`; not part of hara-ledger codebase)     ║
║                                                                      ║
║    Vault          (Raft in prod, dev-mode locally)                   ║
║    Prometheus, Alertmanager, alert-sink, Loki, Promtail, Grafana,    ║
║    Tempo (OTLP sink — added in latest commit)                        ║
║                                                                      ║
║    Phase 2: shared Postgres + Redis + MinIO at platform tier         ║
║    consumed by all products via DB / Redis-DB / bucket isolation     ║
╠══════════════════════════════════════════════════════════════════════╣
║  Tier 1 — Infrastructure                                             ║
║                                                                      ║
║    Local dev:                Docker Desktop on Windows/macOS/Linux   ║
║    P0.5 / P1:                6× Nevacloud VPSes + WireGuard mesh     ║
║    P2+:                      Nevacloud + Huawei DR                   ║
║    P3+:                      Multi-cloud + sovereign + bare-metal    ║
╚══════════════════════════════════════════════════════════════════════╝
```

### 1.1 Locked-in choices (do not re-litigate)

| Layer | Choice | Why |
|---|---|---|
| Consensus | Besu QBFT | Instant finality, IBFT successor, mature, Java/Hyperledger ecosystem |
| Contract lang | Solidity via Foundry | Speed of iteration; in-tree forge tests |
| EVM target | London (NOT Shanghai) | PUSH0 broke Besu deploys; pinned + `--legacy` txs |
| Service lang | TypeScript + pnpm workspaces | One language across the service tier |
| RPC client | viem | Modern types, better DX than ethers v5 |
| Queue | Redis Streams | Lightweight, already on stack; revisit at P2 if partitioning needed |
| Secrets | HashiCorp Vault | AppRole + Raft is well-trodden |
| Explorer | Blockscout | EVM-native, self-host, open source |
| Container | Docker Compose (P0–P1) → K3s (P2+) | Avoids k8s overhead at our size |
| Post-quantum | Hybrid ECDSA + ML-DSA-65, off-chain sig + on-chain commitment hash | On-chain verifier costs ~5 M gas today |
| TLS edge | Caddy + Let's Encrypt | Auto-renewal, no per-service TLS |

Explicit deferrals: Avalanche Subnet (P3), Polygon CDK (parallel track), zk-rollup with public L1 settlement (P3+).

---

## 2. HaraLedger vs HARA Platform separation

The most important architectural fact: **HaraLedger does not own Vault, observability, or shared data services. HARA Platform does.**

### 2.1 Repos and physical layout

```
~/projects/
├── _platform/              ← HARA Platform repo (sibling)
│   ├── docker-compose.yml    Vault + Prom + Alertmanager + alert-sink
│   │                         + Loki + Promtail + Grafana
│   ├── prometheus/
│   ├── grafana/
│   ├── alertmanager/
│   ├── loki/
│   ├── promtail/
│   └── alert-sink/
│
├── hara-ledger/            ← this repo
├── hara-did/
├── hara-halal-passport/
└── hara-xchange/
```

### 2.2 The contract between the tiers

| What HARA Platform provides | How HaraLedger consumes it |
|---|---|
| Vault at `http://vault:8200` on the `hara-platform` overlay network | AppRole login, scoped policy reads under `secret/haraledger/*` |
| Prometheus scrape target list (file-based) | HaraLedger services expose `/metrics` on known internal ports |
| Loki + Promtail (Docker log collection) | HaraLedger services emit JSON to stdout; promtail labels by container_name |
| Alertmanager with project-prefixed routing | HaraLedger ships `prometheus/alert_rules.yml` (per-project file) |
| Grafana with provisioned datasources | HaraLedger ships dashboards under `deploy/platform/grafana/provisioning/` |
| The `hara-platform` Docker network | HaraLedger containers join `external: true` |

### 2.3 Isolation contract — what no product can do

- Read another product's Vault paths. AppRole policies are path-prefixed; the `haraledger-signer` policy literally does not grant access to `secret/haradid/*`.
- Write another product's metrics. Metric names are project-prefixed and aggregated by Grafana's per-folder permissions.
- Use another product's Redis logical DB. `SELECT n` is scoped per service connection; collisions would manifest immediately in dev.
- Write to another product's Postgres DB (Phase 2). Each project has its own database user with grants only on its own database.

### 2.4 Bring-up ordering

```
1. make platform-up     (in sibling _platform/ dir)
   ↳ creates the hara-platform network, brings up Vault, obs

2. make bootstrap       (in hara-ledger/)
   ↳ runs the chain init container; writes keys to Vault, writes genesis

3. make up              (in hara-ledger/)
   ↳ brings up 4 validators + 3 RPC nodes + LB + signer + broadcaster + indexer + cache

4. make deploy-all      (in hara-ledger/)
   ↳ deploys 7 system contracts, registers with indexer

5. (other product) cd ../hara-did && ./dev.ps1 up
   ↳ hara-did consumes the SAME Vault, SAME observability, SAME chain
```

In production (P1+), step 1 is the very first thing the operator runs on `hara-stateful`. Steps 2–4 follow. Step 5 happens on `hara-stateless` (or its own VPS if companion products grow).

### 2.5 Local-dev convenience deviation

`deploy/platform/docker-compose.yml` (the local-dev variant inside hara-ledger) **bundles** Vault + observability in one stack for single-host smoke tests where the operator doesn't want to maintain the sibling `_platform/` repo. This is local convenience only. Production splits into `docker-compose.secrets.yml` (Vault Raft) on hara-stateful and `docker-compose.obs.yml` (Prom/Graf/Loki/AM/Tempo) on hara-stateless — per `deploy/topology.md` §5.

---

## 3. Network topology — 10.42.0.0/24

### 3.1 IP allocation table (verified zero collisions)

| IP | Container / role | Compose file |
|---|---|---|
| 10.42.0.2 | hara-caddy (prod) / hara-vault (dev only) | `edge/` or `platform/docker-compose.yml` |
| 10.42.0.3 | hara-prometheus | `platform/obs.yml` |
| 10.42.0.4 | hara-alertmanager | `platform/obs.yml` |
| 10.42.0.5 | hara-alert-sink | `platform/obs.yml` |
| 10.42.0.6 | hara-loki | `platform/obs.yml` |
| 10.42.0.7 | hara-grafana | `platform/obs.yml` |
| 10.42.0.8 | hara-promtail | `platform/obs.yml` |
| 10.42.0.9 | hara-tempo (OTLP sink) | `platform/obs.yml` |
| 10.42.0.11–14 | hara-validator1..4 | `chain/` |
| 10.42.0.20 | hara-lb (HAProxy) | `rpc/` |
| 10.42.0.22 | hara-rpc-read-1 (upstream) | `rpc/` |
| 10.42.0.23 | hara-rpc-read-2 (upstream) | `rpc/` |
| 10.42.0.24 | hara-rpc-write (upstream) | `rpc/` |
| 10.42.0.30 | hara-postgres | `data/` |
| 10.42.0.31 | hara-redis | `data/` |
| 10.42.0.40 | hara-vault (prod, Raft) | `platform/secrets.yml` |
| 10.42.0.41 | hara-signer | `services/` |
| 10.42.0.42 | hara-minio | `data/minio.yml` |
| 10.42.0.43 | hara-broadcaster | `services/` |
| 10.42.0.44 | hara-indexer | `services/` |
| 10.42.0.45 | hara-rpc-cache | `services/` |
| 10.42.0.46 | hara-blockscout (BE) | `services/` |
| 10.42.0.47 | hara-blockscout-fe | `services/` |
| **10.42.0.50–69** | **Reserved for hara-did** | sibling repo |
| **10.42.0.70–89** | **Reserved for hara-halal-passport** | sibling repo |
| **10.42.0.90–119** | **Reserved for hara-xchange** | sibling repo |

### 3.2 Per-host WG IP (production)

Each VPS's wg0 interface binds an IP in the same `10.42.0.0/24` range:

| VPS | wg0 IP | Container IPs co-located here |
|---|---|---|
| hara-v1 | 10.42.0.11 | hara-validator1 |
| hara-v2 | 10.42.0.12 | hara-validator2 |
| hara-v3 | 10.42.0.13 | hara-validator3 |
| hara-v4 | 10.42.0.14 | hara-validator4 |
| hara-stateless | 10.42.0.20 | hara-lb, rpc-read-1..2, rpc-write, signer, broadcaster, indexer, rpc-cache, anchor-worker, blockscout BE/FE, obs stack, Caddy |
| hara-stateful | 10.42.0.40 | hara-vault, postgres, redis, minio |

The deliberate overlap between the host's wg0 IP and the primary container IP (.20 = LB, .40 = Vault) is design: external services dial `http://10.42.0.40:8200` whether they're talking to the host's WG endpoint or to the Vault container directly — the routing collapses cleanly because Vault is the only thing listening on .40:8200 on hara-stateful.

### 3.3 Public-facing surface

Three hostnames through Caddy → Let's Encrypt → reverse-proxy on hara-stateless:

```
rpc.hara.id         /read/*   → rpc-cache:8088
                    /write/*  → HAProxy LB:8545
                    /ws       → HAProxy LB:8546

explorer.hara.id    /         → Blockscout FE:3000
                    /api/*    → Blockscout BE:4000

grafana.hara.id     /         → Grafana:3000
```

Vault never proxied through Caddy. Operator access via SSH tunnel only.

---

## 4. Smart contracts — full module reference

All contracts in `contracts/src/`. Tests in `contracts/test/`. Deploy scripts in `contracts/script/`. Toolchain: Foundry. `foundry.toml` pins `evm_version = "london"`, optimizer on.

### 4.1 ContractRegistry

```
contracts/src/ContractRegistry.sol
```

Address book for the platform. Maps `bytes32 name → (version → address)` with a single active version per name. Lets services discover contract addresses without hardcoding.

**Constructor:** `ContractRegistry(address admin)` — `admin` gets `REGISTRAR_ROLE`.

**Key functions:**
- `register(bytes32 name, uint16 version, address impl)` — add a new version.
- `getActive(bytes32 name) → address` — fetch current.
- `setActiveVersion(bytes32 name, uint16 version)` — bump active version.

**Tests:** 6 (first-version auto-activation, duplicate-version revert, non-registrar revert, zero-address revert, set-active-version, register-second-version-doesn't-change-active).

### 4.2 AnchorRegistry

```
contracts/src/AnchorRegistry.sol
```

Classical-only audit anchor commitments. Records Merkle roots of event ranges with optional external-chain confirmation (IOTA tx hash, Ethereum L1 tx hash).

**Constructor:** `AnchorRegistry(address admin)` — admin gets `ANCHOR_ROLE`.

**Key functions:**
- `recordAnchor(bytes32 merkleRoot, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain) → uint256 anchorId`
- `confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)`

**Tests:** 4.

### 4.3 PQAnchorRegistry (post-quantum)

```
contracts/src/PQAnchorRegistry.sol
```

Hybrid quantum-ready version. Commits `keccak256(ML-DSA-65 signature)` on-chain; actual signature blob in MinIO per ADR-0010 (lives in hara-did repo's docs/adr/).

**Constructor:** `PQAnchorRegistry(address admin, bytes32 initialPQKeyHash, string initialAlgorithm)`. Admin gets DEFAULT_ADMIN_ROLE + ANCHOR_ROLE + KEY_ROTATOR_ROLE.

**Key functions:**
- `recordAnchor(merkleRoot, sha3Root, blockFrom, blockTo, eventCount, anchorChain, pqSignatureHash)` — reverts on `EmptyRange` or `MissingPQCommitment`.
- `confirmExternalAnchor(anchorId, anchorTxHash)`
- `rotatePQKey(bytes32 newKeyHash, string newAlgorithm)` — KEY_ROTATOR_ROLE only.

**Per-anchor structure (frozen at signing time):**
```solidity
struct Anchor {
    bytes32 merkleRoot;
    bytes32 sha3Root;          // hash agility — alternate hash family
    uint64  blockFrom;
    uint64  blockTo;
    uint64  eventCount;
    uint64  timestamp;
    bytes32 anchorChain;
    bytes32 anchorTxHash;
    bytes32 pqSignatureHash;   // keccak256(ML-DSA-65 signature)
    bytes32 pqKeyHash;         // pubkey hash at signing time (FROZEN — not affected by future rotations)
}
```

**Tests:** 13.

### 4.4 GovernanceContract

```
contracts/src/GovernanceContract.sol
```

N-of-M multisig with emergency-pause. P0 ships as 1-of-1 (deployer-only); P1+ promotes to 3-of-5 for system contract operations.

**Constructor:** `GovernanceContract(address[] governors, uint256 threshold)`.

**Tests:** 4 (propose+execute 2-of-3, double-approve revert, execute-before-threshold revert, emergency pause).

### 4.5 HaraPalmOil — ERC-1155 with mass balance

```
contracts/src/HaraPalmOil.sol
```

ERC-1155 representing **litres** of sustainable palm oil. One token ID per batch.

**Per-batch metadata:**
```solidity
struct BatchMetadata {
    bytes32 rspoCertificateHash;
    bytes32 plantationId;
    uint64  productionDate;
}
mapping(uint256 batchId => BatchMetadata) public batches;
```

**Mass-balance invariant:** ERC-1155 transfer mechanics ensure you cannot transfer more litres than you hold — `_safeTransferFrom` calls `_update` which reverts on overflow / under-balance. Combined with mint being governance-gated, the total supply per batch is bounded.

**Mint:** `mintBatch(address firstOwner, uint256 batchId, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)` emits `BatchMinted(batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate)`.

**Transfer:** standard ERC-1155 `safeTransferFrom` and `safeBatchTransferFrom`. Each call emits `TransferSingle` (or `TransferBatch`) — the indexer picks these up into the `custody_hops` view.

**Tests:** 4 (mint+transfer, duplicate-batch revert, relay-emits-4-TransferSingle, relay-executes-chain).

### 4.6 IssuerRegistry

```
contracts/src/IssuerRegistry.sol
```

Role-gated registry of approved halal-certificate issuers (BPJPH, LPH, MUI). Consumed by `HaraPalmOil` / future `HalalPassport` mint paths.

**Roles:**
- `REGISTRAR_ROLE` — can `register` / `revoke` / `setMetadata` for issuer DIDs.
- `DEFAULT_ADMIN_ROLE` — can grant `REGISTRAR_ROLE` to BPJPH / LPH / MUI multisigs.

**Per-issuer record:**
```solidity
struct Issuer {
    string  did;             // did:hara:... format
    bytes32 issuerKind;      // keccak256("BPJPH"|"LPH"|"MUI")
    bool    active;
    uint64  registeredAt;
    uint64  revokedAt;       // 0 while active
}
mapping(address issuerAddress => Issuer) public issuers;
```

**Functional:** `register(address, string did, bytes32 issuerKind)`, `revoke(address)`, `isActive(address) → bool`, `issuerCount() → uint256`.

**Tests:** 17 (constructor roles; register happy path / re-register revert; revoke; isActive; setMetadata; AccessControl; events).

### 4.7 TraceabilityBatchRelay

See §5 for the deep dive on this module — it's central to the palm-oil traceability story and the workaround for a specific Besu QBFT quirk.

### 4.8 TestToken (fixture only)

```
contracts/src/TestToken.sol
```

Minimal ERC-20 mintable token used only by `ops/load-tests/`. Initial supply 1 000 000 HTST to deployer.

**Tests:** 9 (metadata, role assignment, mint by minter / granted minter / non-minter, transfer + balance, approve + transferFrom + allowance, OZ v5 custom-error reverts).

### 4.9 Deploy + auto-register flow

```
make deploy-all
```

Under the hood:

1. `forge script Deploy.s.sol:Deploy --legacy --skip-simulation` — deploys ContractRegistry + AnchorRegistry + GovernanceContract; auto-registers all three in ContractRegistry.
2. `scripts/register-from-broadcast.sh` parses `broadcast/*/131216/run-latest.json` and upserts every CREATE'd contract into Postgres `watched_contracts` so the indexer picks them up.
3. `forge script DeployPalmOil.s.sol:DeployPalmOil` (HaraPalmOil + TraceabilityBatchRelay) + register.
4. `forge script DeployPQAnchor.s.sol:DeployPQAnchor` — reads `CONTRACT_REGISTRY` from env (passed in from step 1's broadcast file) so the new PQAnchorRegistry registers itself; pre-deploys with a placeholder PQ key hash that **must be rotated** before any real anchor.
5. `forge script DeployIssuerRegistry.s.sol:DeployIssuerRegistry` + register.

### 4.10 Test totals

```
AnchorRegistry         4 tests
ContractRegistry       6 tests
GovernanceContract     4 tests
HaraPalmOil            4 tests
IssuerRegistry        17 tests
PQAnchorRegistry      13 tests
TestToken              9 tests
TraceabilityBatchRelay tests embedded in HaraPalmOil suite
─────────────────────────────────
                      57 tests, all green
```

---

## 5. TraceabilityBatchRelay deep dive

This module is HaraLedger's defining application-layer contract — the thing that makes palm-oil traceability actually work at scale on Besu QBFT.

### 5.1 The problem it solves

Besu QBFT's block builder **does not preserve mempool order** for chained transactions. If a refinery wants to transfer:

```
Plantation A → Mill B → Refiner C → Trader D → Manufacturer E
```

as five separate transactions submitted in nonce order, the block builder may pack them out of order. If transaction 3 (Refiner→Trader) is included before transaction 2 (Mill→Refiner), transaction 3 reverts (Refiner doesn't yet have the tokens). All downstream transactions revert too.

This is a real production issue, observed and documented in state-2 §9 #7 and §12.

### 5.2 The solution

**Within a single transaction, EVM execution is deterministic.** Solidity calls execute in the order written. So if all five transfers happen INSIDE one transaction, ordering is guaranteed.

`TraceabilityBatchRelay` is the contract that bundles N hops into one transaction.

### 5.3 Three entry points

```solidity
/// Uniform leg quantity (1 litre flowing through every node — common at mass-balance level)
function executeChain(
    address[] calldata participants,  // [Plantation, Mill, Refiner, Trader, Manufacturer]
    uint256 batchId,
    uint256 liters
) external;

/// Variable per-leg quantities (each hop can transfer a different amount)
function executeChainVariable(
    address[] calldata participants,
    uint256 batchId,
    uint256[] calldata legLiters       // [100, 50, 50, 50, 50] — 100 in, 100 out across two paths
) external;

/// Arbitrary topology (DAG, not just a chain — refineries merging streams)
function executeHops(
    Hop[] calldata hops                 // [{from, to, batchId, liters}, ...]
) external;
struct Hop { address from; address to; uint256 batchId; uint256 liters; }
```

### 5.4 Why three?

Different supply-chain topologies:

- **`executeChain`** — straight pipeline, uniform quantity. The 99 % case. ~360 k gas for 4 hops.
- **`executeChainVariable`** — straight pipeline, per-leg quantities. Refinery extraction-yield modelling.
- **`executeHops`** — arbitrary DAG. Merging streams (two plantations into one mill), splitting (one refinery feeds two manufacturers). Refinery DAG scenario in `ops/load-tests/scenario-refinery-dag.ts` uses this.

### 5.5 Authorisation model

The relay does **not** hold tokens. It calls `safeTransferFrom` on each `(from, to, batchId, liters)` tuple. Each `from` address must have `setApprovalForAll(relay, true)` on `HaraPalmOil` before the relay can act on their behalf.

This means:
- The relay is non-custodial.
- A compromised relay can do no more than what each participant already authorised.
- Authorisation revocation is per-participant (`setApprovalForAll(relay, false)`).

### 5.6 Event semantics

`executeChain([A, B, C, D, E], batchId=42, liters=100)` emits **four** `TransferSingle` events (A→B, B→C, C→D, D→E), all in the same transaction, in canonical order. The indexer ingests them as four rows in `indexed_events`, each becoming a row in the `custody_hops` view.

Test `test_RelayEmits4TransferSingleEvents` verifies this with `vm.recordLogs()` and assertion on the log count.

### 5.7 Performance

Measured on the local stack (`ops/load-tests/scenario-refinery-dag.ts`): 68 wallets, 8 stages, 224 transfers, 900 litres → 10 outputs, **all atomic in one block**.

Without the relay, the same scenario would need 224 separate transactions, of which 10–30 % would revert on a Besu QBFT mempool-order-reshuffle.

### 5.8 Lessons baked into the design

- **Use the relay for any chained-tx flow.** Direct `safeTransferFrom` chains across separate txs are broken at scale on Besu QBFT.
- **Pre-approve once per participant.** `setApprovalForAll(relay, true)` is paid by each wallet once; subsequent relay calls don't need participant signatures.
- **Variable-quantity vs uniform.** Use `executeChain` for the simple case; reach for `executeChainVariable` or `executeHops` only when needed.

---

## 6. Services — full module reference

Seven workspace packages in `services/`. All TypeScript, ES modules, pnpm workspace protocol.

### 6.1 shared (library)

```
services/shared/src/
  vault.ts    — Vault client with AppRole + token caching + 403 retry
  db.ts       — Postgres pool
  rpc.ts      — viem helpers
  logger.ts   — pino setup
  otel.ts     — OpenTelemetry SDK initialiser (side-effect import)
  index.ts    — re-exports
```

**`vault.ts` auth priority:**
1. `VAULT_APPROLE_ID` + `VAULT_APPROLE_SECRET` set → AppRole login, token cached in module-scope, refreshed `TOKEN_REFRESH_SLACK_SEC` (30 s) before expiry. Concurrent-login coalescing.
2. `VAULT_TOKEN` set → use directly (local dev).
3. Neither → throw at first read.

403 retry-once on the AppRole path handles the race where Vault rotates between cache and use.

**`otel.ts`** — side-effect import. Configured via env:
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
OTEL_SERVICE_NAME=signer
```
No-op if `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so dev environments don't need Tempo running.

### 6.2 signer

```
services/signer/src/index.ts
```

Nonce-safe transaction signer.

**Pipeline:**
1. Accept `POST /sign` request: `{from, to, data, value?, gasLimit?}`.
2. `SELECT FOR UPDATE` on `nonces` row for the from-address.
3. Build tx with the reserved nonce, sign with key fetched from Vault (`secret/haraledger/signer-keys/<role>`).
4. Bump `last_reserved` in `nonces` table.
5. Push signed tx to Redis Stream `tx:outbound`.
6. Return `{tx_id, tx_hash, nonce}`.

**Endpoints:**
- `POST /sign` — request a signed tx
- `GET /healthz` — `{ok: true}`
- `GET /metrics` — Prometheus exposition

### 6.3 broadcaster

```
services/broadcaster/src/index.ts
```

Drains `tx:outbound` Redis Stream, submits to write RPC, tracks status.

**Tx state machine (Postgres `transactions.status` enum):**
```
DRAFT → QUEUED → SIGNED → BROADCASTED → CONFIRMED
                                      ↘ REVERTED
                  ↘ FAILED ↗ RETRYING (transient)
```

Each `tx_attempts` row records one broadcast attempt with rpc_response JSONB for debugging.

Exponential backoff on transient failures: `2000 * 2^retry_count` ms.

### 6.4 indexer

```
services/indexer/src/index.ts
```

Block follower + REST API.

**Boot sequence:**
- Load `watched_contracts` (7 rows after `make deploy-all`).
- Read `indexer_state.last_indexed_block` cursor.
- Subscribe to `newHeads` via WebSocket.

**Per-block:**
- Fetch block + receipts via batch RPC (CONFIRMATIONS=1 buffer).
- For each log matching a `watched_contracts` address, decode against the contract ABI, write to `indexed_events`.
- Advance cursor.

**REST API (`/trace/*`):** see §9.2.

**Metrics:** Prometheus on `:9100/metrics` with `hara_indexer_*` prefix.

### 6.5 rpc-cache

```
services/rpc-cache/src/index.ts
```

Fastify proxy in front of read RPC.

**Method-specific TTLs:**

| Method | TTL |
|---|---|
| `eth_blockNumber` | 1 s |
| `eth_chainId` | 24 h |
| `eth_getBlockByNumber` (finalized) | 1 h |
| `eth_getBlockByNumber` (latest) | 1 s |
| `eth_getLogs` (fromBlock + toBlock both ≤ latest-32) | 1 h |
| Others | pass-through, no cache |

**99 % cache-hit rate** on representative read workloads. Cuts validator load 40–60 % under read pressure.

Prometheus metrics: hit / miss / bypass / errors per method.

Warmup on boot: fires the top 10 most-cacheable methods so the cache isn't cold at first traffic. Disable via `WARMUP_ON_START=0`.

### 6.6 migrate

```
services/migrate/src/index.ts
```

Schema migration runner. Walks `services/migrations/*.sql` in lexical order, applies any not in `_migrations` table, per-file transaction.

Current migrations:

| # | File | Purpose |
|---|---|---|
| 001 | `001_init.sql` | wallets, wallet_nonces, transactions, tx_attempts |
| 002 | `002_indexer_schema.sql` | indexer_state, watched_contracts, indexed_blocks, indexed_events |
| 003 | `003_traceability_view.sql` | custody_hops + batch_summary views (hardcoded INSERTs removed in commit `a858bf3` — deploy-driven registration) |
| 004 | `004_pq_anchor_signatures.sql` | off-chain PQ signature index per ADR-0010 |
| 005 | `005_pq_anchor_worker_state.sql` | anchor-worker singleton cursor |

### 6.7 anchor-worker

See §7 for the full deep dive.

### 6.8 No NestJS / Go yet

The `nevacloud-proposal.md` mentions "NestJS/Go sequencer" as a stack aspiration. The actual implementation is TypeScript via signer + broadcaster. Rewrite only if perf demands.

---

## 7. Anchor-worker module

### 7.1 Purpose

Closes the loop on ADR-0010 (PQ signature storage): the off-chain side (MinIO blob + Postgres index) is meaningless without an on-chain producer that actually anchors. The anchor-worker is that producer.

### 7.2 Module layout

```
services/anchor-worker/
├── package.json
├── tsconfig.json
├── Dockerfile
└── src/
    ├── index.ts       — cold-start bootstrap + cadence loop + canonical message + http server
    ├── config.ts      — env-driven config (PQ_ANCHOR_REGISTRY_ADDRESS, MinIO, RPC, etc.)
    ├── chain.ts       — viem wrappers for currentPQKeyHash, rotatePQKey, recordAnchor
    ├── merkle.ts      — keccak256 binary Merkle tree
    ├── pq.ts          — ML-DSA-65 keypair + sign + verify
    ├── store.ts       — MinIO PUT + Postgres index INSERT + cursor read/advance
    ├── vaultKey.ts    — Vault read with PQ field extension; cold-start key generation + write-back
    └── abi.ts         — minimal PQAnchorRegistry ABI inline
```

### 7.3 Cycle algorithm

```typescript
async function runOnce(): Promise<{status, events}> {
  const lastAnchored = await readCursor();           // Postgres pq_anchor_worker_state row
  const latestBlock  = await getBlockNumber();
  const safeTo       = latestBlock - 1n;             // lag 1 block for QBFT instant finality + paranoia
  if (safeTo <= lastAnchored) return noop;

  const events = await fetchEventsSince(lastAnchored, safeTo, maxEvents);
  if (events.length < minEvents) return noop;

  const leaves       = events.map(e => leafFromEvent(e.txHash, e.logIndex));  // keccak256(tx_hash || log_index)
  const { root }     = merkleRoot(leaves);
  const sha3Root     = root;                         // hash agility — same primitive today; differentiate at L8

  const msg          = canonicalMessage({ algorithm, root, blockFrom, blockTo, eventCount, anchorChain });
  const sig          = pqSign(secretKey, msg);       // 3309 bytes
  const commitHash   = keccak256(sig);

  const txReceipt    = await recordAnchor(...);      // on-chain
  await persistAnchor({ commitmentHash: commitHash, ... });  // MinIO + Postgres
  await advanceCursor(blockTo, anchorId);
}
```

### 7.4 Canonical message format

What ML-DSA-65 signs. Auditors reconstruct from the on-chain Anchor record + the blob's MinIO metadata:

```
[2 bytes BE]  algorithm string length
[N bytes  ]  algorithm string (e.g. "ML-DSA-65")
[32 bytes ]  Merkle root
[8 bytes BE] blockFrom uint64
[8 bytes BE] blockTo uint64
[8 bytes BE] eventCount uint64
[32 bytes ]  anchorChain tag (keccak256("hara-ledger") for self-anchoring)
```

**Total 90 + algo-len bytes.** Stable, trivially recomputable from on-chain data.

### 7.5 Cold-start bootstrap

```typescript
async function bootstrap() {
  const keys = await loadOrInitKeys();          // Read Vault; generate PQ pair if absent; write back
  await ensureWalletPrefunded(keys.ecdsaAddress);  // Refuses to start if zero balance

  const onChain = await currentPQKeyHashOnChain();
  if (onChain !== keys.pqKeyHashHex) {
    await rotatePQKey(keys.ecdsaPrivateKey, keys.pqKeyHashHex, algorithm);
    // Covers the placeholder hash that DeployPQAnchor.s.sol writes on first deploy
  }
}
```

### 7.6 Persistence (write order matters)

Per ADR-0010 §"Write path":

```typescript
async function persistAnchor(rec) {
  // 1. MinIO PUT first
  await minio.putObject(BUCKET, `ml-dsa-65/${hex(commitmentHash)}.sig`, sig, sig.length, metadata);

  // 2. Postgres INSERT (idempotent on commitment_hash PK)
  await pool.query(`INSERT INTO pq_anchor_signatures ... ON CONFLICT (commitment_hash) DO NOTHING`, ...);
}
```

Worst case = orphan blob in MinIO (recoverable by a reconciler). Reverse drift (row → missing blob) would fail audits closed; that's the failure mode we avoid.

### 7.7 Metrics

- `hara_anchor_anchors_total` (counter)
- `hara_anchor_events_per_anchor` (histogram, buckets [1, 10, 100, 1k, 10k, 100k])
- `hara_anchor_latency_ms` (histogram, buckets [100, 500, 1k, 5k, 30k, 120k])
- `hara_anchor_errors_total` (counter)

`/metrics` + `/healthz` on `:9102`.

### 7.8 Configuration

```
RPC_READ_URL                 default http://lb:8545/rpc/read
RPC_WRITE_URL                default http://lb:8545/rpc/write
CHAIN_ID                     131216
PQ_ANCHOR_REGISTRY_ADDRESS   required — output of make deploy-all
ANCHOR_INTERVAL_MS           600000 (10 min default per audit doc)
ANCHOR_MIN_EVENTS            1 (skip cycle if fewer)
ANCHOR_MAX_EVENTS            200000 (Merkle root sanity bound)
DATABASE_URL                 required — hara_indexer DB
PQ_ALGORITHM                 "ML-DSA-65"
ANCHOR_CHAIN_TAG             keccak256("hara-ledger")
MINIO_ENDPOINT               host:port
MINIO_ACCESS_KEY, _SECRET    required
PQ_BUCKET                    "hara-pq-anchors"
VAULT_ADDR                   default http://vault:8200
VAULT_APPROLE_ID, _SECRET    AppRole "anchor-worker"
ANCHOR_SIGNER_DID            optional; default did:hara:eth:<address>
METRICS_PORT                 9102
OTEL_EXPORTER_OTLP_ENDPOINT  optional (Tempo)
```

---

## 8. Data model

### 8.1 Postgres — `hara_indexer` DB on hara-stateful

**Migration 001 (tx pipeline):**
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

**Migration 002 (indexer):**
```sql
indexer_state(id=1 PK, last_indexed_block BIGINT, last_indexed_at)
watched_contracts(contract_address CHAR(42) PK, name, from_block, enabled, created_at)
indexed_blocks(block_number PK, block_hash, parent_hash, timestamp_unix, tx_count, indexed_at)
indexed_events(event_id BIGSERIAL PK, block_number, block_hash, tx_hash,
               log_index, contract_address, contract_name, event_signature, event_name,
               topics TEXT[], data TEXT, decoded JSONB, indexed_at,
               UNIQUE(block_hash, tx_hash, log_index))
```

**Migration 003 (traceability views):**
```sql
CREATE VIEW custody_hops AS
  SELECT decoded->>'batchId' AS batch_id,
         decoded->>'from'    AS from_addr,
         decoded->>'to'      AS to_addr,
         (decoded->>'value')::numeric AS liters,
         tx_hash, block_number, log_index
  FROM indexed_events
  WHERE contract_name = 'HaraPalmOil' AND event_name = 'TransferSingle';

CREATE VIEW batch_summary AS
  SELECT batch_id, count(*) AS hop_count,
         (array_agg(to_addr ORDER BY block_number DESC, log_index DESC))[1] AS current_holder,
         min(block_number) AS minted_block,
         max(block_number) AS last_hop_block
  FROM custody_hops
  GROUP BY batch_id;
```

**Migration 004 (PQ anchor index, per ADR-0010):**
```sql
CREATE TABLE pq_anchor_signatures(
  commitment_hash BYTEA PRIMARY KEY,   -- == on-chain keccak256(sig)
  algo            TEXT,                 -- 'ml-dsa-65'
  signer_did      TEXT,
  anchor_tx_hash  BYTEA,                -- 32 B
  bucket          TEXT DEFAULT 'hara-pq-anchors',
  object_key      TEXT,                 -- 'ml-dsa-65/<hex>.sig'
  size_bytes      INTEGER,
  created_at      TIMESTAMPTZ,
  CHECK octet_length(commitment_hash) = 32,
  CHECK octet_length(anchor_tx_hash)  = 32,
  CHECK size_bytes > 0
);
```

The blob itself is **never** in Postgres — keeps base backups flat.

**Migration 005 (anchor-worker cursor):**
```sql
CREATE TABLE pq_anchor_worker_state(
  id                  SMALLINT PK DEFAULT 1,
  last_anchored_block BIGINT NOT NULL DEFAULT -1,
  last_anchor_id      BIGINT,
  updated_at          TIMESTAMPTZ,
  CHECK (id = 1)
);
```

### 8.2 Redis

Logical DB allocation on the single shared instance:
- DB 0 — broadcaster `tx:outbound` stream
- DB 1 — rpc-cache key/value
- DB 2 — signer nonce coordination locks
- DB 3 — indexer cursor checkpoints
- DB 4 — Blockscout cache
- DB 5 — alert-sink deduplication
- **DB 6–8** — reserved for hara-did
- **DB 9–11** — reserved for hara-halal-passport
- **DB 12–13** — reserved for hara-xchange

### 8.3 Vault (KV v2 at `secret/`)

```
secret/haraledger/validators/{1..4}             # validator private keys
secret/haraledger/signer-keys/<role>            # deployer, anchor-worker, etc.
secret/haraledger/anchor/<period>               # produced by anchor worker
secret/haradid/signer-keys/<role>               # hara-did namespace
secret/harapassport/signer-keys/<role>          # hara-passport namespace
secret/haraxchange/signer-keys/<role>           # hara-xchange namespace
```

**AppRoles** (created by `vault-approle-bootstrap.sh`):

| AppRole | Policy | Path access |
|---|---|---|
| validator | haraledger-validator | read `validators/*` |
| signer | haraledger-signer | read `signer-keys/*` |
| anchor-worker | haraledger-anchor | read `signer-keys/anchor-worker` + RW `anchor/*` |

No service holds a root token in production.

### 8.4 MinIO buckets

| Bucket | Access | Purpose |
|---|---|---|
| `hara-chain-config` | anonymous-read (mesh-internal) | `genesis.json` + `static-nodes.json`; written once by chain init |
| `hara-pq-anchors` | private | ML-DSA-65 signature blobs per ADR-0010; key `ml-dsa-65/<hex>.sig` |

---

## 9. APIs

### 9.1 JSON-RPC

| Endpoint | Local | Prod |
|---|---|---|
| Read | `POST http://localhost:8545` | `POST https://rpc.hara.id/read/` |
| Write | `POST http://localhost:8545` | `POST https://rpc.hara.id/write/` |
| WS | `ws://localhost:8546` | `wss://rpc.hara.id/ws` |

Full Ethereum JSON-RPC + Besu admin extensions.

**Read path always goes through rpc-cache.** Writes go direct to LB → rpc-write.

### 9.2 Indexer REST

| Method | Path | Returns |
|---|---|---|
| GET | `/trace/batches?limit=N&offset=N` | List of batches with summary stats |
| GET | `/trace/batch/:id` | Full batch detail (mint info, RSPO hash, current holder, hop count) |
| GET | `/trace/batch/:id/hops` | Ordered hops `[{from, to, qty, tx_hash, block, ts}, …]` |
| GET | `/trace/batch/:id/graph` | Cytoscape/G6-compatible JSON (nodes + edges) |
| GET | `/metrics` | Prometheus exposition |
| GET | `/healthz` | `{ok: true}` |

### 9.3 Signer

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/sign` | `{from, to, data, value?, gasLimit?}` | `{tx_id, tx_hash, nonce}` |
| GET | `/healthz` | — | `{ok: true}` |
| GET | `/metrics` | — | Prometheus exposition |

### 9.4 Anchor-worker

| Method | Path | Returns |
|---|---|---|
| GET | `/metrics` | Prometheus exposition |
| GET | `/healthz` | `{ok: true}` |

(No external write API — cadence-driven worker.)

---

## 10. Privacy by Design — implementation

### 10.1 Hash-only on-chain

Where the on-chain code touches sensitive data:

```solidity
// HaraPalmOil.sol — bytes32 hashes, not strings
struct BatchMetadata {
    bytes32 rspoCertificateHash;   // hash, not URL
    bytes32 plantationId;          // hash, not GPS
    uint64  productionDate;        // unix timestamp; not PII
}

// IssuerRegistry.sol — DID string is on-chain, but it's a public W3C DID
// not a PII string. The wallet behind it is an Ethereum address (pseudonymous).
struct Issuer {
    string did;
    bytes32 issuerKind;           // keccak256("BPJPH"|"LPH"|"MUI")
    bool active;
    ...
}
```

### 10.2 Off-chain CAS for blobs

PQ signature blobs, hara-did Sidetree files, halal-passport images: all in MinIO with bucket-policy access control. On-chain stores `keccak256(blob)` only.

Auditors:
1. Fetch the blob from MinIO via presigned URL (issued by hara-did API on demand).
2. Compute `keccak256(blob)`.
3. Compare to the on-chain commitment.

A blob that doesn't match its on-chain commitment is invalid; no further verification needed.

### 10.3 Selective disclosure (planned, hara-did P1)

ZK predicate verifiers (deployed in hara-did):
- `AgePredicateVerifier` — prove `age ≥ N` without disclosing DOB.
- `ScoreThresholdVerifier` — prove `score ≥ N` without disclosing the score.
- `NonRevocationVerifier` — prove credential is not in the revocation accumulator without disclosing identity.

Verifier contracts accept a Groth16 / Plonk proof; emit success/failure. Hara-ledger services consume the verifier-emitted event to make policy decisions.

### 10.4 Vault AppRole scoping

Concrete example: the `anchor-worker` AppRole policy reads:

```hcl
path "secret/data/haraledger/signer-keys/anchor-worker" {
  capabilities = ["read"]
}
path "secret/data/haraledger/anchor/*" {
  capabilities = ["read", "create", "update"]
}
```

That's it. The anchor-worker cannot read validator keys, the deployer key, or any other product's secrets. If it's compromised, the blast radius is exactly the anchor-worker's signing key.

### 10.5 Audit log

Every Vault operation is audit-logged:
```hcl
audit "file" {
  file_path = "/vault/audit/audit.log"
}
```

Promtail watches this file → Loki → Grafana dashboard exposes Vault access patterns (logins per AppRole, read counts per path, denied operations).

### 10.6 Encryption at rest + transit

| Boundary | Encryption |
|---|---|
| Postgres on disk | LUKS host-volume encryption (P1+) |
| MinIO on disk | LUKS host-volume encryption (P1+) |
| Backups → Nevacloud Object Storage | TLS in transit, server-side encryption at rest |
| Inter-VPS traffic | WireGuard mesh (ChaCha20-Poly1305) |
| Internet → Caddy | Let's Encrypt TLS (ECDSA + X25519, hybrid Kyber when supported) |
| Caddy → internal services | Plaintext on the WireGuard mesh (already encrypted) |
| Vault data | Vault's internal encryption (AES-256-GCM keyring) |

### 10.7 Retention & deletion

- On-chain: immutable by design (regulatory requirement: 45 months minimum).
- Off-chain PII: hara-did Sidetree `deactivate` removes PII from MinIO (tombstone hash remains).
- Indexer state: lifetime of the chain.
- Operational logs: 90 days in Loki by default.
- Audit logs: 7 years (regulatory recommendation; configurable).

---

## 11. Quantum-proof implementation

### 11.1 ML-DSA-65 keypair management

The anchor-worker holds the ML-DSA-65 keypair in Vault as a single secret with 4 fields:

```json
{
  "address":       "0xab...",                              // ECDSA Ethereum address
  "private_key":   "0xcd...",                              // ECDSA 32-byte secret
  "pq_public_key": "0x... (3904 hex chars = 1952 bytes)",  // ML-DSA-65 public key
  "pq_secret_key": "0x... (8064 hex chars = 4032 bytes)"   // ML-DSA-65 secret key
}
```

Both keypairs are under the same AppRole policy (`haraledger-anchor`). One Vault path = one rotation operation = one audit entry.

### 11.2 Cold-start key generation

```typescript
// services/anchor-worker/src/vaultKey.ts
export async function loadOrInitKeys(): Promise<AnchorKeys> {
  const ecdsa = await fetchSignerKey(VAULT_PATH);     // ECDSA must pre-exist
  const secret = await readAnchorSecret();

  let pq: PqKeypair;
  if (secret.pq_public_key && secret.pq_secret_key) {
    pq = { publicKey: fromHex(secret.pq_public_key), secretKey: fromHex(secret.pq_secret_key) };
  } else {
    // First-run path: generate fresh PQ pair, write back to Vault (KV-v2 keeps prior version)
    pq = generateKeypair();
    await writePQFields(pq);
  }

  return { ...ecdsa, pq, pqKeyHashHex: toHex(publicKeyHash(pq.publicKey)) };
}
```

### 11.3 On-chain key rotation

On boot, the worker checks `currentPQKeyHash` on the contract. If it doesn't match `keccak256(local PQ pubkey)`, it calls `rotatePQKey()`. This covers:

- First deploy: `DeployPQAnchor.s.sol` writes a placeholder hash (`keccak256("BOOTSTRAP_PQ_KEY_PLACEHOLDER_V0_ROTATE_BEFORE_USE")`). Worker's first run rotates to the real key.
- Operator-initiated rotation: scrub the PQ fields from Vault, restart the worker. It regenerates + rotates.

**Existing anchors are unaffected by rotation** — their `pqKeyHash` field is FROZEN at signing time. Auditors verify against the historical key whose hash matches the on-chain commit.

### 11.4 Algorithm agility

`PQAnchorRegistry.currentPQAlgorithm` is a string. Future PQ algorithms (SLH-DSA, Falcon, post-quantum hash-based, lattice-2.0) plug in without contract changes:

```solidity
function rotatePQKey(bytes32 newKeyHash, string calldata newAlgorithm) external onlyRole(KEY_ROTATOR_ROLE);
```

MinIO bucket layout is algorithm-prefixed: `ml-dsa-65/<hash>.sig`, future siblings under `slh-dsa-sha2-128s/`, `falcon-512/`.

The `pq_anchor_signatures.algo` column distinguishes algorithms at audit time.

### 11.5 Off-chain audit verification flow

```
Auditor in 2034 wants to verify anchor #42 from 2026:

1. Read on-chain PQAnchorRegistry.anchors(42):
   { merkleRoot, sha3Root, blockFrom, blockTo, eventCount, timestamp,
     anchorChain, anchorTxHash, pqSignatureHash, pqKeyHash }

2. Fetch blob from MinIO bucket=hara-pq-anchors, key=ml-dsa-65/<pqSignatureHash>.sig

3. Compute keccak256(blob); compare to pqSignatureHash. Match? → OK.

4. Reconstruct canonical message from on-chain fields:
   canonicalMessage(algo, merkleRoot, blockFrom, blockTo, eventCount, anchorChain)

5. Fetch ML-DSA-65 public key whose hash matches pqKeyHash from:
   - hara-did DID document (for the signer's DID), OR
   - separate audit channel (BPJPH publication, ISO 27001 audit attestation)

6. Verify ML-DSA-65 signature(blob, canonical message, public key). Match? → Authoritative even post-CRQC.

7. (Optional, classical-only era) Verify ECDSA signature on the recordAnchor() tx.
```

### 11.6 Performance footprint

| Operation | Cost |
|---|---|
| ML-DSA-65 sign | ~25 ms @noble/post-quantum |
| ML-DSA-65 verify | ~5 ms |
| Sig size | 3309 bytes (FIPS 204) |
| Pubkey size | 1952 bytes |
| Secret key size | 4032 bytes |
| On-chain commit cost | ~30 k gas (vs ~5 M for on-chain verify) |
| Storage per anchor (Postgres index row) | ~200 bytes |
| Storage per anchor (MinIO blob) | 3309 bytes |
| Estimated 45-month total | ~13 GB MinIO blobs + ~3 GB Postgres index rows |

---

## 12. Security model

### 12.1 Threat model summary

| Threat | Mitigation |
|---|---|
| Single validator compromise | QBFT requires 3 of 4 honest — chain keeps producing |
| 2+ validator compromise | Chain halts (consensus property); restore from snapshots |
| Vault breach (root token) | AppRole-only in prod; root token never distributed; audit log captures every read |
| RPC layer DDoS | HAProxy rate limit (5 000 req/10 s/IP), rpc-cache absorbs 99 % of reads |
| Mempool ordering attack | TraceabilityBatchRelay bundles chained txs intra-transaction |
| ECDSA forgery (classical) | Multiple validators sign each block; revoke compromised key via governance |
| ECDSA forgery (CRQC) | Hybrid ML-DSA-65 commitments give authoritative audit even post-quantum |
| Backup theft | Backups encrypted at rest in Nevacloud Object Storage |
| Operator insider threat | Vault audit log, immutable on-chain history, 4-validator consensus |
| Supply-chain attack on dependencies | Slither + CodeQL + gitleaks in CI; pinned versions in lockfiles |

### 12.2 TLS architecture

- **Caddy on hara-stateless** terminates public TLS, auto-renews Let's Encrypt.
- All upstreams plaintext on the WireGuard mesh (already encrypted).
- Vault: never publicly exposed, ever.

### 12.3 Invariants

- `gasPrice = 0` is invariant. No gas-priced paths.
- `chain ID = 131216` is invariant.
- Every wallet must have ≥ 1 wei native HARA before its first tx (Besu drops zero-balance senders).

### 12.4 Static analysis & secret scanning

- **Slither** runs on every push to `contracts/**`. Fails CI on high/critical findings.
- **CodeQL default setup** scans JS/TS on every push to `main`.
- **Gitleaks** runs on every push with project allowlist in `.gitleaks.toml`.

---

## 13. Infrastructure — deployed today

### 13.1 Local development

Single host (developer laptop or VPS) running:

- Docker Desktop / Docker Engine
- Sibling `_platform/` repo for shared Vault + obs (one-time setup)
- `hara-ledger/` checkout

Bring-up:
```
cd _platform && make platform-up
cd ../hara-ledger && make bootstrap && make up && make deploy-all
```

Everything on the `hara-platform` Docker network at `10.42.0.0/24`.

### 13.2 6-VPS Nevacloud Option B (planned, documented, untested in prod)

Per `deploy/topology.md`:

| VPS | Specs | Role |
|---|---|---|
| hara-v1..v4 | 4 vCPU / 8 GB / 100 GB | Validators (one each) |
| hara-stateful | 8 vCPU / 32 GB / 1 TB | Vault + Postgres + Redis + MinIO + chain init |
| hara-stateless | 8 vCPU / 32 GB / 500 GB | RPC + LB + signer + broadcaster + indexer + rpc-cache + Blockscout + observability + Caddy + anchor-worker |
| Object Storage | 300 GB | Nightly backups (Postgres + Vault + validator data) |

Cost: **~Rp 7.3 M/month** (USD ~500/mo).

WireGuard mesh between all hosts. Genesis + static-nodes.json distributed via MinIO bucket `hara-chain-config` on first boot.

### 13.3 Pre-VPS gate status

| Gate | Status |
|---|---|
| 1. Vault Raft HA migration | ✅ |
| 2. WireGuard mesh validated locally | ✅ — `deploy/ops/wg-local-test.sh` |
| 3. Snapshot+restore drill — Postgres | ✅ — `deploy/ops/snapshot-restore-drill.sh` |
| 3b. Snapshot+restore drill — validator data | ✅ — `deploy/ops/validator-snapshot-restore-drill.sh` |
| 4. TLS plan ready | ✅ — Caddy + Let's Encrypt |
| 5. `secrets-bootstrap.sh` dry-run | ✅ — all 5 .env files generate cleanly chmod 600 |
| 6. Compose split | ✅ — secrets / obs / data / minio / edge files all separate |
| 7. First-VPS smoke test on Nevacloud | ⏳ awaiting provisioning |

---

## 14. Infrastructure — planned (Nevacloud + Huawei)

Beyond P0.5 / P1, the deployment evolves to multi-cloud.

### 14.1 P1 → P2 — Adding Huawei DR (month ~12)

Per `nevacloud-proposal.md` §Skenario "Lengkap" and `hara-ledger-roadmap.md` Decision 4:

```
┌───────────────────────────────────────────────────────────────┐
│  Nevacloud (Primary — sovereign Indonesian cloud)             │
│                                                               │
│  Multi-region: Jakarta + Surabaya                             │
│    • 4 validators (geo-spread across both regions)            │
│    • 2 hara-stateful instances (Postgres primary + standby)   │
│    • 2 hara-stateless instances (active-active)               │
│    • Full obs stack                                           │
│    • MinIO 4-disk cluster                                     │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼ async replication
┌───────────────────────────────────────────────────────────────┐
│  Huawei Cloud Indonesia (DR — secondary)                      │
│                                                               │
│    • 1 backup validator (warm spare; can become 5th of 5)    │
│    • 1 Postgres async replica                                 │
│    • 1 archive node (full chain history; pruned on prod)     │
│    • Huawei OBS — MinIO replication target                    │
│    • (Optional) Huawei AI services for OCR cert imaging       │
└───────────────────────────────────────────────────────────────┘
```

**Why Huawei specifically:**
- Strong Indonesian government relations.
- Indonesian sovereign cloud option (Huawei Cloud Stack — air-gapped tier available at P3).
- Native AI services (OCR for certificate document recognition).
- Decision 4 in roadmap: "Nevacloud primary + Huawei DR."

**Cost addition:** ~Rp 5–8 M/month.

### 14.2 P2 — National scale (months 10–22)

- 7–15 validators spread across:
  - Nevacloud (4–6 nodes)
  - Huawei Cloud (2–3 nodes)
  - 2–3 partner-operated regions (BPJPH, MUI provincial offices)
- HSM-backed Vault on Cloud KMS (Nevacloud + Huawei dual-cloud KMS).
- ClickHouse for analytics (event aggregations over the 175M+ event range).
- Dual L1 anchoring:
  - **IOTA L1** every 10 minutes (feeless, high-frequency)
  - **Ethereum L1** daily (credible cross-jurisdiction audit anchor)
- Multi-region active-active for the RPC tier.
- CDN edge (Cloudflare Workers) for the hara-passport public verification API at month 18+.

### 14.3 P3 — Global (months 22–40)

- 20–100+ validators across OIC member states + EU traceability extensions.
- Multi-cloud + sovereign cloud + bare-metal for the highest-trust nodes (regulator-operated).
- Avalanche Subnet migration rehearsal (Decision 12).
- ML-DSA-65 on-chain verification when EVM precompiles land.
- Quantum-safe TLS hybrids (Kyber-768 + X25519).

### 14.4 The Nevacloud + Huawei combination rationale

| Driver | Why this combination |
|---|---|
| Sovereignty (UU PDP) | Both clouds operate Indonesian sovereign regions. No US/EU hyperscaler primary footprint. |
| Vendor risk | Two independent providers — neither can leverage outage or pricing. |
| Compliance theatre | Indonesian-government-friendly providers; ISO 27001 + SOC 2 audits go smoother. |
| AI services | Huawei has the strongest native OCR + computer-vision stack in the Indonesian market for halal-cert document processing. |
| Air-gap option | Huawei Cloud Stack supports air-gapped sovereign deployments if regulators later require it. |
| Cost | Both are ~half the price of equivalent hyperscaler capacity in Indonesia. |

---

## 15. Operations & runbooks

### 15.1 Snapshot schedule (production)

| What | Script | Frequency | Destination |
|---|---|---|---|
| Postgres dump | `deploy/ops/snapshot-postgres.sh` | nightly 02:00 | Nevacloud Object Storage via rclone |
| Validator data | `deploy/ops/snapshot-validator.sh` | nightly 03:00 (one validator at a time) | Object Storage |
| Vault Raft snapshot | `deploy/ops/vault-raft-snapshot.sh` | nightly 04:00 | Object Storage |
| MinIO bucket sync | `rclone sync` | nightly 05:00 (P2: replicated to Huawei OBS in real-time) | Object Storage / Huawei OBS |

Local retention: 7 days. Remote retention: 30 generations.

### 15.2 Drills (run regularly to keep the muscle live)

| Drill | Script | Frequency |
|---|---|---|
| Postgres round-trip | `deploy/ops/snapshot-restore-drill.sh` | after every schema migration |
| Validator round-trip | `deploy/ops/validator-snapshot-restore-drill.sh` | quarterly |
| WireGuard mesh local | `deploy/ops/wg-local-test.sh` | after kernel updates |
| Secrets bootstrap | `deploy/ops/secrets-bootstrap.sh init` (in sandbox) | after env-template changes |

### 15.3 Reset workflows

| Scenario | Procedure |
|---|---|
| Indexer cursor drift after chain rebuild | `make reset-indexer` (truncates indexed_events, indexed_blocks; resets cursor) |
| Chain wipe + redeploy | `make clean && make bootstrap && make up && make deploy-all` |
| Vault dev-mode key loss (local) | Re-run `chain/init/init.sh` via `make bootstrap` (DESTRUCTIVE on local) |
| Vault Raft snapshot restore (prod) | `vault operator raft snapshot restore <file>` after manual unseal |

### 15.4 Observability access

| Tool | URL (local) | URL (prod) |
|---|---|---|
| Grafana | http://localhost:3200 | https://grafana.hara.id |
| Prometheus | http://localhost:9090 | mesh-internal only |
| Loki | http://localhost:3201 | mesh-internal only |
| Alertmanager | http://localhost:9093 | mesh-internal only |
| Tempo | mesh-internal :4318 | mesh-internal :4318 |
| Blockscout | http://localhost:4010 | https://explorer.hara.id |

### 15.5 Alert routing

Alertmanager → `alert-sink` webhook → Slack (P0). At P1+, alert-sink fans out to PagerDuty + email + Slack.

40+ pre-built alert rules in `deploy/platform/prometheus/alert_rules.yml`:

- `HaraValidatorDown` — any of 4 validators offline for > 30 s
- `HaraBlockProductionStalled` — no new block in > 30 s
- `HaraRPCLatencyP99High` — p99 > 500 ms over 5-min window
- `HaraIndexerLag` — last_indexed_block falls > 60 blocks behind chain tip
- `HaraRPCCacheMissRateHigh` — > 20 % miss rate
- `HaraVaultSealed` — Vault returns sealed state
- `HaraPostgresReplicationLag` — replica lag > 60 s (P1+ when replica exists)
- `HaraAnchorWorkerError` — anchor cycle errors > 0 in last hour

---

## 16. Observability & tracing

### 16.1 Prometheus metric naming

All hara-ledger metrics prefixed `hara_`:

- `hara_ledger_*` — chain-level metrics (block production, validator status)
- `hara_indexer_*` — indexer
- `hara_signer_*` — signer
- `hara_broadcaster_*` — broadcaster
- `hara_rpc_cache_*` — rpc-cache (hit/miss/bypass per method)
- `hara_anchor_*` — anchor-worker (anchors_total, events_per_anchor, latency_ms, errors_total)

Companion products use their own prefix (`hara_did_*`, `hara_passport_*`).

### 16.2 OpenTelemetry distributed tracing

Every TS service imports `@hara/shared/otel` as a side-effect:

```typescript
// services/anchor-worker/src/index.ts (and every other service)
import "@hara/shared/otel";
```

`otel.ts` initialises the OTel Node SDK with OTLP/HTTP exporter pointing at `OTEL_EXPORTER_OTLP_ENDPOINT` (Tempo container at `http://tempo:4318` in the obs stack). No-op if env unset, so local dev without Tempo doesn't fail.

### 16.3 Tempo

Added to `deploy/platform/docker-compose.obs.yml` at IP `10.42.0.9`. Container `hara-tempo`, port `4318` (OTLP/HTTP, what `@opentelemetry/exporter-trace-otlp-http` speaks).

Grafana is auto-provisioned with a Tempo datasource — traces correlate with logs (Loki) and metrics (Prometheus) on the same dashboard.

### 16.4 Trace propagation

OTel auto-instruments:
- `pg` library (Postgres queries)
- `fetch` (Vault + MinIO calls)
- `pino` log correlation (traceId injected into every log line)
- viem RPC calls (manual span on `walletClient.writeContract` in anchor-worker)

End-to-end trace: signer POST /sign → broadcaster Redis Stream consume → tx broadcast → confirmation → indexer ingestion → anchor-worker pulls into a Merkle root → recordAnchor tx → MinIO PUT → Postgres INSERT. All one trace ID across 4+ services.

---

## 17. CI / CD

Five workflows in `.github/workflows/`:

| Workflow | Triggers | Steps |
|---|---|---|
| `contracts.yml` | push/PR on `contracts/**` | `forge build` + 57+ forge tests |
| `services.yml` | push/PR on `services/**` | `pnpm install` + per-package `tsc -b` matrix (shared, signer, broadcaster, indexer, migrate, rpc-cache, anchor-worker) + docker build smoke |
| `slither.yml` | push/PR on `contracts/**` | Slither static analysis; SARIF upload guarded for private repos |
| `secret-scan.yml` | push/PR + weekly cron | gitleaks with project allowlist |
| `codeql.yml` | push/PR + weekly cron | CodeQL JS/TS (advanced workflow); gated on `vars.HARA_ADVANCED_CODEQL == 'true'` because GitHub default setup is currently active |

All include `workflow_dispatch` for manual re-runs.

Branch protection (state-2 §11 #1) plan:
- Required checks: `secret-scan`, `services`, `contracts / forge build + test`, `slither / Slither static analysis`
- Require linear history, PR before merge, 1 reviewer, no force push, no deletions

---

## 18. Coding conventions

### 18.1 TypeScript
- `strict: true` always.
- Never `any` in shared types. `catch (err: any)` is house style for catch handlers.
- Use viem `Hex` / `Address` over `string`.
- ES modules (`"type": "module"`).
- pnpm only — never npm or yarn.

### 18.2 Solidity
- OZ v5 imports.
- `pragma solidity ^0.8.26;`.
- `evm_version = "london"` invariant in `foundry.toml`.
- Custom errors over `require(string)`.
- Tests use `Test, Vm` from forge-std.
- **`vm.prank()` only applies to the next call.** Don't read role constants inside an `expectRevert` encoder under a prank — hoist them into locals first:

```solidity
bytes32 anchorRole = registry.ANCHOR_ROLE();  // hoist OUT of prank window
vm.prank(stranger);
vm.expectRevert(abi.encodeWithSelector(
  IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, anchorRole));
registry.recordAnchor(...);
```

### 18.3 Transaction sending
- `--legacy` always (Besu rejects EIP-1559 at gasPrice=0).
- `gasPrice = 0` invariant.
- Pre-fund any new wallet with ≥1 wei before its first tx.
- Load tests: bypass HAProxy LB (rate limit nukes throughput); go direct to `rpc-write`.

### 18.4 Commit messages
- Conventional prefixes: `feat(scope):`, `fix(scope):`, `docs:`, `test:`, `chore:`, `ci:`.
- Subject ≤ 72 chars.
- AI-assisted commits include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

### 18.5 Linear history
No merge commits. Squash or rebase merge only.

---

## 19. Failure modes & recovery

### 19.1 Per-VPS failure matrix (production P1+)

| What dies | Effect | Recovery |
|---|---|---|
| 1 of hara-v1..v4 | Chain keeps producing (QBFT 3 of 4) | Reprovision, cloud-init, pull key from Vault, rejoin. ~10 min |
| 2 of hara-v1..v4 | Chain HALTS | Restore from snapshot. ~30 min. **The only fast-recovery gap** — mitigated by geo-spread |
| hara-stateful | Chain produces but writes hang (signer can't reach Postgres/Vault) | Restore Postgres + Vault Raft from snapshots. ~15–30 min |
| hara-stateless | Public API offline; chain unaffected | Re-provision; pull images; up. ~5 min |
| Object storage | Backups stop landing; chain unaffected | Reconfigure rclone target |
| Huawei DR cloud | No DR — primary unaffected | Failover plan never invoked unless Nevacloud catastrophic |

### 19.2 Common gotchas

1. **Besu QBFT mempool ordering** — use `TraceabilityBatchRelay` for chained txs.
2. **Zero-balance sender drop** — pre-fund 1 wei.
3. **Vault dev-mode restart** — chain stalls; restore via re-init (DESTRUCTIVE) or Raft snapshot (clean).
4. **MSYS path mangling** on `docker cp` from Git Bash — use stdin pipes or `MSYS_NO_PATHCONV=1`.
5. **`vm.prank()` consumed by role-constant read** — hoist out first.
6. **HAProxy rate limit in load tests** — bypass to direct write endpoint.
7. **Hardcoded deterministic addresses in migrations** — fixed in commit `a858bf3`; never re-introduce.
8. **CodeQL advanced + default setup conflict** — gated on `vars.HARA_ADVANCED_CODEQL` (commit `d91589f`).

---

## 20. Lessons learned (do not repeat)

From state-2 §12 + this session's findings:

- Don't trust mempool ordering on Besu QBFT for chained txs → use TraceabilityBatchRelay.
- Don't ship Shanghai bytecode → `evm_version = "london"` + `--legacy`.
- Don't leave wallets at zero native balance even when gas is free → pre-fund 1 wei.
- Don't route load tests through HAProxy → bypass to `rpc-write`.
- Don't reuse wallet seeds across runs → seed from `Date.now()`.
- Don't try to verify ML-DSA on-chain today → ~5 M gas. Commit-only.
- Don't use `wget` healthcheck on Vault → use `vault status` CLI.
- Don't put hostnames in Besu enode URLs → "Invalid ip address". Use static IPs.
- Don't run Vault in dev-mode on a host that may reboot → Raft mode in production.
- Don't hardcode contract addresses in migrations → deploy-driven via `scripts/register-from-broadcast.sh`.
- Don't read role constants under an active `vm.prank()` → hoist out first.
- Don't pipe Windows `pg_dump` through `docker cp` → use stdin pipes.
- Don't run advanced CodeQL workflows when default setup is enabled → opt-in via repo variable.
- Don't ignore `set -e` + `set -o pipefail` + `tr | head` interactions → wrap in `(set +o pipefail; ...)`.
- Don't deploy IP-overlapping containers → check for collisions before bringing up multi-tier compose files.

---

## 21. Build & test

### 21.1 Contracts

```
make test                                  # forge test -vv
# or directly:
cd contracts && forge test                 # 57+ tests
cd contracts && forge test --gas-report    # with gas accounting
```

### 21.2 Services

```
cd services
pnpm install
for p in shared signer broadcaster indexer migrate rpc-cache anchor-worker; do
  (cd "$p" && pnpm exec tsc -b)
done
```

`tsc -b` (not `tsc --noEmit`) because broadcaster/indexer/anchor-worker use TS project references to `@hara/shared` via `composite: true`. CI uses the same command.

### 21.3 End-to-end smoke

```
make platform-up          # sibling _platform/ — Vault + Prom + Grafana + Loki + Alertmanager
make bootstrap            # Generate QBFT genesis + validator keys + seed Vault
make up                   # Bring up validators + RPC + signer + broadcaster + indexer + cache
make deploy-all           # Deploy 7 contracts + register in watched_contracts
make status               # Show running services + block height
```

### 21.4 Local drills (re-runnable)

```
./deploy/ops/wg-local-test.sh                       # 2-peer WireGuard mesh smoke
./deploy/ops/snapshot-restore-drill.sh              # Postgres dump → restore → verify
./deploy/ops/validator-snapshot-restore-drill.sh    # Validator stop → tar → wipe → restore → rejoin
./deploy/ops/secrets-bootstrap.sh init              # In a sandbox — generate .env templates
```

---

## 22. Reference card

```
Chain
  Chain ID:           131216
  Native token:       HARA (gas price 0 — invariant)
  Block time:         ~2 s
  Finality:           instant (QBFT)
  Validators:         4 (10.42.0.11–14)
  Besu image:         hyperledger/besu:26.4.0
  EVM version:        london (Shanghai breaks Besu)

Local URLs (dev)
  RPC read/write:     http://localhost:8545
  WebSocket:          ws://localhost:8546
  rpc-cache:          http://localhost:8088
  Signer:             http://localhost:7000
  Indexer:            http://localhost:9100
  Anchor worker:      http://localhost:9102
  Blockscout:         http://localhost:4010
  Grafana:            http://localhost:3200
  Prometheus:         http://localhost:9090
  Loki:               http://localhost:3201
  Tempo (OTLP HTTP):  http://localhost:4318
  Vault (dev):        http://localhost:8200  (token haraledger-dev-root)

Languages & toolchain
  Solidity:           ^0.8.26
  Foundry:            forge + cast
  TS:                 strict mode, ES modules, pnpm 9.12.0
  Node:               20+

Crypto
  Classical:          ECDSA secp256k1 (Ethereum standard)
  PQ signature:       ML-DSA-65 / Dilithium 3 (FIPS 204) via @noble/post-quantum
  PQ pubkey size:     1952 B
  PQ signature size:  3309 B

Storage & secrets
  Vault (prod):       Raft, AppRole-only, single-node P1 → multi-node P2+
  Postgres (prod):    hara_indexer DB, 1 TB NVMe on hara-stateful
  MinIO buckets:      hara-chain-config (genesis/static-nodes)
                      hara-pq-anchors (ML-DSA-65 signature blobs)
  Backups:            nightly, zstd-compressed, rclone → Nevacloud Object Storage

Cloud
  Primary:            Nevacloud (Indonesian sovereign)
  DR (P2+):           Huawei Cloud Indonesia
  Future (P3+):       Multi-cloud + sovereign + bare-metal

Repos
  hara-ledger:        https://github.com/imronzuhri-svg/hara-ledger
  hara-did:           sibling repo
  hara-halal-passport: sibling repo
  hara-xchange:       sibling repo
  _platform/:         shared infra (sibling repo)

Maintainer:           @imronzuhri-svg
DID method:           did:hara
Anvil dev key:        0xac0974b... (fixtures only, never prod)
```
