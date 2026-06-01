# HaraLedger — Product Manual

**Audience:** product stakeholders, regulators, prospective partners, new engineers joining the team.
**Companion docs:** `TECHNICAL.md` for implementation depth, `deploy/topology.md` for ops, `doc/hara-registry-roadmap.md` for the long-term timeline.
**Snapshot date:** 2026-05-15.

---

## 1. What HaraLedger Is

HaraLedger is a **private permissioned blockchain** built for two Indonesian-specific use cases:

1. **Halal certification** — making BPJPH / LPH / MUI-issued halal certificates verifiable by any consumer scanning a QR code, with cryptographic guarantees that the certificate is real, current, and unaltered.
2. **Palm-oil traceability** — recording the chain of custody for sustainable palm-oil batches from plantation to end product, satisfying RSPO mass-balance accounting.

It is not a public blockchain. It is not a cryptocurrency. It does not have speculation, mining, or transaction fees. It is **infrastructure**, the way GS1 barcodes or DNS are infrastructure: a shared ledger that lets multiple competing organisations attest to facts without trusting any single one of them.

The product is composed of:

- **The chain itself** — a 4-validator Hyperledger Besu network producing blocks every 2 seconds with instant finality.
- **The application layer** — services that read from and write to the chain (transaction signer, indexer, RPC cache, block explorer).
- **The data layer** — Postgres for indexed events, Redis for queues + caching, Vault for secrets, MinIO for off-chain audit blobs.
- **Companion products** that build on the chain (see §3 below).

---

## 2. The Problem We Solve

### 2.1 Halal certification today

A halal certificate today is a paper document or a PDF. Verification means either trusting the issuer's database to be available, or manually phoning the certifying body. Counterfeit certificates are common. International buyers (Saudi, UAE, Malaysia, Singapore) routinely reject Indonesian halal certificates because they cannot be verified at scale.

**HaraLedger's answer:** every halal certificate is an immutable on-chain record. A consumer scans the QR code on a product; the verifier app reads the on-chain status (active / revoked / expired) and the issuer's signature. No central database to be offline, hacked, or doubted. Forty-five-month projected volume: **4 million halal passport NFTs**.

### 2.2 Palm-oil traceability today

RSPO (Roundtable on Sustainable Palm Oil) requires a "mass-balance" accounting: at every step in the supply chain, the volume of certified-sustainable palm oil flowing in must equal the volume flowing out. Today this is tracked in spreadsheets across dozens of mills, refiners, traders, manufacturers. Fraud is structural; spot-audits are after-the-fact.

**HaraLedger's answer:** every transfer of certified palm oil is an on-chain `TransferSingle` event in an ERC-1155 token where 1 token = 1 litre. Mass-balance is mechanically enforced: you cannot transfer more litres than you hold. Every batch is traceable from refinery output back to the originating plantation. Forty-five-month projected volume: **25,000 batches × ~7,000 transfers each = ~175 million on-chain custody events**.

### 2.3 Why a blockchain (not a database)

Three reasons specific to this domain:

1. **No single party can be the source of truth.** BPJPH issues halal certificates, LPH inspects, MUI rules on doctrine, importers verify. A shared chain that any of them can audit independently sidesteps the political problem of "who hosts the database."
2. **The audit window is regulatory, not operational.** Halal certificates are valid for 4 years; palm-oil batches must be auditable across a 45-month supply chain. A database can be edited; a chain's history can't be quietly rewritten.
3. **Quantum-readiness over a 10-year horizon.** Certificates issued today must still be verifiable in 2034+. ECDSA signatures are vulnerable to a future quantum computer (CRQC). HaraLedger commits a **post-quantum signature** (ML-DSA-65) alongside every audit anchor, so historical records can be re-verified even if the chain's classical crypto is broken.

---

## 3. Companion Products

HaraLedger is the trust layer. Three products build on top of it; each lives in its own repository but shares the chain + platform tier.

