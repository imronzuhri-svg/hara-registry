# HaraLedger — Product Manual & Development Guidelines

**Document type:** comprehensive product reference + development guidelines.
**Audience:** product stakeholders, regulators, prospective partners, new engineers, auditors.
**Companion:** `doc/haraledger - technical document.md` (deep technical reference).
**Snapshot:** 2026-05-19.

---

## Table of Contents

1. [Executive summary](#1-executive-summary)
2. [The problem space](#2-the-problem-space)
3. [System decomposition — HaraLedger vs HARA Platform](#3-system-decomposition--haraledger-vs-hara-platform)
4. [Companion products](#4-companion-products)
5. [Features](#5-features)
6. [Privacy by Design](#6-privacy-by-design)
7. [Quantum-Proof Architecture](#7-quantum-proof-architecture)
8. [Standards & Compliances](#8-standards--compliances)
9. [Stages — P0 → P3](#9-stages--p0--p3)
10. [Stakeholders & Use Cases](#10-stakeholders--use-cases)
11. [Operational characteristics](#11-operational-characteristics)
12. [Cost & Resourcing](#12-cost--resourcing)
13. [Risks & Constraints](#13-risks--constraints)
14. [Development Guidelines](#14-development-guidelines)
15. [Roadmap — Next development](#15-roadmap--next-development)
16. [Glossary & Reference Card](#16-glossary--reference-card)

---

## 1. Executive summary

**HaraLedger is the chain.** A private, permissioned Hyperledger Besu QBFT network producing 2-second blocks with instant finality, chain ID `131216`, gas price zero, EVM target London.

**HARA Platform is the shared infrastructure** sitting underneath HaraLedger, hara-did, hara-halal-passport, and hara-xchange. It owns: HashiCorp Vault, the observability stack (Prometheus, Grafana, Loki, Alertmanager, Promtail), and from Phase 2 the shared Postgres, Redis, MinIO.

This separation is deliberate. **HaraLedger does not own its secrets, observability, or shared data services — it consumes them from HARA Platform.** Companion products do the same. One Vault, one logging pipeline, one alert routing, four chains of trust, four product surfaces.

HaraLedger ships today with six smart contracts, six TypeScript services, full observability, 40+ forge tests across the contract suite, deploy-driven indexer registration, post-quantum-ready audit anchoring (hybrid ECDSA + ML-DSA-65), tested snapshot/restore for both Postgres and validator data, validated WireGuard mesh, and CI green across `secret-scan`, `services`, `contracts`, `slither`, and CodeQL.

Forty-five-month target volume: **25,000 palm-oil batches × ~7,000 transfers each + 4,000,000 halal-passport NFTs** = ~175 million on-chain custody events plus 4M certificate mints.

---

## 2. The problem space

### 2.1 Halal certification today

A halal certificate today is a paper document or a PDF. Verification means trusting the issuer's database to be reachable, or manually phoning the certifying body. Counterfeit certificates are common; international buyers (Saudi, UAE, Malaysia, Singapore) routinely reject Indonesian halal certificates because they cannot be verified at scale.

**HaraLedger's answer:** every certificate becomes an on-chain record. A consumer scans the QR code on a product; the verifier app reads the on-chain status (active / expired / revoked) and the issuer's signature. No central database to be offline, hacked, or doubted. **45-month projected volume: 4 million halal-passport NFTs.**

### 2.2 Palm-oil traceability today

RSPO (Roundtable on Sustainable Palm Oil) requires mass-balance accounting: at every step in the supply chain, the volume of certified-sustainable palm oil flowing in must equal the volume flowing out. Today this is tracked in spreadsheets across dozens of mills, refiners, traders, manufacturers. Fraud is structural.

**HaraLedger's answer:** every custody transfer is a `TransferSingle` event in an ERC-1155 token where 1 token = 1 litre. Mass balance is mechanically enforced — you can't transfer more litres than you hold. Every batch is traceable from refinery output back to the originating plantation. **45-month projected volume: 25,000 batches × ~7,000 transfers each ≈ 175 million on-chain custody events.**

### 2.3 Why a blockchain (not a database)

Three reasons specific to this domain:

1. **No single party can be the source of truth.** BPJPH issues halal certificates, LPH inspects, MUI rules on doctrine, importers verify. A shared chain that any party can audit independently sidesteps the political problem of "who hosts the database."
2. **The audit window is regulatory, not operational.** Halal certificates are valid for 4 years; palm-oil batches must be auditable across a 45-month supply chain. A database can be quietly edited; an immutable chain cannot.
3. **Quantum readiness over a 10-year horizon.** Certificates issued today must still be verifiable in 2034+. ECDSA signatures are vulnerable to a future CRQC (Cryptographically Relevant Quantum Computer). HaraLedger commits a post-quantum signature (ML-DSA-65) alongside every audit anchor — see §7.

---

## 3. System decomposition — HaraLedger vs HARA Platform

### 3.1 The two-layer model

```
╔════════════════════════════════════════════════════════════════════════╗
║                            HARA Platform                               ║
║                  (shared infra — one per environment)                  ║
║                                                                        ║
║   Vault          ←─ secrets (HSM-backed in P2+, AppRole-scoped)        ║
║   Prometheus     ←─ time-series metrics for every project              ║
║   Alertmanager   ←─ alert routing fan-out                              ║
║   alert-sink     ←─ dev webhook receiver                               ║
║   Loki + Promtail ─ unified log aggregation                            ║
║   Grafana        ←─ single pane of glass                               ║
║   (P2+) Postgres ←─ shared instance, one DB per project                ║
║   (P2+) Redis    ←─ shared, separate logical DBs per project           ║
║   (P2+) MinIO    ←─ shared object store, separate buckets per project  ║
║                                                                        ║
║   Repo:    sibling `_platform/` dir                                    ║
║   Network: `hara-platform` (external Docker network / Swarm overlay)   ║
║   IP block: 10.42.0.0/24                                               ║
╠════════════════════════════════════════════════════════════════════════╣
║                                                                        ║
║   ╔══════════════╗  ╔══════════════╗  ╔══════════════╗  ╔════════════╗ ║
║   ║ HaraLedger   ║  ║ hara-did     ║  ║ hara-halal-  ║  ║ hara-      ║ ║
║   ║              ║  ║              ║  ║ passport     ║  ║ xchange    ║ ║
║   ║ • Chain      ║  ║ • Sidetree   ║  ║ • ERC-721    ║  ║ • Market   ║ ║
║   ║ • Contracts  ║  ║ • DID Method ║  ║ • Verifier   ║  ║ • Carbon   ║ ║
║   ║ • Indexer    ║  ║ • ZK proofs  ║  ║   API        ║  ║   credits  ║ ║
║   ║ • Anchor     ║  ║              ║  ║              ║  ║            ║ ║
║   ║   worker     ║  ║              ║  ║              ║  ║            ║ ║
║   ╚══════════════╝  ╚══════════════╝  ╚══════════════╝  ╚════════════╝ ║
║                                                                        ║
║   Each consumes from HARA Platform:                                    ║
║     • Vault paths under secret/<project>/...                           ║
║     • Postgres DB <project>_indexer / <project>_dev                    ║
║     • Redis DB N..M (one block per project)                            ║
║     • MinIO bucket prefix hara-<project>-*                             ║
║     • IP range 10.42.0.X..Y (one block per project)                    ║
╚════════════════════════════════════════════════════════════════════════╝
```

### 3.2 Resource partitioning per product

| Resource | HaraLedger | hara-did | hara-halal-passport | hara-xchange |
|---|---|---|---|---|
| Vault path prefix | `secret/haraledger/*` | `secret/haradid/*` | `secret/harapassport/*` | `secret/haraxchange/*` |
| Postgres DB | `hara_indexer` | `hara_did` / `haradid_dev` | `hara_passport` | `hara_xchange` |
| Redis logical DBs | 0–5 | 6–8 | 9–11 | 12–13 |
| MinIO buckets | `hara-chain-config`, `hara-pq-anchors` | `hara-cas`, sidetree batches | `hara-passport-images`, certs | TBD |
| WireGuard IP range | `10.42.0.11–14, 20–47` | `10.42.0.50–69` | `10.42.0.70–89` | `10.42.0.90–119` |
| Prometheus metric prefix | `hara_ledger_*`, `hara_anchor_*` | `hara_did_*` | `hara_passport_*` | `hara_xchange_*` |

This is enforced through code (Vault AppRole policies are role-scoped, Postgres uses separate roles per DB, Redis SELECT'd per service, MinIO bucket-policy-isolated) AND through documentation. **A bug in one product cannot read another's secrets, write to another's tables, or appear in another's metrics.**

### 3.3 Why separate

Three motivations:

1. **Operational economy.** One Vault, one Prometheus, one log pipeline. The marginal cost of adding a new product is the product itself, not its infrastructure.
2. **Cross-product correlation.** Every metric, every log line, every alert flows through the same observability stack. Grafana shows a hara-did failure correlated with a hara-ledger validator hiccup on a single dashboard.
3. **Single source of cryptographic truth.** Every signing key in the ecosystem lives in one Vault, under one AppRole policy framework. Audits inspect one place.

### 3.4 Companion-product independence

Despite shared platform, each product:
- Lives in its own repository (independent release cycles)
- Has its own contracts (deployed against the same chain but addressed separately)
- Has its own services (Docker images, deployment compose files)
- Can fail / rollback independently

The chain itself is the only shared *application-layer* surface; everything else is product-local.

---

## 4. Companion products

Built on top of HaraLedger; each owns its own repo, contracts, services. Share only the chain + the HARA Platform tier.

### 4.1 hara-did
`did:hara` decentralised-identity method, W3C/DIF compliant. Sidetree-anchored. Issuer DIDs for BPJPH / LPH / MUI; holder DIDs for halal-certified businesses. **ZK-based selective disclosure** planned for P1+ (Groth16 + Plonk circuits for age-predicate, score-threshold, non-revocation proofs).

Status (2026-05-19): active. 3 own contracts (DIDRegistry, RevocationRegistry, GuardianRegistry) plus 3 ZK verifier contracts deployed (AgePredicate, ScoreThreshold, NonRevocation). Anchor-oracle service Vault-migrated, AppRole-authenticated, pre-funded.

### 4.2 hara-halal-passport
Soulbound ERC-721 minted by BPJPH/LPH/MUI for every halal-certified product. Consumer-facing verifier app scans QR → reads on-chain status. Public verification API exposes the validity check at scale.

Status: in design. Reserved infrastructure: IPs `10.42.0.70–89`, Redis DBs 9–11, Vault `secret/harapassport/*`.

### 4.3 hara-xchange
Tokenised palm-oil credits + carbon credits exchange / market layer. Outside P0/P1 scope.

### 4.4 hara-ledger (this product)
The chain itself + the contract suite + the service tier that runs against it. Section 5 enumerates all features.

---

## 5. Features

### 5.1 Chain & consensus

- **Hyperledger Besu QBFT**, 4-validator, instant finality, 2-second block time.
- **Chain ID `131216`**, native token **HARA**, **gas price = 0** (invariant — no gas-priced paths).
- **EVM target London** (Shanghai's PUSH0 broke Besu deploys; pinned via `evm_version = "london"` + transactions always `--legacy`).
- **Validator key custody in Vault**, AppRole-authenticated. No root tokens distributed to production hosts.
- **WireGuard mesh** between all hosts. Static enode IPs in `10.42.0.11–14`. The local Docker compose layout and the production WG topology share the same IP plan unchanged.

### 5.2 Smart contracts (six deployed; one ERC-20 fixture)

| Contract | Purpose |
|---|---|
| **ContractRegistry** | Address book for every system contract; enables version migration. |
| **AnchorRegistry** | Classical-only audit anchor commitments (Merkle roots of event ranges). |
| **PQAnchorRegistry** | Hybrid quantum-ready audit anchors. Commits `keccak256(ML-DSA-65 signature)` on-chain; signature blob in MinIO. See §7. |
| **GovernanceContract** | Role-gated governance. P0: 1-of-1; P1+: 3-of-5 multisig for system actions. |
| **HaraPalmOil** | ERC-1155 representing **litres** of sustainable palm oil. One token ID per batch. Metadata captures RSPO cert hash, plantation ID, production date. Mass balance enforced by ERC-1155 mechanics. |
| **TraceabilityBatchRelay** | Bundles N supply-chain hops into ONE transaction. Sidesteps Besu QBFT's mempool-order-not-preserved property. See technical doc §5.6. Three entry points: `executeChain` (uniform leg), `executeChainVariable` (per-leg quantities), `executeHops` (arbitrary topology). |
| **IssuerRegistry** | Role-gated registry of approved halal-certificate issuers (BPJPH / LPH / MUI). |
| TestToken (fixture) | Minimal ERC-20 for load testing. Not part of production deploys. |

**40+ forge tests** across the production contracts. CI gates merges.

### 5.3 RPC & traffic layer

- **HAProxy LB** (maxconn 32 000, 16 threads, rate limit 5 000 req / 10 s per IP) splitting read vs write traffic.
- **2 RPC-read nodes + 1 RPC-write node** behind the LB.
- **`rpc-cache`** Fastify proxy in front of read traffic. Redis-backed. Method-specific TTLs (1 s for `eth_blockNumber`, 1 h for finalised blocks, 24 h for `chainId`, finalised `eth_getLogs` cached aggressively). **99 % cache-hit rate** on representative workloads — cuts validator load 40–60 % under read pressure.
- **WebSocket** subscriptions for real-time event consumers.

### 5.4 Indexing & traceability

- **Block indexer** following the chain in real time, decoding events for all 7 watched contracts.
- **REST traceability API** at `/trace/*`:
  - `GET /trace/batches` — list batches
  - `GET /trace/batch/:id` — full batch detail
  - `GET /trace/batch/:id/hops` — ordered hops
  - `GET /trace/batch/:id/graph` — JSON for the graph viewer
- **Dual-renderer graph viewer** (Cytoscape + AntV G6) with 7 + 9 layouts and source/output pinning.
- **Blockscout** block explorer (FE + BE) — full EVM explorer self-hosted.
- **Deploy-driven indexer registration:** `make deploy-all` reads forge's broadcast JSON and upserts all CREATE'd contracts into `watched_contracts`. No more hardcoded-address migrations breaking after chain wipes.

### 5.5 Anchor worker (post-quantum, ADR-0010 producer)

A standalone service that, on a 10-minute cadence:

1. Pulls all `indexed_events` newer than the last anchored block.
2. Builds a keccak-256 Merkle root over `(tx_hash || log_index)` leaves.
3. Signs the canonical anchor message with **ML-DSA-65** (NIST FIPS 204).
4. PUTs the 3,309-byte signature blob to MinIO bucket `hara-pq-anchors`, key `ml-dsa-65/<commit_hash>.sig`.
5. Calls `PQAnchorRegistry.recordAnchor()` with the `keccak256(signature)` commitment.
6. INSERTs an index row in `pq_anchor_signatures`.
7. Advances its cursor.

Cold-start: loads ECDSA + ML-DSA-65 keypair from Vault, generates the PQ pair if missing. Reconciles its public-key hash with the on-chain `currentPQKeyHash` — calls `rotatePQKey()` if they differ (covers the placeholder hash that `DeployPQAnchor.s.sol` writes on first deploy).

Refuses to start if the ECDSA signer has zero native HARA balance (Besu QBFT silently drops zero-balance senders at gasPrice=0).

### 5.6 Observability

Shared via HARA Platform:

- **Prometheus** + retention 90d. Project-prefixed metric naming (`hara_ledger_*`, `hara_anchor_*`, etc.).
- **Alertmanager** with custom routing → `alert-sink` webhook → Slack.
- **Loki + Promtail** for log aggregation across every container on the platform.
- **Grafana** as the unified view. Pre-built dashboards for chain health, RPC latency, indexer lag, rpc-cache hit rate, signer queue depth.
- **OpenTelemetry SDK** wired into every TS service via `@hara/shared/otel` (commit `0c39bb9`). No-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Tempo 2.6** in the obs stack as the trace sink.
- 40+ pre-built alert rules: validator down, block production stalled, RPC latency p99 > 500 ms, indexer lag > 60 blocks, rpc-cache miss rate > 20 %, Vault sealed.

### 5.7 Operations

- **One-command local bring-up:** `make platform-up && make bootstrap && make up && make deploy-all`.
- **Six-VPS Nevacloud topology** documented (`deploy/topology.md`), tested locally.
- **WireGuard mesh validation passing** — `deploy/ops/wg-local-test.sh` (2-peer container test, crypto handshake verified).
- **Postgres snapshot/restore drill passing** — `deploy/ops/snapshot-restore-drill.sh` (round-trip preserves all rows; spot-checked PQAnchorRegistry address byte-for-byte).
- **Validator snapshot/restore drill passing** — `deploy/ops/validator-snapshot-restore-drill.sh` (validator stopped, tarred, wiped, restored, rejoined; chain kept producing on 3-of-4 quorum).
- **TLS termination plan** via Caddy + Let's Encrypt — `deploy/edge/`.
- **`secrets-bootstrap.sh` dry-run validated.** Five `.env` files produced cleanly, chmod 600, zero template variables left.
- **`make reset-indexer` target** for re-indexing post-chain-rebuild.

### 5.8 Quality & CI

| Workflow | Status | Scope |
|---|---|---|
| `contracts` | ✓ green | `forge build + test` (40+ tests) |
| `services` | ✓ green | per-package `tsc -b` matrix (shared, signer, broadcaster, indexer, migrate, rpc-cache, anchor-worker) + docker build smoke |
| `slither` | ✓ green | Solidity static analysis with SARIF upload |
| `secret-scan` | ✓ green | gitleaks with project allowlist |
| `Push on main / CodeQL` (default setup) | ✓ green | GitHub-managed CodeQL JS/TS scan |
| `codeql` (our advanced workflow) | ⊘ skipped | gated on opt-in repo variable; default setup covers it |

All workflows can be triggered manually via `workflow_dispatch`. Branch protection ready to apply.

---

## 6. Privacy by Design

HaraLedger handles sensitive data: halal certificate metadata, plantation IDs, RSPO certificate hashes, business custody chains. **Personally Identifiable Information (PII) is governed by Indonesia's UU PDP** (Personal Data Protection Law). The architecture observes seven privacy-by-design principles.

### 6.1 P1 — Data minimisation on-chain

**The chain stores hashes, not data.** Specifically:

- Halal certificates → hash of certificate document on-chain; document itself in encrypted storage off-chain.
- Plantation IDs → `bytes32 plantationId` is a keccak of an opaque identifier, not a name or coordinate.
- RSPO cert hashes → `bytes32 rspoCertificateHash` is the document hash, not the document.
- Custody transfers → `(from, to, qty)` addresses are pseudonymous Ethereum addresses; the mapping to real-world entities lives in `IssuerRegistry` (controlled, role-gated) or in off-chain back-offices.

Result: a chain dump leaks pseudonymous addresses + opaque hashes. No name, no GPS coordinate, no personal identifier.

### 6.2 P2 — Selective disclosure via did:hara + ZK proofs

For DID holders whose identity is sensitive (e.g. an individual employee whose halal compliance is being attested):

- The hara-did wallet generates an ML-DSA-65 keypair at registration in addition to Ed25519, with both verificationMethods in the DID document.
- ZK predicates exposed via the `AgePredicate`, `ScoreThreshold`, `NonRevocation` verifier contracts let the holder prove "I am over 21" / "my score is above X" / "my credential is not revoked" without disclosing the credential.
- Verifier services (passport, exchange, regulator) accept the ZK proof as sufficient — no need to see the underlying claim.

### 6.3 P3 — Off-chain CAS for sensitive blobs

The PQ signature blob, hara-did Sidetree batch files, RSPO certificate PDFs, halal passport images: none of these live on-chain. They live in MinIO buckets with bucket-policy access control.

The chain only carries `keccak256(blob)` commitments. Auditors fetch the blob out-of-band (presigned URL, AppRole-issued grant, etc.) and verify the hash matches.

### 6.4 P4 — Purpose-bound role tokens (AppRole)

Vault AppRole policies are scoped to a single read path and a single role:

- `validator` → `read secret/data/haraledger/validators/*` only
- `signer` → `read secret/data/haraledger/signer-keys/*` only
- `anchor-worker` → `read signer-keys/anchor-worker` + RW on `anchor/*`

No service has root-equivalent access. A compromised broadcaster cannot read validator keys. A compromised indexer cannot read anything secret at all (the indexer doesn't need any Vault auth).

### 6.5 P5 — Audit log immutability

Every Vault read, every AppRole login, every key rotation is audit-logged. Vault audit logs are streamed to Loki via Promtail. Grafana dashboards expose the audit volume.

The on-chain layer is inherently immutable; even an attacker with full VPS access cannot quietly rewrite history because the four validators consensus-vote on every block.

### 6.6 P6 — Encryption at rest + transit

- **At rest:** Postgres `pg_dump` snapshots are zstd-compressed and uploaded via rclone over TLS to Nevacloud Object Storage. MinIO supports encryption-at-rest via the underlying disk encryption (LUKS on the host volume in P1+).
- **In transit:** Caddy auto-renews Let's Encrypt certs for the three public hostnames (`rpc.hara.id`, `explorer.hara.id`, `grafana.hara.id`). Upstream from Caddy to the services stays plaintext over the WireGuard mesh — but the WireGuard tunnel itself is ChaCha20-Poly1305 encrypted.

### 6.7 P7 — Retention and deletion

- On-chain commitments are immutable by design (regulatory requirement: 45 months minimum for halal records).
- Off-chain PII: hara-did Sidetree operations support `deactivate`. A deactivated DID's PII is hard-deleted from MinIO (replaced by a tombstone hash); the on-chain anchor remains as evidence the deactivation happened, but the data behind it is gone.
- Indexer state: retained as long as the chain itself.
- Operational logs: 90-day retention in Loki by default.

### 6.8 Privacy compliance summary

| Requirement | Implementation |
|---|---|
| UU PDP (Indonesia) data residency | Nevacloud (sovereign Indonesian cloud) is primary, Huawei Cloud Indonesia is DR. No hyperscaler primary footprint. |
| GDPR right-to-erasure (where applicable) | Sidetree `deactivate` + MinIO tombstoning. On-chain commitment is allowed because it doesn't contain personal data — only a hash. |
| Selective disclosure | ZK verifier contracts (AgePredicate, ScoreThreshold, NonRevocation) |
| Minimised exposure | Hash-only on-chain pattern; blobs in CAS |
| Access control | Vault AppRole policies, role-scoped |
| Audit logging | Vault audit log → Loki, Postgres `pgaudit` for sensitive queries (P1+) |

---

## 7. Quantum-Proof Architecture

### 7.1 The threat model

ECDSA signatures (the secp256k1 curve all Ethereum validators sign with) are vulnerable to Shor's algorithm. A future cryptographically-relevant quantum computer (CRQC) — estimated 2030–2040 — could:

1. Forge historical anchor signatures, retroactively fabricating chain history.
2. Forge new transactions impersonating any address.
3. Decrypt TLS traffic captured today ("harvest-now-decrypt-later").

For a 45-month-minimum halal certificate audit window starting in 2026, the lower bound of the CRQC threat lands within the certificate's validity period.

### 7.2 The hybrid mitigation

Every audit-grade anchor on HaraLedger is signed twice:

```
At anchor time:
  classical: ECDSA(Merkle root) → submitted in PQAnchorRegistry.recordAnchor as the on-chain tx
  PQ:        ML-DSA-65(canonical message) → blob in MinIO
             keccak256(blob)               → committed on-chain in the same tx
```

Both signatures persist. Two paths to verify in any era:

```
Audit today (no CRQC):
  Verify ECDSA over Merkle root           → cheap, instant
  Verify keccak256(blob) on-chain         → also cheap
  Verify ML-DSA-65 over canonical message  → 3.3 KB blob; ~25 ms with @noble/post-quantum

Audit post-2030 (CRQC exists):
  Classical ECDSA is forgeable             → cannot be trusted
  ML-DSA-65 (lattice-based, FIPS 204)      → AUTHORITATIVE
  PQAnchorRegistry's keccak256 commit      → still authoritative; quantum cannot forge a preimage
```

Auditors regenerate the canonical message from the on-chain Anchor record (the Merkle root, block range, event count, anchor-chain tag, algorithm tag), fetch the blob from MinIO by `keccak256` hash, verify the ML-DSA-65 signature against the published PQ public key (whose hash is committed on-chain in `currentPQKeyHash` at the time of signing — frozen, not subject to rotation poisoning).

### 7.3 Why not verify ML-DSA-65 on-chain today

Naïve cost: ~5 million gas per ML-DSA-65 verify in Solidity. At 175 million anchors / 45 months, that's prohibitive.

Hybrid pattern (commit-only on-chain, verify off-chain): ~30 k gas per anchor. **~167× cheaper, same security guarantee** for anyone holding the on-chain commitment.

Migration path: when EVMs add ML-DSA-65 precompiles (estimated 2027–2029 per NIST timeline), add an on-chain `verifyPQ()` function and switch the default audit path. Existing committed anchors continue to verify under the new precompile because the canonical message structure was designed once and frozen.

### 7.4 PQ key custody

The anchor-worker holds the ML-DSA-65 secret key in Vault at `secret/haraledger/signer-keys/anchor-worker`:

```
{
  address:        "0x..."         // ECDSA Ethereum address (for the on-chain tx)
  private_key:    "0x..."         // ECDSA 32-byte secret
  pq_public_key:  "0x..." (1952 B) // ML-DSA-65 public key (frozen in DID doc + on-chain key hash)
  pq_secret_key:  "0x..." (4032 B) // ML-DSA-65 secret key
}
```

Both keypairs are under the same AppRole policy. Rotation: generate new keypair, write to Vault (KV-v2 keeps prior version for audit), call `PQAnchorRegistry.rotatePQKey()` — new anchors use the new key; old anchors continue to verify against their frozen `pqKeyHash` field.

### 7.5 Algorithm agility

`PQAnchorRegistry` stores `currentPQAlgorithm` as a string (e.g. `"ML-DSA-65"`). When NIST or industry adopts a different scheme (SLH-DSA, Falcon, future post-quantum signature standards), the same registry handles it:

- Add the new algorithm's pubkey hash via `rotatePQKey(newKeyHash, "SLH-DSA-SHA2-128s")`.
- New anchors carry the new algorithm tag.
- The `pq_anchor_signatures` table's `algo` column distinguishes them at audit time.
- MinIO bucket layout is algorithm-prefixed: `ml-dsa-65/<hash>.sig`, future siblings under `slh-dsa-sha2-128s/`, `falcon-512/`.

### 7.6 Quantum-safe stack summary

| Layer | Today | When CRQC exists |
|---|---|---|
| Validator signatures (block consensus) | ECDSA secp256k1 (vulnerable) | Migration to PQ consensus at L6+ (state-2 §11 #10) |
| Audit anchors | Hybrid ECDSA + ML-DSA-65 | ML-DSA-65 authoritative |
| DID controller signatures | Hybrid Ed25519 + ML-DSA-65 (hara-did) | ML-DSA-65 authoritative |
| TLS in transit | Curve25519 + X25519 (today) | Hybrid Kyber-768 + X25519 (when supported) |
| Encryption at rest | AES-256 (quantum-resistant against Grover) | unchanged |

**Auditable claim: HaraLedger anchors signed today remain authoritative through CRQC arrival.** That property is the product's regulatory differentiator versus any other blockchain in Indonesia.

---

## 8. Standards & Compliances

### 8.1 Regulatory standards observed

| Standard | Scope | How HaraLedger complies |
|---|---|---|
| **UU PDP (Indonesia)** | Personal Data Protection | Nevacloud sovereign cloud primary, Huawei Cloud Indonesia DR. Hash-only on-chain. Sidetree `deactivate` supports right-to-erasure for PII. |
| **BPJPH halal certification rules** | Halal product certification | `IssuerRegistry` role-gates BPJPH/LPH/MUI as the only authorities that can mint a `HalalPassport` NFT. |
| **RSPO chain-of-custody (mass balance)** | Sustainable palm oil | `HaraPalmOil` ERC-1155 enforces transfer ≤ balance mechanically. Every batch carries `rspoCertificateHash`. |
| **EU CSDDD + EUDR** | EU due-diligence + deforestation regulations | Plantation-to-export traceability via the indexer + `/trace/*` API. Exportable audit trails. |
| **ISO 27001** | Information security management | P1 audit prep. Vault HSM at L4+ per `hara-ledger-roadmap.md` Decision 10. |
| **SOC 2 Type II** | Service organisation controls | P2 audit prep. Slither + CodeQL + secret-scan + gitleaks in CI; immutable on-chain audit trail; documented access controls. |
| **W3C DID-Core 1.0** | Decentralised Identifiers | `did:hara` method (in hara-did). Spec-compliant resolver. |
| **NIST FIPS 204** | Module-Lattice Digital Signature (ML-DSA) | ML-DSA-65 = Dilithium 3; via `@noble/post-quantum`. |
| **NIST FIPS 203** | ML-KEM (post-quantum KEM) | Reserved for TLS hybridisation when client/server support lands (P2+). |

### 8.2 Internal coding & operational standards

| Standard | Enforcement |
|---|---|
| TypeScript strict mode | `tsconfig.base.json` (compilerOptions.strict=true). CI fails on type errors. |
| Solidity 0.8.26, OZ v5 | `foundry.toml` pins compiler. CI runs `forge build` then `forge test`. |
| EVM target London | `foundry.toml`'s `evm_version = "london"`. Every tx sent `--legacy`. Pre-commit safety against accidental Shanghai. |
| Gas price 0 | Invariant. No gas-priced paths in code; load tests would fail loudly. |
| Conventional Commit messages | `docs:` / `feat:` / `fix:` / `chore:` / `test:` / `ci:` prefixes. Co-author tag for AI contributions. |
| Linear git history | No merge commits. Squash or rebase merge only. Branch protection enforces (when applied). |
| 4-validator BFT quorum | QBFT requires 3 of 4 alive. Multi-region deployment (P1+) ensures single-region failure ≤ 2 validators. |
| 32-byte hash invariant | Postgres CHECK constraints on `commitment_hash` / `anchor_tx_hash` columns ensure 32 octet_length. |

### 8.3 Certification roadmap

- P0/P0.5 (now): operational best-practice; no formal certification.
- P1 (months 4–10): ISO 27001 stage 1 audit, UU PDP DPA filed with regulator, external pen test.
- P2 (months 10–22): ISO 27001 stage 2 + SOC 2 Type II; EU CSDDD audit-readiness; HSM-backed Vault.
- P3 (months 22–40): country-specific certifications (PDPA Singapore, GDPR-equivalent EU, Malaysian PDPA).

---

## 9. Stages — P0 → P3

### 9.1 P0 — Prototype-Demo (months 0–4) — ✅ complete in local dev
- 1 validator on dev laptop, 4-validator local Compose stack.
- All 7 system contracts deployed + tested.
- Full observability + indexer.
- Snapshot/restore tested.

### 9.2 P0.5 — VPS transition (month 4, current) — 🟡 in progress
- 7 pre-VPS gates closed (Vault Raft HA, WireGuard validated, snapshot drills, secrets-bootstrap dry-run, compose split, TLS plan, IP conflict resolution).
- 6-VPS Nevacloud Option B planned and documented.
- Awaiting Nevacloud VPS provisioning + first-VPS smoke test.

### 9.3 P1 — Pilot (months 4–10)
- 4-validator consortium across Nevacloud (multi-region Jakarta + Surabaya) + Huawei Cloud (1 backup validator).
- HA RPC tier (multi-host stateless).
- K3s orchestration begins.
- IOTA L1 anchoring every 10 min.
- ClickHouse online for analytics.
- ISO 27001 Stage 1 audit.
- Closed-beta with single-digit thousand users, single-digit thousand certificates.
- **Exit criteria:** 4-validator consortium runs 90 days without a consensus incident; 10 000 holder DIDs anchored; 1 000 halal certificates issued.

### 9.4 P2 — National (months 10–22)
- 7–15 validators across Nevacloud + Huawei + 2–3 partner-operated regions.
- Full RPC mesh per blueprint.
- HSM-backed Vault (Cloud KMS on Nevacloud + Huawei).
- Dual L1 anchoring: IOTA every 10 min + Ethereum L1 daily.
- BPJPH + all LPH + all MUI provincial offices on-chain.
- Multi-region active-active.
- ISO 27001 Stage 2 + SOC 2 Type II.
- Country-grade adoption: millions of consumer DIDs, hundreds of thousands of certificates/year.

### 9.5 P3 — Global (months 22–40)
- Avalanche Subnet rehearsal + migration if scale demands.
- Multi-country (OIC member states, EU traceability extensions).
- ML-DSA-65 precompiles on-chain (assuming EVM standardises).
- Multi-cloud + sovereign cloud + bare-metal for highest-trust nodes.

### 9.6 The L0–L5 ladder

Inside each P phase, the **L0–L5** ladder tracks implementation maturity (used in `ops/runbooks/L*.md`):

- **L0** — Chain bring-up (single validator)
- **L1** — RPC read/write separation
- **L2** — Signer/broadcaster pipeline
- **L3** — Indexer
- **L4** — Monitoring (Prom/Graf/Loki)
- **L5** — Blockscout integrated
- **L6** — Multi-validator consortium (P1+)
- **L8** — Audit anchor worker (anchor-worker.sol producer, ADR-0010 — landed in this codebase)

Today: **L5 stable + L8 landed, inside P0.5.**

---

## 10. Stakeholders & Use Cases

### 10.1 BPJPH (Badan Penyelenggara Jaminan Produk Halal)
Indonesian government body issuing halal certificates.
- Tamper-evident issuance log.
- Real-time revocation propagation across all verifiers globally.
- Scan-and-verify portal for international auditors.

### 10.2 LPH (Lembaga Pemeriksa Halal)
Inspection bodies that audit producers and recommend issuance to BPJPH.
- Auditable inspection records on-chain.
- Multi-stakeholder governance — no single LPH controls the registry.

### 10.3 MUI (Majelis Ulama Indonesia)
Religious authority issuing doctrinal halal fatwas.
- Cryptographic attestation that a certificate carries MUI's fatwa.
- Selective disclosure for sensitive ingredient information.

### 10.4 RSPO members + palm-oil supply chain
Plantations, mills, refiners, traders, manufacturers.
- Mass-balance accounting that doesn't depend on Excel.
- Provable chain-of-custody for EU CSDDD + EUDR exports.

### 10.5 End consumers
QR-scan a product, see:
- Halal cert status (active / expired / revoked)
- Plantation of origin + RSPO cert hash
- Issuance + last-update timestamps

### 10.6 International buyers
- Verify Indonesian halal certificates at the speed of an HTTP call.
- Audit the full supply chain back to the plantation without trusting any single operator.

### 10.7 Regulators (across jurisdictions)
- Read-only access via the RPC layer.
- Operate their own indexer if they want.
- Their findings are themselves on-chain (revocation events, audit anchor commitments).

---

## 11. Operational characteristics

| Phase | Uptime target | Throughput | RPO | RTO | Maintenance |
|---|---|---|---|---|---|
| P0 / P0.5 (today) | best-effort | ~50 TPS sustained, 500 TPS burst | 24 h | 4 h | unannounced |
| P1 (pilot) | 99.5 % monthly (≤3.5 h downtime/month) | 200 TPS sustained | 24 h | 4 h | 7-day notice |
| P2 (national) | 99.9 % monthly (≤43 min downtime/month) | 1 000 TPS sustained | 4 h | 1 h | 24-hour notice, 24/7 on-call |
| P3 (global) | 99.95 % monthly (≤22 min downtime/month) | 5 000 TPS sustained | 1 h | 15 min | rolling, no full-system maintenance |

---

## 12. Cost & Resourcing

### 12.1 Infrastructure costs (Nevacloud Option B, P1 scale)

| Item | Monthly (IDR) | 45-month total |
|---|---|---|
| 4 × validator VPSes (4 vCPU / 8 GB / 100 GB) | Rp 2.8 M | Rp 126 M |
| `hara-stateful` (8 vCPU / 32 GB / 1 TB) — Vault + Postgres + Redis + MinIO | Rp 2.5 M | Rp 112.5 M |
| `hara-stateless` (8 vCPU / 32 GB / 500 GB) — apps + obs + LB | Rp 1.7 M | Rp 76.5 M |
| Object storage (300 GB) | Rp 0.3 M | Rp 13.5 M |
| **hara-ledger subtotal** | **Rp 7.3 M** | **Rp 328.5 M** |

### 12.2 P2 — adding Huawei DR

| Item | Monthly | Notes |
|---|---|---|
| Huawei: 1 backup validator (4 vCPU / 8 GB / 200 GB) | ~Rp 1.5 M | One additional validator on Huawei Cloud Indonesia |
| Huawei: 1 Postgres replica | ~Rp 2 M | Async replication target |
| Huawei OBS storage (replicated) | ~Rp 1 M | Mirror of MinIO Nevacloud |
| Huawei AI services (OCR for cert imaging) | ~Rp 2 M | Optional, P2 |
| **Huawei DR subtotal** | **Rp 5–8 M** | Activated ~month 12 |

### 12.3 Companion products

| Product | Monthly | 45-month |
|---|---|---|
| hara-did (2 VPSes) | Rp 2.5 M | Rp 112.5 M |
| hara-halal-passport (2 VPSes) | Rp 2.6 M | Rp 117 M |

### 12.4 All-in P1 figure
~Rp 12.4 M / month chain + did + passport ≈ **USD 35 000 / year**.

### 12.5 Engineering
- P0–P0.5: single maintainer (`@imronzuhri-svg`).
- P1: 3–5 engineers + 1 ops.
- P2+: 8–12 engineers + on-call rotation.

---

## 13. Risks & Constraints

### 13.1 Technical
- **Vault single-node Raft** at P1. Multi-node HA at P2+ (state-2 §11 #3). Mitigation: Raft snapshots nightly to object storage; restore tested.
- **QBFT validator quorum.** Chain halts if 2 of 4 validators die. Mitigation: geo-spread across Jakarta + Surabaya (P1+) and Huawei (P2+).
- **Besu QBFT mempool ordering.** Block builder doesn't preserve order; chained txs must use `TraceabilityBatchRelay`. Mitigation: contract documented + tested + integrated in production code paths.
- **45-month storage projection.** 1 TB NVMe on hara-stateful covers the full term per `nevacloud-proposal.md`; re-evaluate at month 24.
- **MinIO single operator.** ADR-0010 mitigates via content-addressing (any party with the chain commit can verify a blob handed to them out-of-band, regardless of who hosted it).

### 13.2 Regulatory
- **UU PDP audit.** P1 milestone; failure delays national rollout.
- **ISO 27001 certification.** Required for export-market acceptance (Saudi, UAE, Singapore). Scheduled P1.
- **EU CSDDD / EUDR.** Indonesian palm-oil exports to EU need provable due diligence + traceability by 2027. HaraLedger designed for it.

### 13.3 Adoption
- **BPJPH integration speed** depends on government IT cycles.
- **Multi-stakeholder consortium governance.** Bringing LPH + MUI + BPJPH to share a chain takes political work, not just code.
- **Consumer-facing UX.** QR-scan latency at scale (hara-passport public verification API) needs CDN edge at ~month 18 per `nevacloud-proposal.md`.

---

## 14. Development Guidelines

### 14.1 Branching & merging
- Default branch: `main`. Linear history only.
- Feature branches → PR → CI must be green → squash or rebase merge.
- Branch protection (state-2 §11 #1) when applied:
  - Required checks: `secret-scan`, `services`, `contracts / forge build + test`, `slither / Slither static analysis`
  - 1 reviewer required (raise to 2 when team grows past single maintainer)
  - No force push, no deletions, no merge commits.

### 14.2 Commit hygiene
- Conventional commit prefix: `feat(scope):`, `fix(scope):`, `docs:`, `test:`, `chore:`, `ci:`.
- Subject ≤ 72 chars.
- Body explains *why*, not *what*.
- AI-assisted commits include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

### 14.3 TypeScript style
- Strict mode (`tsconfig.base.json`).
- Never `any` in shared types.
- `catch (err: any)` is the house style for catch handlers (matched across all services).
- Use viem `Hex` / `Address` types over `string`.
- ES modules (`"type": "module"`).
- pnpm only; never npm or yarn.

### 14.4 Solidity style
- OpenZeppelin v5 imports.
- `pragma solidity ^0.8.26;`.
- `evm_version = "london"` invariant in `foundry.toml`.
- Custom errors over `require(string)`.
- Tests via `forge-std/Test.sol`; cheat-codes via `Vm`.
- **Foundry test footgun:** `vm.prank()` only applies to the next call. Don't read role constants inside an `expectRevert` encoder under a prank — hoist them into locals first.

### 14.5 Transaction sending
- `--legacy` always (Besu doesn't accept EIP-1559 at gasPrice=0).
- `gasPrice = 0` invariant.
- Pre-fund any new wallet with ≥1 wei before its first tx (Besu silently drops zero-balance senders).
- Load tests: bypass HAProxy LB (rate limit nukes throughput); go direct to `rpc-write`.

### 14.6 Vault key custody
- **Never** distribute root tokens to production VPSes.
- Each role (validator / signer / anchor-worker) gets its own AppRole.
- AppRole policies are read-scoped to the minimal path the role needs.
- Token caching in `@hara/shared/vault.ts`: in-memory, refresh 30 s before expiry, concurrent-login coalescing.
- Rotation: re-run `vault-approle-bootstrap.sh` periodically to rotate `secret_id`s.

### 14.7 Operating drills
- After every schema migration: re-run `deploy/ops/snapshot-restore-drill.sh`.
- After any chain rebuild: re-run `make deploy-all` (auto-registers indexer).
- Quarterly: re-run `deploy/ops/validator-snapshot-restore-drill.sh`.

### 14.8 CI gates (all must pass before merge)
- `forge build` + `forge test` (no failures, no skips).
- `pnpm exec tsc -b` per package (zero TS errors).
- `slither` (no high/critical findings; medium/low are reports).
- `gitleaks` (no new secret detections; allowlist in `.gitleaks.toml`).
- `secret-scan` weekly cron + per-push.
- CodeQL (default setup) on every push.

### 14.9 Documentation conventions
- All architecture decisions live in `doc/`.
- ADRs in `doc/adr/` (per hara-did pattern).
- Runbooks in `ops/runbooks/L*-*.md`.
- State snapshots in `doc/hara-ledger state N.md`.

---

## 15. Roadmap — Next development

### 15.1 Immediate (this sprint)
1. **First-VPS smoke test on Nevacloud.** Pre-VPS gate #7. Provision hara-stateful first; verify Vault + Postgres + Redis + MinIO via WireGuard mesh.
2. **GitHub branch protection.** UI task; all required check names have successful runs.
3. **Final hara-did contract redeploy** against current chain. `hara-did/.contracts.env` currently has DID/Revocation/Guardian addresses from a pre-wipe chain.

### 15.2 Short-term (next 1–2 months — completes P0.5 → P1 entry)
4. Fan out the other 5 Nevacloud VPSes, run `wg-bootstrap.sh`, bring up full topology.
5. End-to-end anchor-worker smoke test in production: bring up MinIO + worker, watch one anchor cycle complete on real chain.
6. Wire `@hara/shared/otel` consumers across the remaining 6 TS services (signer, broadcaster, indexer, rpc-cache, migrate, plus any new). anchor-worker already does it.
7. Tempo container in `deploy/platform/docker-compose.obs.yml` — already added (per `100bccd`).

### 15.3 Medium-term (P1, months 4–10)
8. K3s migration for the stateless tier.
9. Multi-region Nevacloud — split validators across Jakarta + Surabaya.
10. ClickHouse for event analytics.
11. Vault multi-node Raft HA.
12. IOTA L1 anchoring service.
13. ISO 27001 Stage 1 prep + pen test.

### 15.4 Long-term (P2 / P3)
14. Dual-L1 anchoring (IOTA + Ethereum L1).
15. Huawei DR layer activation (~month 12).
16. HSM-backed Vault (Cloud KMS).
17. ML-DSA-65 on-chain verification when EVM precompiles land.
18. Avalanche Subnet rehearsal + migration.
19. Multi-country regulator integrations.

---

## 16. Glossary & Reference Card

### 16.1 Glossary

- **AppRole** — Vault authentication method that issues short-TTL tokens scoped to a specific role.
- **BPJPH** — Indonesian halal certification authority.
- **CRQC** — Cryptographically Relevant Quantum Computer; the threat model for our post-quantum work.
- **DID** — Decentralised Identifier (W3C). hara-did implements the `did:hara` method.
- **ERC-721 soulbound** — non-transferable NFT; the halal passport pattern.
- **ERC-1155** — multi-token standard; one contract holds many fungible token IDs (one per palm-oil batch).
- **HSM** — Hardware Security Module. Vault production backend at L4+.
- **LPH** — Indonesian halal inspection body.
- **ML-DSA-65** — NIST FIPS 204 post-quantum signature scheme (Dilithium 3). 3309-byte sig, 1952-byte public key.
- **MUI** — Indonesian Council of Ulama.
- **QBFT** — Quorum BFT consensus; Besu's permissioned consensus algorithm.
- **RSPO** — Roundtable on Sustainable Palm Oil; international sustainability certification body.
- **Sidetree** — DID anchoring protocol that batches DID operations and commits batch hashes on-chain.
- **UU PDP** — Indonesia's Personal Data Protection Law.

### 16.2 Reference Card

```
Chain ID:           131216
Native token:       HARA (gas price 0 — invariant)
Block time:         ~2 s
Finality:           instant (QBFT)
Validators:         4 (10.42.0.11–14)
Sovereign cloud:    Nevacloud (primary) + Huawei (DR P2+)
RPC read (local):   http://localhost:8545
RPC write (local):  http://localhost:8545 (same endpoint via LB)
WebSocket (local):  ws://localhost:8546
rpc-cache:          http://localhost:8088
Signer:             http://localhost:7000
Indexer:            http://localhost:9100
Anchor worker:      http://localhost:9102
Blockscout:         http://localhost:4010
Grafana:            http://localhost:3200
Vault (dev):        http://localhost:8200  (token haraledger-dev-root)

Besu image:         hyperledger/besu:26.4.0
EVM version:        london (PUSH0 invariant — Shanghai breaks Besu)
Solidity:           ^0.8.26
Foundry:            forge + cast
TS:                 strict mode, ES modules, pnpm 9.12.0
PQ:                 ML-DSA-65 (FIPS 204) via @noble/post-quantum

Companion repos:    hara-did, hara-halal-passport, hara-xchange
Shared platform:    sibling _platform/ dir (Vault + obs)

Repo:               https://github.com/imronzuhri-svg/hara-ledger
Maintainer:         @imronzuhri-svg
```
