# HaraLedger — Infrastructure & Deployment Roadmap
## From prototype-demo, to pilot, to national, to global · Local → Nevacloud → Nevacloud + Huawei

This document is the **infrastructure-and-deployment** counterpart to `haraledger_ecosystem_development_blueprint.md` and the chain-side counterpart to `hara-did/docs/architecture/haradid-roadmap.md`.

It answers two questions concretely:

1. **What infrastructure exists at each maturity phase?** (Prototype-Demo → Pilot → National → Global)
2. **Where does it run?** (Local Docker → Nevacloud VPS → Nevacloud + Huawei multi-cloud → Multi-cloud + sovereign clouds)

Every choice is defended. The blueprint specifies *what* to build; this roadmap specifies *when, where, and why*.

---

## Part 1 — The opinionated calls

Twelve infrastructure decisions. Each was a fork; we pick one direction and live with it.

### Decision 1 — Chain client: Besu QBFT now, Avalanche Subnet at scale

**Options considered**
- A. Hyperledger Besu (QBFT consensus)
- B. Hyperledger Besu (IBFT 2.0)
- C. Quorum (GoQuorum)
- D. Polygon Edge / Supernets
- E. Start directly on Avalanche Subnet

**Pick: A (Besu QBFT) for P0–P2, migrate to Avalanche Subnet in P3.**

**Why**
- Besu has the strongest Ethereum-foundation backing, active maintenance, and Java toolchain that Indonesian/SEA enterprise ops teams can hire for.
- QBFT > IBFT2 — QBFT fixes the safety/liveness issues IBFT2 has under network partition. Both are EVM-compatible.
- Quorum/GoQuorum is going EOL on ConsenSys; not a long-term bet.
- Polygon Edge was deprecated mid-2024.
- Starting on Avalanche Subnet locks us to one vendor before we have leverage. Migration in P3 (proven path, EVM-compatible) gives us the option to bargain or pivot to Polygon CDK if economics differ.

**Migration trigger** (P2→P3): when sustained TPS > 200 or validator count > 12, or when zk-validity to a public chain becomes a regulatory requirement.

---

### Decision 2 — Consensus tuning: 2-second block time, gas-free for HARA contracts

**Options considered**
- A. 1s block, full gas economy
- B. 2s block, gas-free for whitelisted contracts
- C. 5s block, gas-free everywhere
- D. Block-on-demand (Avalanche-style)

**Pick: B.**

**Why**
- 1-second blocks stress validator hardware and produce too much state churn at our anticipated TPS.
- 5 seconds is too slow for QR verification UX (users expect sub-3-second response from scan to "verified ✓").
- Gas-free *everywhere* invites spam; gas-free for *whitelisted Hara contracts only* (via a `FreeGasPaymaster` pattern) gives the right incentives — HARA pays gas for HARA workflows, third parties pay if they deploy their own contracts later.
- 2s + paymaster gives us ~500 TPS theoretical headroom, more than enough through P2.

---

### Decision 3 — RPC topology: hard read/write separation from day one

**Options considered**
- A. Validators expose RPC publicly (simplest)
- B. Read/write RPC behind a load balancer, validators private
- C. Full mesh: read RPC, write RPC, internal RPC, partner RPC, archive RPC (per blueprint §3.2)

**Pick: B for P0–P1, evolve to C in P2.**

**Why**
- Letting public traffic hit validators is the #1 cause of consortium-chain outages. Non-negotiable: validators are never publicly addressable.
- Full mesh (C) is correct long-term but overkill for prototype. Start with two RPC node classes (read + write) and split further as load justifies.

---

### Decision 4 — Primary cloud: Nevacloud (Indonesian sovereign), Huawei as DR + AI

**Options considered**
- A. Single hyperscaler (AWS / GCP / Azure ID region)
- B. Nevacloud only
- C. Nevacloud primary + Huawei DR
- D. Multi-hyperscaler from day one

**Pick: C.**

