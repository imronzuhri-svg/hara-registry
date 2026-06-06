# HaraLedger — Project State 2

**Snapshot date:** 2026-05-14
**Repo:** https://github.com/imronzuhri-svg/hara-registry
**Branch:** `main` @ `6dac91c`
**Purpose:** Compact carry-on document. Read this first to resume work without re-deriving context.

---

## 1. What HaraLedger Is

Private permissioned EVM chain for Indonesian **halal certification + palm-oil traceability**, plus the ecosystem services around it (signer, broadcaster, indexer, rpc-cache, observability, explorer).

Companion products (separate repos, share the platform):
- **hara-did** — `did:hara` method, Sidetree-anchored, ZK selective disclosure planned.
- **hara-halal-passport** — soulbound ERC-721 halal certificates.
- **hara-xchange** — exchange/market layer.

Forty-five-month target workload: 25,000 palm-oil batches × ~7,000 transfers each + 4,000,000 halal passport NFTs.

---

## 2. Architecture

### Chain layer
- **Consensus:** Hyperledger Besu **QBFT**, 4 validators, instant finality, 2 s blocks.
- **Chain ID:** `131216`. Native token: HARA (gas price 0).
- **EVM target:** **London** (not Shanghai — `evm_version = "london"` in `foundry.toml`, txs sent with `--legacy`). PUSH0 was breaking deploys.
- **Image:** `hyperledger/besu:26.4.0`.

### Validator IPs (static, 10.42.0.0/24 platform network)
| Node | IP |
|---|---|
| validator-1..4 | 10.42.0.11–14 |
| rpc-read / rpc-write | 10.42.0.20 / 10.42.0.21 |
| Postgres / Redis / Vault | 10.42.0.30 / 10.42.0.31 / 10.42.0.40 |
| **Reserved for hara-did** | 10.42.0.50–69 |
| Reserved hara-passport | 10.42.0.70–89 |

### Service tier (`services/`, pnpm workspace, TypeScript)
- `shared/` — common types, Vault client, Postgres pool, viem helpers.
- `signer/` — nonce-safe signer, Postgres `FOR UPDATE` nonce manager, Vault-backed keys.
- `broadcaster/` — Redis Streams consumer → submits to write RPC.
- `indexer/` — block follower, REST API at `/trace/*` (batches, hops, graph).
- `migrate/` — schema migrations (currently up to `003_*`).
- `rpc-cache/` — Fastify proxy in front of read RPC. Method-specific TTLs (1 s `blockNumber`, 1 h finalized blocks, 24 h `chainId`). **99 % cache-hit rate measured.** Prometheus metrics + warmup.

### Front-of-chain
- **HAProxy LB:** maxconn 32 000, 16 threads, rate limit 5 000 req / 10 s. Reads via `rpc-read`, writes via `rpc-write`.
- **Besu flags:** `--rpc-http-max-active-connections=4000`, `--rpc-http-max-batch-size=4096`.

### Storage / coord
- **Postgres** (shared): `hara_ledger` DB, planned `hara_did` and `hara_passport` DBs in same instance.
- **Redis** (shared): DBs 0–5 used by hara-registry; DBs **6–8 reserved for hara-did**, 9–11 for passport.
- **Vault** (dev mode now; planned Raft HA + AppRole for prod). Namespace convention:
  - `secret/haraledger/...`
  - `secret/haradid/...`
  - `secret/harapassport/...`

### Observability stack
- Prometheus + Grafana (`localhost:3200`) + Loki (`localhost:3201`) + Promtail + Alertmanager.
- **Blockscout** explorer integrated.
- Metric prefix convention: `hara_ledger_*`, `hara_did_*`, `hara_passport_*`.

### Quantum-readiness
- **PQAnchorRegistry** — hybrid ECDSA + ML-DSA-65 (NIST FIPS 204).
- Strategy: PQ signature itself stays **off-chain**; only the commitment hash goes on-chain (avoids ~5 M gas verifier cost).
- Full rationale in `doc/technical/audit-security-quantum-performance.md`.

---

## 3. Smart Contracts (`contracts/src/`)