| Product | Purpose | Status |
|---|---|---|
| **hara-did** | `did:hara` decentralised identity method (W3C/DIF compliant), Sidetree-anchored. Issuer DIDs for BPJPH / LPH / MUI; holder DIDs for halal-certified businesses. ZK-based selective disclosure planned. | Active development. Anchor-oracle service + 3 contracts deployed. |
| **hara-halal-passport** | The actual halal certificate product. Soulbound ERC-721 NFTs minted by BPJPH/LPH/MUI; consumer-facing verifier app + portal. | In design. Reserved infra: IPs 10.42.0.70–89, Redis DBs 9–11, Vault `secret/harapassport/*`. |
| **hara-xchange** | Exchange / market layer for tokenised palm-oil credits + carbon credits. | Planned. Outside P0/P1 scope. |

These are NOT distributed-ledger experiments. They are products meant to be operated by HARA as the platform provider, with BPJPH, LPH, MUI, and RSPO member companies as users.

---

## 4. Current Features (What's Shipped)

### 4.1 Chain & consensus
- **4-validator Hyperledger Besu QBFT network**, 2-second blocks, instant finality.
- **Chain ID 131216**, native token HARA (gas price 0 — invariant).
- **EVM target London** (Shanghai's PUSH0 broke Besu deploys; pinned to London + `--legacy` txs).
- Validator key custody in HashiCorp Vault, AppRole authentication (no root tokens distributed).
- Quantum-ready audit anchoring via `PQAnchorRegistry` (hybrid ECDSA + ML-DSA-65).

### 4.2 Smart contracts (all deployed on the live chain)
| Contract | Purpose |
|---|---|
| `ContractRegistry` | Address book for every deployed system contract; enables version migration. |
| `AnchorRegistry` | Classical-only audit anchor commitments (Merkle roots of event ranges). |
| `PQAnchorRegistry` | Hybrid quantum-ready audit anchors. Commits keccak256 of an ML-DSA-65 signature on-chain; blob lives off-chain in MinIO. |
| `GovernanceContract` | Role-gated governance (P0: 1-of-1; P1+: N-of-M multisig). |
| `HaraPalmOil` | ERC-1155 representing **litres** of sustainable palm oil. One token ID per batch; metadata captures RSPO cert hash, plantation ID, production date. |
| `TraceabilityBatchRelay` | Bundles N supply-chain hops into one transaction. Bypasses Besu QBFT's mempool ordering issue (intra-tx execution is deterministic). |

### 4.3 RPC & traffic layer
- **HAProxy load balancer** (maxconn 32 000, 16 threads) splitting read vs write traffic.
- **2 dedicated RPC-read nodes + 1 RPC-write node** behind the LB.
- **rpc-cache** service in front of read traffic — Redis-backed, method-specific TTLs. **99 % cache hit rate measured** on representative workload. Cuts validator load 40–60 % under read pressure.
- WebSocket subscriptions for real-time event consumers.

### 4.4 Indexing & traceability
- **Block indexer** following the chain in real time, decoding events for all 6 watched contracts.
- **REST traceability API** at `/trace/*`:
  - List batches, fetch full batch detail, fetch hops in order, fetch graph JSON.
- **Dual-renderer graph viewer** (Cytoscape + AntV G6) showing custody flow with 7 + 9 layouts, source/output pinning.
- **Blockscout** block explorer integrated.

### 4.5 Observability
- Prometheus + Grafana (`localhost:3200`).
- Loki + Promtail for log aggregation.
- Alertmanager with custom routing.
- 40+ pre-built metrics with `hara_ledger_*` prefix convention.

### 4.6 Operations & deployment
- Single-command local bring-up via `make bootstrap && make up && make deploy-all`.
- 6-VPS Nevacloud topology fully documented (`deploy/topology.md`) and tested locally.
- WireGuard mesh validation passing (2-peer test in `deploy/ops/wg-local-test.sh`).
- Postgres snapshot/restore drill passing (`deploy/ops/snapshot-restore-drill.sh`).
- TLS termination via Caddy with auto-renewing Let's Encrypt certs.

### 4.7 Quality & CI
- **40 forge tests** across all contracts, all green on CI.
- **Per-service TypeScript typecheck + build** across signer / broadcaster / indexer / rpc-cache / migrate / shared.
- **Slither** static analysis on every push.
- **Gitleaks** secret-scan with project allowlist.
- **CodeQL** ready (gated on repo visibility / GHAS).

---

## 5. Why It's Different

| Feature | HaraLedger | Public chains (Ethereum, Polygon) | Permissioned chains (Hyperledger Fabric, R3 Corda) |
|---|---|---|---|
| Gas fees | **Free** (gasPrice = 0) | $5–$100+ per tx, volatile | Free, but variable infrastructure cost |
| Finality | **Instant** (QBFT 2s blocks) | ~5–15 min (PoS) or longer | Instant |
| Solidity / EVM compatibility | **Yes** (London) | Yes | No (Fabric: chaincode; Corda: Kotlin) |
| Indonesian sovereignty | **Full** — runs on Indonesian VPSes | No | Self-host: yes |
| Regulatory acceptance | Built **for** Indonesian halal + RSPO regs | Depends on use case | Mature compliance tooling |
| Post-quantum readiness | **Yes** — hybrid ML-DSA-65 anchoring today | No | Mostly no |
| Public auditability | **Permissioned with public read** (Blockscout) | Public | Private |
| 45-month operational horizon | Designed for it (storage planning, snapshot ops) | Always-on but you don't own the infrastructure | Yes |

**The combination is unique:** EVM developer ergonomics + zero gas + instant finality + sovereign hosting + PQ-ready audit trail. No public chain offers the second, third, fourth, or sixth. No permissioned chain (Fabric, Corda) offers the first.

---

## 6. Stages / Phases — Where We Are

The roadmap (`doc/hara-registry-roadmap.md`) defines four maturity phases. We are between P0 and P1.

| Phase | Months | Goal | Where we are |
|---|---|---|---|
| **P0 — Prototype** | 0–4 | End-to-end demo on a single developer machine, all contracts deployed, indexer working | ✅ **Complete in local dev** |
| **P0.5 — VPS transition** | 4 (now) | First Nevacloud VPS, single-host parity with local, smoke test | 🟡 **In progress.** Most gating items closed (Vault Raft HA, WireGuard validated, snapshot/restore drill passing). Awaiting VPS provisioning. |
| **P1 — Pilot** | 4–10 | 4-validator consortium across Nevacloud + Huawei, K3s, ISO 27001 prep, closed beta with single-digit-thousand users | ⏳ Next |
| **P2 — National** | 10–22 | 7–15 validators, multi-cloud, ClickHouse analytics, dual-anchor to IOTA L1 + Ethereum L1, millions of consumer DIDs | ⏳ Later |
| **P3 — Global** | 22–40 | Avalanche Subnet rehearsal + migration, multi-country, regulator-grade audits | ⏳ Long-term |

The **L0–L5+** ladder in `ops/runbooks/L*.md` is the **implementation layer** within phases — L0 local bring-up, L1 RPC separation, L2 signer/broadcaster, L3 indexer, L4 monitoring, L5 Blockscout. Today the platform is at **L5 stable, inside P0**, transitioning to P0.5.

---

## 7. Next Development — Ordered

Concrete, near-term work, in dependency order:

### 7.1 Immediate (this sprint)
1. **Validator snapshot/restore drill** — close the lower-risk half of pre-VPS gate #3 (Postgres drill is done).
2. **`secrets-bootstrap.sh` dry-run** — pre-VPS gate #5; verify each `.env` file generates cleanly with prod-shaped values.
3. **First-VPS smoke test on Nevacloud** — pre-VPS gate #7. Provision `hara-stateful` first, verify Vault + Postgres + Redis up and reachable from operator laptop via WireGuard.
4. **GitHub branch protection** — UI task; all required check names now have successful runs on `main`. State-2 §11 #1.

### 7.2 Short term (next 1–2 months, completes P0.5 → P1 entry)
5. **Fan out the other 5 Nevacloud VPSes**, run `wg-bootstrap.sh`, bring up the full topology.
6. **Merkle anchor worker** — small Node service that periodically (e.g. every 10 min) reads `indexed_events`, computes a Merkle root over the new range, ML-DSA-65-signs it, and calls `PQAnchorRegistry.recordAnchor()` + writes the blob to MinIO. Closes the gap between "PQAnchorRegistry exists" and "audit anchors actually exist."
7. **`make reset-indexer`** target + runbook entry — small chore but earned its place during the chain wipe.
8. **`IssuerRegistry` contract** for hara-did — referenced by hara-did's compose env but no source contract exists yet. Needs to land in `contracts/src/`.
9. **OpenTelemetry instrumentation** of TS services — adds distributed tracing for P1 readiness.

### 7.3 Medium term (P1, months 4–10)
10. **K3s migration** for the stateless tier. Compose stays on hara-v1..v4 (validators) and hara-stateful; stateless becomes a 2–3-node K3s cluster.
11. **Multi-region Nevacloud** — split validators across Jakarta + Surabaya so a single-region outage costs ≤ 2 validators (consensus quorum survives).
12. **ClickHouse** for event analytics — historical aggregates over the indexed event stream. Postgres views (`custody_hops`, `batch_summary`) hit their scaling limits around ~10 M events.
13. **Hashicorp Vault multi-node Raft HA** — today is single-node Raft; multi-node arrives when stateless tier becomes HA.
14. **IOTA L1 anchoring** — every 10 min, write a hash of the latest chain block to the IOTA Tangle for tamper-evidence outside HaraLedger itself.
15. **ISO 27001 stage-1 prep** — pen test, documentation, control inventory.

### 7.4 Long term (P2 / P3)
16. Dual-L1 anchoring (IOTA + Ethereum L1).
17. Avalanche Subnet migration rehearsal (P3 prep).
18. ML-DSA on-chain verifier when EVM precompiles land (~2027–2029).
19. Multi-country regulator integrations.

---

## 8. Operational Characteristics

What to expect from the platform at each phase.

### 8.1 P0 / P0.5 (today)
- **Uptime target:** best-effort, single-VPS recovery possible from snapshots.
- **Throughput:** ~50 TPS sustained, 500 TPS burst (measured under load tests; bypasses HAProxy).
- **Latency:** sub-second writes, sub-millisecond reads (rpc-cache 99 % hit).
- **Storage:** ~25 GB/year per validator at current event rates.
- **Maintenance windows:** unannounced.

### 8.2 P1 (pilot)
- **Uptime target:** 99.5 % monthly (≈ 3.5 hr downtime/month).
- **Throughput:** 200 TPS sustained.
- **Recovery objectives:** RPO 24 h (daily snapshots), RTO 4 h (one operator + runbook).
- **Maintenance windows:** announced 7 days ahead.

### 8.3 P2 (national)
- **Uptime target:** 99.9 % (≈ 43 min downtime/month).
- **Throughput:** 1,000 TPS sustained.
- **Multi-region active-active** for the RPC tier.
- **24/7 on-call** rotation.

---

## 9. Stakeholders & Use Cases

### 9.1 BPJPH (Badan Penyelenggara Jaminan Produk Halal)
The Indonesian government body that issues halal certificates. Their interest:
- Tamper-evident issuance log.
- Real-time revocation propagation.
- Scan-and-verify portal for international auditors.

### 9.2 LPH (Lembaga Pemeriksa Halal)
Inspection bodies that audit producers and recommend issuance to BPJPH. Their interest:
- Auditable inspection records on-chain.
- Multi-stakeholder governance (no single LPH controls the registry).

### 9.3 MUI (Majelis Ulama Indonesia)
Religious authority that issues doctrinal halal fatwas. Their interest:
- Cryptographic attestation that a certificate carries MUI's fatwa.
- Selective disclosure for sensitive ingredient information.

### 9.4 RSPO members + palm-oil supply chain
Plantations, mills, refiners, traders, manufacturers. Their interest:
- Mass-balance accounting that doesn't depend on Excel.
- Provable chain-of-custody for export auditors (EU CSDDD, EUDR).

### 9.5 End consumers
QR-scan a product, see:
- Halal cert status (active / expired / revoked).
- Plantation of origin, RSPO cert hash.
- Issuance + last-update timestamps.

---

## 10. Cost & Resourcing (current best estimate)

From `doc/nevacloud-proposal.md` §Bagian 2 (Option B, recommended):

| Item | Monthly | 45-month total |
|---|---|---|
| hara-v1..v4 (4 validator VPSes) | Rp 2.8 M | Rp 126 M |
| hara-stateful (data + secrets) | Rp 2.5 M | Rp 112.5 M |
| hara-stateless (apps + obs) | Rp 1.7 M | Rp 76.5 M |
| Object storage (300 GB) | Rp 0.3 M | Rp 13.5 M |
| **Total (chain only)** | **Rp 7.3 M** | **Rp 328.5 M** |

Add hara-did: +Rp 2.5 M / month, +Rp 112.5 M / 45 months.
Add hara-passport: +Rp 2.6 M / month, +Rp 117 M / 45 months.

**All-in (chain + did + passport): ~Rp 12.4 M / month = ~Rp 558 M / 45 months ≈ USD 35 000 / year.**

Engineering: single maintainer (`@imronzuhri-svg`) until P1, then scale to 3–5 engineers + 1 ops.

---

## 11. Risks & Constraints

### 11.1 Technical risks
- **Vault single-node** — fixed for P0/P1 (today's chain stall proved this).
- **Validator quorum** — QBFT halts at 2/4 validators down. Mitigation: multi-region (P1).
- **Mempool ordering on Besu QBFT** — chained txs need `TraceabilityBatchRelay` (in-place).
- **45-month storage projection** — at current event rate, hara-stateful's 1 TB NVMe covers full term per `nevacloud-proposal.md`. Re-evaluate at month 24.

### 11.2 Regulatory risks
- **UU PDP** (Indonesian Personal Data Protection law) — DID + halal-cert metadata must respect retention + selective disclosure rules.
- **ISO 27001** — required for export-market acceptance (Saudi, UAE, Singapore). Scheduled for P1.
- **EU CSDDD / EUDR** — Indonesian palm-oil exports to EU need provable due diligence + traceability by 2027. HaraLedger is designed for this.

### 11.3 Adoption risks
- **BPJPH integration speed** — depends on government IT cycles.
- **Multi-stakeholder consortium governance** — getting LPH + MUI + BPJPH to share a chain takes political work, not just code.

---

## 12. Glossary

- **AppRole** — Vault authentication method that gives short-TTL tokens scoped to a specific role, replacing root-token-everywhere.
- **BPJPH** — Indonesian halal certification authority.
- **Besu** — Hyperledger's Java EVM client.
- **CRQC** — Cryptographically Relevant Quantum Computer; the threat model for our post-quantum work.
- **DID** — Decentralised Identifier (W3C standard). hara-did implements the `did:hara` method.
- **ERC-721 soulbound** — non-transferable NFT; the halal passport.
- **ERC-1155** — multi-token standard; one contract holds many fungible token IDs (one per palm-oil batch).
- **LPH** — Indonesian halal inspection body.
- **ML-DSA-65** — NIST FIPS 204 post-quantum signature scheme (Dilithium 3), 3309 bytes per signature.
- **MUI** — Indonesian Council of Ulama, religious authority.
- **QBFT** — Quorum BFT consensus, the algorithm Besu uses for permissioned chains.
- **RSPO** — Roundtable on Sustainable Palm Oil; international certification body.
- **Sidetree** — DID anchoring protocol that batches DID operations and commits batch hashes on-chain.

---

## 13. Quick Reference

```
Chain ID:       131216
Native token:   HARA (gas price 0)
Block time:     ~2 s
Finality:       instant (QBFT)
Validators:     4 (10.42.0.11–14)
RPC read:       http://rpc-read:8545
RPC write:      http://rpc-write:8545
WebSocket:      ws://rpc-read:8546
Cache:          http://rpc-cache:8088
Grafana:        http://localhost:3200
Blockscout:     http://localhost:4010
Repo:           https://github.com/imronzuhri-svg/hara-registry
Maintainer:     @imronzuhri-svg
Companion repos: hara-did, hara-halal-passport, hara-xchange
```