**Why**
- **UU PDP (Indonesia's Personal Data Protection Law)** requires data residency for personal-data-processing systems. AWS/GCP/Azure have ID regions but the political optics of national identity infrastructure on US-controlled cloud are bad. Nevacloud is the cleanest sovereign answer.
- Single-cloud is a single-vendor risk. Huawei as the second cloud gives us a credible DR target and unlocks Huawei's AI services (for the compliance/intelligence layer in the blueprint).
- Multi-hyperscaler from day one triples ops complexity for a Phase-1 system with no real traffic. Defer to P2 when volume justifies.
- Huawei's presence in Indonesia is strong, has government relations, and their Cloud Stack supports air-gapped sovereign deployments if regulators later require it.

---

### Decision 5 — Validator distribution: HARA-only in P0, consortium in P1+, multi-cloud in P2+

**Options considered**
- A. HARA runs all validators forever (fastest, least decentralized)
- B. Open validator participation (most decentralized, slowest)
- C. Permissioned consortium with regulator + industry validators

**Pick: C.**

**Phase mapping**
- **P0 Prototype**: 1 validator (HARA), single VPS — for dev only
- **P1 Pilot**: 4 validators (HARA + 3 consortium partners), all on Nevacloud different regions/AZs
- **P2 National**: 7–15 validators across HARA + regulators (BPJPH/MUI/OJK/Dukcapil class) + 2–3 industry partners + 1–2 universities, Nevacloud + Huawei mix
- **P3 Global**: 20–100+ validators across OIC-member countries, multi-cloud + sovereign cloud + bare-metal

**Why**
- Pure HARA is "trust me" — kills the value proposition.
- Open validation requires staking economics we don't have on a permissioned chain.
- Consortium with named, regulated, accountable validator operators matches the actual trust model and is what every comparable national infrastructure (EBSI, Trinsic, Indy) does.

---

### Decision 6 — State pruning: full archive on 2 nodes, pruned state on the rest

**Options considered**
- A. All validators run full archive (most data, biggest disk)
- B. All validators run pruned (smallest, no historical queries)
- C. Two dedicated archive nodes + rest pruned

**Pick: C.**

**Why**
- Archive on every validator quadruples storage cost and offers no consensus benefit.
- Pruned everywhere makes historical queries (audit, "what did this cert look like 3 years ago") impossible to answer without re-syncing from genesis.
- Two archive nodes — one Nevacloud, one Huawei — give us redundant historical access without bloating the validator set. Indexer reads from archive nodes; live RPC reads from pruned nodes.

---

### Decision 7 — Anchoring chain: IOTA L1 in P1, dual-anchor to Ethereum in P2+

**Options considered**
- A. No public anchoring (private chain only)
- B. IOTA L1 only (feeless, suits high-frequency anchoring)
- C. Ethereum L1 only (most credible audit anchor)
- D. Dual anchor (IOTA + Ethereum)

**Pick: B for P1, evolve to D in P2.**

**Why**
- No public anchor = no external proof = "trust HARA's validators." Defeats the purpose at national scale.
- IOTA is feeless and high-throughput — anchor every 10 minutes costs nothing. Right primitive for high-frequency.
- Ethereum is *the* credibly-neutral audit trail; international auditors and OIC partners will accept an Ethereum anchor faster than an IOTA one.
- Dual anchor: IOTA every 10 min (continuous), Ethereum daily (canonical snapshot). Belt and suspenders, low cost.

---

### Decision 8 — Indexer database: PostgreSQL for state, ClickHouse for history

**Options considered**
- A. PostgreSQL only
- B. PostgreSQL + OpenSearch (per blueprint)
- C. PostgreSQL + ClickHouse
- D. TigerBeetle / specialized chain-indexer DB

**Pick: C.**

**Why**
- PostgreSQL alone is fine through P1 but will start to suffer past ~100M event rows.
- OpenSearch is good for free-text search; mediocre for analytical queries over billions of rows. Wrong tool for chain-event analytics.
- ClickHouse is purpose-built for this: append-only, column-oriented, handles billions of rows, partitions cleanly by time + contract.
- Postgres keeps current-state (small, transactional). ClickHouse keeps history (huge, analytical). Both can be backed up independently.

---

### Decision 9 — Object storage: MinIO on Nevacloud, replicated to Huawei OBS

**Options considered**
- A. Self-hosted MinIO single-region
- B. MinIO + cross-region replication
- C. Native cloud object storage (Nevacloud / Huawei OBS native)
- D. Decentralized storage (Storj, Filecoin)

**Pick: B (MinIO Nevacloud) + replication to Huawei OBS for DR.**

**Why**
- Self-hosted MinIO is operationally well-understood, S3-compatible (easy migration target), and doesn't lock us to a single cloud's API.
- Native cloud object storage locks the bucket lifecycle to one provider.
- Decentralized storage is interesting for HaraDID's CAS layer (separately) but overkill for HaraLedger's chain snapshot + document hash storage.
- Huawei OBS replication is the DR target — already part of the broader cloud split (Decision 4).

---

### Decision 10 — Key management: env → Vault → HSM → MPC

**Options considered**
- A. Stay on encrypted env files (simplest)
- B. Hashicorp Vault from P1
- C. HSM (cloud KMS or physical) from P2
- D. MPC for highest-value keys in P3

**Pick: progressive — A in P0, B from P1, C from P2, D in P3 for governance keys.**

**Why**
- Env files are fine for prototype-demo where no real value is at stake.
- Vault gives us audit logging, rotation, role-based access — the table stakes for pilot.
- HSM (Cloud KMS on Nevacloud / Huawei, or physical Thales/Utimaco units in P3) is required before national rollout for both real security and audit checkbox compliance (ISO 27001, SOC 2 require it for production identity systems).
- MPC for the highest-value keys (chain governance, anchor signing) eliminates the single-HSM compromise risk.

---

### Decision 11 — Container orchestration: Docker Compose → K3s → Kubernetes

**Options considered**
- A. Docker Compose forever
- B. Docker Swarm
- C. K3s (lightweight Kubernetes)
- D. Full Kubernetes (managed or self-hosted)

**Pick: Compose in P0, K3s in P1, full K8s from P2.**

**Why**
- Compose is unbeatable for local + single-VPS dev.
- Swarm is dying; not a forward investment.
- K3s gives us 80% of Kubernetes with 20% of the ops cost — right for the 4-validator pilot.
- Full Kubernetes (managed on Nevacloud, or self-hosted with Talos/Rancher) is required from P2 onward for the multi-region, multi-cloud, multi-tenant complexity that's coming.

---

### Decision 12 — Migration to Avalanche Subnet: rehearse in P2, execute in P3

**Options considered**
- A. Never migrate (stay on Besu forever)
- B. Migrate to Avalanche Subnet
- C. Migrate to Polygon CDK
- D. Migrate to a zk-rollup with public L1 settlement

**Pick: B, with C as fallback if zk-validity becomes a regulatory hard requirement.**

**Why**
- Besu QBFT scales to ~200 TPS sustained; past that, state growth and consensus overhead become real problems for a 15+ validator network.
- Avalanche Subnet (Subnet-EVM or HyperSDK) is EVM-compatible, has custom gas-token economics that suit our "free for HARA workflows" model, has Indonesian/SEA presence, and doesn't require giving up validator sovereignty.
- Polygon CDK is good if zk-validity proofs to Ethereum L1 become required by international auditors. Track as parallel option.
- The blueprint § migration-rules and the HaraDID roadmap D11 already enforce chain-portability discipline. Migration in P3 is mechanical, not a rewrite.

---

## Part 2 — Infrastructure phases

Four maturity phases, each with explicit infrastructure footprint, cloud distribution, and exit criteria.

### **P0 — Prototype-Demo** (months 0–4)

**Goal**: prove the end-to-end concept on a single developer machine and one VPS.

**Infrastructure**
- 1 validator (Besu QBFT, single node)
- 1 RPC node (combined read/write, local dev)
- 1 Postgres (chain indexer DB)
- 1 Redis (queue + cache)
- 1 MinIO (single-bucket)
- 1 Prometheus + Grafana (basic dashboards)
- All contracts deployed: `IssuerRegistry`, `SidetreeAnchor`, `RevocationRegistry`, `HalalPassport`, `AnchorRegistry`
- No anchoring (skip IOTA for P0)
- Local Docker Compose orchestration

**Cloud footprint**
- **Local Docker** for developer work
- **1 × Nevacloud VPS** (8 vCPU / 16 GB / 200 GB) for shared demo environment
- **No Huawei** yet
- Cost: ~IDR 2–3M/month all-in

**Team operations**
- Manual deploy via Ansible playbooks
- Snapshot backups daily to a second Nevacloud volume
- Slack alerts from Grafana

**Exit criteria**
- End-to-end demo: issuer registers → DID anchored via Sidetree → halal cert minted as ERC-721 soulbound → consumer scans QR → verifier confirms ✓ — entirely on the prototype stack.
- Internal stakeholders + 2 friendly regulators have personally driven the demo.
- All contracts have ≥ 90% test coverage.

---

### **P1 — Pilot** (months 4–10)

**Goal**: production-grade 4-validator consortium serving a limited closed-beta user base (single-digit thousand users, single-digit thousand certificates).

**Infrastructure** (per blueprint §11 Phase 2, condensed)
- 4 validators (HARA + 3 consortium partners, separate Nevacloud accounts/regions)
- 2 RPC read nodes + 1 RPC write node (HAProxy LB in front)
- 2 archive nodes (1 Nevacloud, 1 Huawei) — fulfils Decision 6
- 1 Postgres primary + 1 read replica
- 1 ClickHouse single-node (for event analytics, prep for P2 scale)
- 1 Redis (Streams + cache)
- 1 MinIO 4-disk cluster, replicated to Huawei OBS
- 2 indexer instances (active-passive)
- 1 signer service + 1 nonce manager (separate VPS, private network)
- 1 Sidetree batcher (single instance; multi-batcher in P2 per HaraDID D10)
- IOTA L1 anchoring service (every 10 min)
- Prometheus + Grafana + Loki + Alertmanager
- K3s orchestration across the cluster

**Cloud footprint**
- **Nevacloud primary** (~14 VPS, multi-region within Indonesia: Jakarta + Surabaya)
- **Huawei secondary** (~4 nodes: 1 backup validator, 1 archive node, 1 DR Postgres replica, 1 Huawei OBS replication target)
- **No multi-country yet**
- Cost: ~IDR 80–120M/month all-in

**Security / compliance**
- Hashicorp Vault for signer keys (Decision 10)
- ISO 27001 prep begins
- UU PDP DPA filed with regulator
- Pen test by external firm

**Governance**
- 3-of-4 multi-sig for chain governance actions
- Validator onboarding via off-chain regulator-signed approval committed on chain
- IssuerRegistry GOVERNANCE_ROLE held by 3-of-5 multi-sig

**Exit criteria**
- 4-validator consortium runs stably for 90 days with no consensus-level incidents
- 10,000+ holder DIDs anchored, 1,000+ halal certificates issued
- Successful chaos test: kill any 1 validator, network keeps producing blocks
- ISO 27001 Stage 1 audit passed

---

### **P2 — National** (months 10–22)

**Goal**: serve Indonesian national-scale traffic — BPJPH, all LPHs, all MUI provincial offices, major exporters/importers/manufacturers; millions of consumer DIDs; hundreds of thousands of certificates per year.

**Infrastructure**
- 7–15 validators distributed across Nevacloud + Huawei + at least 2 partner-operated regions
- Full RPC mesh per blueprint §3.2 (read, write, internal, partner, archive — each in HA pairs)
- 4-node Postgres cluster (primary + 2 replicas + DR), Patroni-managed
- ClickHouse 3-node cluster (sharded by time + contract)
- Redis Cluster (3 master + 3 replica)
- MinIO multi-site replicated cluster (Nevacloud + Huawei OBS active-active)
- Indexer horizontally scaled (4–8 workers, leader-elected for hot path)
- Sidetree batcher with Raft leader election (3 instances) per HaraDID Decision 5
- Dual anchoring: IOTA every 10 min + Ethereum L1 daily
- Full Kubernetes (managed on Nevacloud, federation to Huawei CCE)
- Multi-region active-active for read paths; active-passive for write paths
- ArgoCD + Helm for deploys

**Cloud footprint**
- **Nevacloud Jakarta + Surabaya + Batam** (~40 nodes, primary writes)
- **Huawei Jakarta + Singapore** (~15 nodes, secondary writes + AI + DR)
- **2 partner data centers** for validator diversity (e.g., a BPJPH-hosted node, a university-hosted node)
- Cost: ~IDR 450–600M/month all-in (chain infra only; not counting HaraDID side)

**Security / compliance**
- HSM (Cloud KMS on Nevacloud + Huawei DEW) for validator signing keys
- ISO 27001 certified
- SOC 2 Type I in flight
- UU PDP audit passed
- Annual external security audit
- 24/7 SOC with 15-minute response SLA

**Governance**
- DAO-style governance contract (post HaraDID D8)
- 5-of-9 multi-sig for non-routine governance
- 7-day timelock on contract upgrades
- Public proposal lifecycle visible in admin console and explorer

**AI compliance layer (Huawei side)**
- Document OCR + extraction on Huawei AI servers
- Risk scoring models on Huawei ModelArts
- Anomaly detection on certificate issuance patterns

**Migration prep**
- Avalanche Subnet rehearsal environment running in parallel (per HaraDID D11)
- Migration dry-runs quarterly
- Polygon CDK fallback environment also evaluated

**Exit criteria**
- 100,000+ certificates issued, 5M+ holder DIDs anchored, sustained 50 ops/sec
- Successful loss-of-region test: take down all Jakarta nodes, Surabaya + Huawei keep serving
- ISO 27001 certified, SOC 2 Type I report published
- 12 months continuous uptime > 99.95%

---

### **P3 — Global** (months 22–40)

**Goal**: serve OIC-member countries (potentially 57 nations) and international halal trade verification — chain capable of billions of DIDs and tens of millions of certificates/year. Migrate from Besu to Avalanche Subnet (or Polygon CDK if zk-validity required).

**Infrastructure**
- **Avalanche Subnet** (or Polygon CDK) — primary chain
- 20–100+ validators distributed across OIC-member-country sovereign clouds
- Multi-region Kubernetes federation
- Dedicated archive node clusters per region (data residency compliance)
- Sidetree CAS sharded by DID-suffix prefix per HaraDID D10
- Cross-region active-active for both read and write paths (eventual consistency on writes, sub-second on reads)
- Public anchoring extended: IOTA + Ethereum + 1–2 OIC-relevant chains (potentially a sovereign halal-specific chain operated by an OIC body)
- Real-time ClickHouse cluster (10+ nodes, replicated cross-region)
- Native edge resolvers (Cloudflare Workers / Fastly Compute@Edge) for global verification latency < 200 ms

**Cloud footprint**
- **Nevacloud Indonesia** — primary writes, Indonesian sovereign data
- **Huawei Indonesia + Malaysia + Saudi Arabia** — regional sovereign clouds for OIC participants
- **3–5 OIC-member-state sovereign clouds** (UAE G42, Saudi STC Cloud, Turkey Türk Telekom Cloud, Malaysia TM One — selected by regulatory requirement)
- **2 hyperscaler edge regions** (Cloudflare / Akamai) for verification reads only (no personal data)
- Cost: scales with adoption; budget model = per-country pod (~IDR 200–300M/month per active country)

**Security / compliance**
- Physical HSM (Thales Luna or Utimaco) in two regions for governance keys
- MPC ceremony for highest-value chain governance signers
- SOC 2 Type II
- ISO 27001 + ISO 27701 (privacy management)
- Country-specific data protection certifications (PDPA, GDPR-equivalent where relevant)
- Annual independent cryptographic audit
- Coordinated disclosure / bug bounty program

**Governance**
- Multi-party DAO with weighted voting (HARA + regulators + validators + civil-society observers)
- Cross-border governance protocol for OIC partners
- Audit committee with rotating chair from member states

**Migration execution**
- P3 begins with **Besu → Avalanche Subnet cutover** (or Polygon CDK)
- Dual-resolver / dual-chain operation for 6-month transition
- Besu network preserved as read-only historical archive indefinitely (no decommission — audit liability)

**Exit criteria**
- ≥ 5 OIC member states have active validators or active integrations
- Tens of millions of certificates indexed and verifiable globally
- Average certificate verification latency from anywhere in the world < 1 second
- Cross-border interoperability with at least 2 international halal authorities outside Indonesia

---

## Part 3 — Cloud pathway summary

```
                    LOCAL        NEVACLOUD       NEVACLOUD          MULTI-CLOUD +
                    DOCKER       PRIMARY         + HUAWEI DR        SOVEREIGN CLOUDS
                    ─────        ─────────       ───────────        ─────────────
P0 Prototype        ████         ▓                                  
P1 Pilot                         ████████        ▓▓                 
P2 National                                      ████████           ▓▓
P3 Global                                                           ████████

Legend: ████ = primary footprint   ▓▓ = secondary footprint
```

**Why this pathway, not "go straight to multi-cloud"**

- Multi-cloud has **3× the ops complexity** of single-cloud. Doing it before there's traffic to justify it burns engineering time on plumbing that produces no user value.
- Nevacloud as primary is the **regulatory and political requirement** for Indonesian national identity / certificate infrastructure under UU PDP.
- Huawei as second cloud (P1+) unlocks **AI compliance services** that AWS/GCP can't legally offer for some regulated data, *and* it sets up the OIC-country pattern (P3) where Huawei has deeper regional reach than Western hyperscalers.
- Sovereign clouds in P3 are **per-country regulatory necessity**, not a preference — Saudi data has to stay in Saudi, UAE data in UAE, etc.

---

## Part 4 — Already done vs what phase finishes it

Honest accounting:

| Component | Today | Phase that finishes it |
|---|---|---|
| Besu QBFT dev validator | ✅ working locally | P0 (deploy to Nevacloud) |
| Smart contracts (DID, Cert, Revocation, Anchor) | 🟡 partial — see HaraDID roadmap | P1 |
| RPC read/write split | ❌ combined | P1 |
| Postgres indexer | 🟡 schema only | P1 |
| ClickHouse for analytics | ❌ not deployed | P2 |
| MinIO object storage | 🟡 single-instance dev | P1 cluster, P2 multi-site |
| Sidetree batcher | ❌ not built | P1 (single), P2 (Raft) |
| IOTA anchoring | ❌ not built | P1 |
| Ethereum L1 anchoring | ❌ not built | P2 |
| Vault for secrets | ❌ env files | P1 |
| HSM for signing | ❌ none | P2 |
| MPC for governance | ❌ none | P3 |
| ISO 27001 | ❌ not started | P1 prep → P2 cert |
| SOC 2 | ❌ not started | P2 Type I → P3 Type II |
| Kubernetes | ❌ docker-compose only | P1 K3s, P2 full K8s |
| Multi-region | ❌ single-region | P2 |
| Multi-cloud (Nevacloud + Huawei) | ❌ Nevacloud only | P1 begin, P2 full |
| Multi-country sovereign | ❌ Indonesia only | P3 |
| Avalanche Subnet migration | ❌ not started | P2 rehearsal → P3 execute |

---

## Part 5 — Timeline + dependencies

```
P0 Prototype-Demo  ▮▮▮▮                                                        4 months
P1 Pilot               ▮▮▮▮▮▮                                                  6 months
P2 National                  ▮▮▮▮▮▮▮▮▮▮▮▮                                    12 months
P3 Global                                ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮                  18+ months
                                                                            ────────────
                                                                            40+ months
```

Phases overlap intentionally:
- P1 detailed planning begins month 3 (during P0)
- P2 hardware procurement + ISO prep begins month 9 (during P1)
- P3 migration rehearsal begins month 16 (during P2)

Critical path: P0 → P1 → P2 cutover gate (ISO 27001 + sustained-load test) → P3 chain migration.

---

## Part 6 — Resourcing call

Infrastructure team needed by phase. (HaraDID and product-side teams are separate.)

| Role | P0 | P1 | P2 | P3 |
|---|---:|---:|---:|---:|
| Blockchain / DevOps SRE | 1 | 3 | 6 | 10 |
| Backend (indexer, signer, batcher) | 1 | 2 | 4 | 6 |
| Security engineer | 0.5 | 1 | 2 | 3 |
| Cloud architect | 0.5 | 1 | 2 | 3 |
| Compliance / audit lead | 0 | 0.5 | 1 | 2 |
| 24/7 NOC | 0 | 0 | 6 | 12 |
| **Total FTE (infra only)** | **3** | **7.5** | **21** | **36** |

Indicative annualised cost (Indonesia rates, all-in):
- P0: IDR 1–1.5B
- P1: IDR 4–5B
- P2: IDR 18–22B
- P3: IDR 35–45B + cross-border travel/compliance ~IDR 5–8B

---

## Part 7 — What we are explicitly NOT doing

- **No public mainnet launch as a permissionless chain.** HaraLedger stays permissioned across all four phases. The trust model is consortium accountability + public anchoring, not anonymous validator participation.
- **No native HARA token.** Validator incentives come from real-world contractual obligations (operator agreements with HARA / regulators), not a token economy. This avoids regulatory complications (Bappebti, OJK) and prevents speculation from distorting governance.
- **No on-chain personal data.** Every phase preserves: hashes on chain, full data off-chain. P3 sovereign-cloud requirements only matter for the off-chain side.
- **No homegrown consensus.** Besu QBFT now, Avalanche or Polygon CDK consensus later — both proven, both supported. Never write our own.
- **No big-bang migrations.** P0→P1, P1→P2, P2→P3 each have overlap windows of 3–6 months. We never cut over without parallel-running the new infra.
- **No closed-source chain client.** Besu, Avalanche Subnet, and Polygon CDK are all open-source. If a vendor goes hostile or fails, we still own the bits.

---

## Part 8 — Why this is the right pathway

Five forcing functions shaped every decision:

**1. Regulatory residency is non-negotiable.** UU PDP + sector-specific rules (BPJPH for halal, OJK for finance, Dukcapil for identity) require Indonesian sovereign cloud as the primary footprint. Nevacloud is the cleanest answer; Huawei is the credible second; hyperscaler edge is for read-only public verification at P3 global scale.

**2. The migration optionality is the protection.** Besu QBFT today is a means, not an end. The blueprint's chain-portability rules + HaraDID's D11 + this roadmap's P2 rehearsal + P3 execution mean we are never stuck if Besu's roadmap diverges from our needs.

**3. Decentralization grows with maturity.** P0 single-operator, P1 small consortium, P2 national consortium, P3 cross-border DAO. Each step adds decentralization when the trust we've earned can support the operational complexity. The reverse path — "decentralize first, then earn trust" — has bankrupted three comparable identity projects in the past five years.

**4. Multi-cloud is a destination, not a starting point.** Operating one cloud well at P0 is harder than it looks. Operating two badly at P0 is a recipe for outages. P1 dips a toe into Huawei (DR + AI). P2 commits to active-active. P3 fans out to sovereign clouds. Each step is paid for by the previous one's stability.

**5. Compliance is built in, not bolted on.** ISO 27001 prep starts in P1, certification in P2. SOC 2 Type I in P2, Type II in P3. UU PDP from day one. Country-specific certifications added per market entry in P3. International regulators don't accept retroactive compliance — the only way is to plan it into the build phase.

That combination — **sovereign-cloud-primary, consortium-decentralized, chain-portable, compliance-built-in, migration-rehearsed** — is what makes this infrastructure pathway different from a generic "blockchain deployment" plan. The work in P0–P3 is what makes HaraLedger national infrastructure rather than a research project that scaled badly.