| Contract | Role |
|---|---|
| `AnchorRegistry.sol` | DID/payload anchor commitments. |
| `PQAnchorRegistry.sol` | Hybrid ECDSA + ML-DSA-65 anchors. |
| `ContractRegistry.sol` | Address registry for all deployed system contracts. |
| `GovernanceContract.sol` | Role/governance gating. |
| `HaraPalmOil.sol` | **ERC-1155** representing volume (litres) of sustainable palm oil. Metadata: `rspoCertificateHash`, `plantationId`, `productionDate`. |
| `TraceabilityBatchRelay.sol` | Records N hops in **one transaction** (intra-tx execution is deterministic — solves Besu QBFT mempool-order issue). Methods: `executeChain`, `executeChainVariable`, `executeHops`. |

**Toolchain:** Foundry. `foundry.toml` pinned: `evm_version = "london"`, optimizer on. Anvil deployer key `0xac0974b...` reserved for fixtures only.

---

## 4. APIs

### Chain RPC
- Read: `http://rpc-read:8545` (LB → cache → Besu RPC nodes)
- Write: `http://rpc-write:8545`
- WebSocket: `ws://rpc-read:8546`
- Cache prom metrics: `http://rpc-cache:9090/metrics`

### Indexer REST (`/trace/*`)
- `GET /trace/batches` — list batches.
- `GET /trace/batch/:id` — full batch detail.
- `GET /trace/batch/:id/hops` — hops in order.
- `GET /trace/batch/:id/graph` — graph JSON (used by viewer).

### Viewer
- `ops/traceability-view/viewer.html` — dual renderer **Cytoscape + AntV G6**, 7 + 9 layouts, source/output pinning toggle.

### Vault paths (convention)
```
secret/haraledger/keys/<role>
secret/haradid/keys/<role>
secret/harapassport/keys/<role>
```

---

## 5. Postgres Schemas (key tables)

```
indexed_events(id, block, tx_hash, log_index, contract, event, args_json, cursor)
watched_contracts(address, name, abi_hash, enabled)
nonces(address, next_nonce)          -- FOR UPDATE locked
batches(id, source, created_at, ...)
hops(batch_id, seq, from_addr, to_addr, qty, tx_hash)
```

Migrations are sequential numbered files in `services/migrate/migrations/`; **003** was rebuilt to DELETE+INSERT stale palm-oil addresses from `watched_contracts`.

---

## 6. Chosen Stack (locked-in choices, do not re-litigate)

| Layer | Choice | Why |
|---|---|---|
| Consensus | Besu QBFT | Instant finality, IBFT successor, mature. Avalanche/Polygon-CDK explicitly **deferred**. |
| Contract lang | Solidity via Foundry | Speed of iteration; forge tests in-tree. |
| EVM target | London | PUSH0 (Shanghai) broke Besu deploys. |
| Service lang | TypeScript + pnpm workspaces | Single language across signer/indexer/cache. |
| RPC client | viem | Modern; better types than ethers v5. |
| Queue | Redis Streams | Lightweight; already on stack. |
| KMS | HashiCorp Vault | AppRole + Raft path is well-trodden. |
| Explorer | Blockscout | EVM-native, self-host, open source. |
| Container | Docker Compose (dev) → Swarm overlay or WireGuard mesh (prod) | Avoids k8s overhead for this size. |
| DID method | `did:hara` (Sidetree-anchored hybrid IssuerRegistry) | W3C/DIF compliant; anchors via `AnchorRegistry`. |
| Passport NFT | ERC-721 soulbound | Non-transferable cert semantics. |
| Palm oil token | ERC-1155 (litres) | Fungible per-batch, multi-batch in one contract. |
| PQ | Hybrid ECDSA + ML-DSA-65, off-chain sig + on-chain commitment | On-chain verifier too expensive today. |

---

## 7. Coding Conventions

- **TypeScript:** strict mode; never `any` in shared types; use viem `Hex`/`Address` types.
- **Solidity:** OpenZeppelin v5 imports; `evm_version = "london"`; tests use `import {Test, Vm} from "forge-std/Test.sol"` (Vm is required for cheatcodes).
- **Tx sending:** always `--legacy` in scripts; gas price 0; pre-fund 1 wei native HARA to any wallet before its first tx (**Besu silently skips zero-balance senders even at gasPrice=0** — bitten us multiple times).
- **Wallets in tests:** seed from `Date.now()` to avoid stale-state poisoning between runs.
- **Load tests:** go direct to `rpc-write`, **bypass HAProxy** (LB rate limit nukes throughput).
- **Mass-balance for traceability:** generator tracks per-wallet balances in a `Map<Address, bigint>`; throws on insufficient; asserts `Σincoming == Σoutgoing` at every node.
- **Commits:** Conventional-ish prefixes (`docs:`, `feat:`, `fix:`, `chore:`). Sign-off with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **CI gates** (must pass before merge once branch protection is live):
  - `forge build + test` (contracts.yml)
  - `typecheck + build` (services.yml)
  - CodeQL JS/TS
  - Slither
  - Gitleaks (allowlist in `.gitleaks.toml`)
- **Linear history only.** No merge commits. Squash or rebase merge.

---

## 8. Current Files (key)

### Docs (`doc/`)
- `haraledger_ecosystem_development_blueprint.md` — original blueprint.
- `hara-registry-roadmap.md` — staged roadmap (L0 → L5+).
- `haradid-pathway.md` — hara-did product pathway (anchored + ZK).
- `audit-security-quantum-performance.md` — full security + PQ rationale.
- `nevacloud-proposal.md` — VPS sizing (5/6/8 options).
- `hara-registry integration manual.md` — drop-in for hara-did (1,362 lines).
- **`hara-registry state 2.md`** — this file.

### Deploy (`deploy/`)
```
deploy/platform/   # Vault, Postgres, Redis, observability (shared external network)
deploy/chain/      # 4 validators + RPC nodes + LB + init
deploy/rpc/        # rpc-cache
deploy/services/   # signer, broadcaster, indexer, migrate
deploy/data/       # Blockscout
deploy/ops/        # cloud-init.yaml, secrets-bootstrap.sh,
                   # snapshot-validator.sh, snapshot-postgres.sh
deploy/networks/wireguard/README.md
```
All compose files reference external network `hara-platform`.

### Chain (`chain/`)
- `chain/genesis/` — QBFT genesis.
- `chain/node/` — validator Dockerfile (USER root for dev volume writes).
- `chain/init/` — init container (rebuilt **on `hyperledger/besu:26.4.0`** because Java 17 base was too old).
- `chain/lb/` — HAProxy config.
- `chain/blockscout/`, `chain/generated/`, `chain/scripts/`.

### Contracts (`contracts/`)
- `src/` — see §3.
- `script/Deploy.s.sol`, `DeployPalmOil.s.sol`, `DeployTestToken.s.sol`.
- `test/*.t.sol`.

### Services (`services/`)
- `shared/`, `signer/`, `broadcaster/`, `indexer/`, `migrate/`, `rpc-cache/`.

### Ops / tests
- `ops/load-tests/scenario-refinery-dag.ts` — 68 wallets, 8 stages, 224 transfers, 900 L → 10 outputs, all atomic.
- `ops/traceability-view/viewer.html` — dual-renderer graph.

### CI / governance
- `.github/workflows/{contracts,services,codeql,slither,secret-scan}.yml`
- `.github/{CODEOWNERS, pull_request_template.md, BRANCH-PROTECTION.md}`
- `SECURITY.md`, `.gitleaks.toml`

---

## 9. Unresolved Issues / Tech Debt

1. **GitHub branch protection** not yet applied. UI walk-through in `.github/BRANCH-PROTECTION.md`; needs manual click-through (requires first CI runs to populate check names).
2. **Vault is dev-mode.** Migration to Raft HA + AppRole still pending for prod.
3. **5 vs 6 VPS Nevacloud decision** — math shows 5-VPS host disk (500 GB) overflows around month 18 at projected event volume; **6 VPS recommended** but not yet ordered. Monthly billing confirmed available.
4. **rpc-cache warmup tuning** — works, but TTLs not yet load-tuned against real read mix.
5. **Cross-project port collisions** identified (11 conflicts across hara-registry / hara-did / hara-xchange / hara-halal-passport / erudio_flow). Phase 1 platform consolidation drafted — Vault + observability moved to `_platform/` — not yet executed across sibling repos.
6. **Indexer cursor reset workflow** — currently manual (truncate `indexed_events`, reset cursor) when chain wipes. Needs a `make reset-indexer` target.
7. **Mempool ordering** — Besu QBFT block builder does not preserve mempool order. **Mitigation in place** (TraceabilityBatchRelay), but anyone writing chained-tx flows needs to know.
8. **Off-chain PQ signature storage** — schema/location not finalised. Candidates: Postgres BYTEA, object store, IPFS. Pick before hara-did GA.
9. **No deploy/ configs yet for hara-did and hara-passport.** Sibling-repo work.
10. **No Nevacloud smoke-test** has been run on a real VPS yet.

---

## 10. Constraints

- **Indonesian regulatory context** (halal certification, RSPO chain-of-custody) — schemas must preserve provenance fields verbatim.
- **45-month operational horizon** drives storage planning; assume 1 TB / validator by end of term.
- **Single maintainer** (`@imronzuhri-svg`) — CODEOWNERS reflects this; raise reviews to 2 when team grows.
- **Budget:** Nevacloud monthly. Recommended 10 VPS plan = Rp 13 M/month, Rp 581 M over 45 months.
- **No k8s** in scope — Compose / Swarm only.
- **gasPrice = 0** is invariant; do not introduce gas-priced paths.
- **Chain ID 131216** is invariant.

---

## 11. Next Priorities (ordered)

1. **Apply GitHub branch protection** (5 min UI task) once CI has run once and populated check names.
2. **Place Nevacloud order** for the 6-VPS plan; provision first VPS to smoke-test before fanning out.
3. **Vault Raft HA migration** ahead of any prod data.
4. **Build `deploy/` for hara-did** mirroring hara-registry's deploy layout — reserved IPs 10.42.0.50–69 are waiting.
5. **Pick off-chain PQ signature store** and write the migration.
6. **`make reset-indexer`** target + docs.
7. **Tune rpc-cache TTLs** against a representative read trace.
8. **Phase 1 platform consolidation** — move Vault + observability into `_platform/` shared by sibling repos; fix the 11 port collisions.
9. **Draft Nevacloud sales email / WhatsApp** (user has asked for this).
10. **L6 multi-validator consortium** design — only after L5 is stable in prod.

---

## 12. Lessons Learned (do not repeat)

- Don't trust mempool ordering on Besu QBFT for chained txs → use a relay contract.
- Don't ship Shanghai bytecode → set `evm_version = "london"` and `--legacy`.
- Don't leave wallets at zero native balance even when gas is free → pre-fund 1 wei.
- Don't route load tests through HAProxy → bypass to `rpc-write`.
- Don't reuse wallet seeds across runs → seed from `Date.now()`.
- Don't benchmark with `curl` on Windows → ~200 ms/call overhead. Use Node single-process.
- Don't try to verify ML-DSA on-chain today → ~5 M gas. Commit-only.
- Don't use `wget` healthcheck on Vault → use `vault status` CLI.
- Don't put hostnames in Besu enode URLs → "Invalid ip address". Use static IPs.

---

## 13. Reference Card

```
Repo:           https://github.com/imronzuhri-svg/hara-registry
Chain ID:       131216
Native token:   HARA (gas price 0)
Block time:     ~2 s
Finality:       instant (QBFT)
Validators:     4 (10.42.0.11–14)
RPC read:       http://rpc-read:8545
RPC write:      http://rpc-write:8545
WebSocket:      ws://rpc-read:8546
Grafana:        http://localhost:3200
Loki:           http://localhost:3201
Cache metrics:  http://rpc-cache:9090/metrics
Besu image:     hyperledger/besu:26.4.0
EVM version:    london
DID method:     did:hara
Anvil dev key:  0xac0974b... (fixtures only, never prod)
Maintainer:     @imronzuhri-svg
```
