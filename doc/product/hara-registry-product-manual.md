# Hara Registry — Product & Users Manual

**Audience:** BPJPH / LPH / MUI, RSPO member companies (plantations, mills, refiners, traders, exporters), international buyers, regulators, integration partners, and end consumers scanning a product QR code.
**Reading level:** plain language. No engineering background assumed.
**Companion documents:** the [Technical Manual](../technical/hara-registry-technical-manual.md) (for developers and auditors) and the [Integration Manual](../guides/hara-registry-integration-manual.md) (for engineers connecting a system).
**Snapshot date:** 2026-06-19.

---

## Table of contents

1. [What Hara Registry is — and what it is not](#1-what-hara-registry-is--and-what-it-is-not)
2. [The problems it solves, and why a blockchain](#2-the-problems-it-solves-and-why-a-blockchain)
3. [Core features and services, in plain terms](#3-core-features-and-services-in-plain-terms)
4. [How each stakeholder uses it](#4-how-each-stakeholder-uses-it)
5. [How a consumer verifies a product](#5-how-a-consumer-verifies-a-product)
6. [How a partner or company onboards](#6-how-a-partner-or-company-onboards)
7. [Standards and compliance](#7-standards-and-compliance)
8. [Operational characteristics](#8-operational-characteristics)
9. [Privacy by design](#9-privacy-by-design)
10. [Where to go next](#10-where-to-go-next)
11. [Glossary](#11-glossary)
12. [Frequently asked questions](#12-frequently-asked-questions)

---

## 1. What Hara Registry is — and what it is not

**Hara Registry is a shared trust layer.** It is a secure, permissioned blockchain operated by HARA on which trusted organisations record facts that other organisations — and the public — can independently verify. Think of it the way you think of GS1 barcodes or the internet's DNS: shared infrastructure that many competing parties rely on, without any one of them having to be trusted as the sole record-keeper.

It was built for two Indonesian-specific jobs:

1. **Halal certification** — making BPJPH / LPH / MUI halal records verifiable by anyone, anywhere, by scanning a QR code, with cryptographic proof that the record is genuine, current, and unaltered.
2. **Palm-oil traceability** — recording the journey of every batch of sustainable palm oil, from plantation to finished product, in a way that satisfies RSPO mass-balance accounting and EU due-diligence rules.

On top of that it adds a third capability that almost no other system has today: **post-quantum audit anchoring** — a way of sealing records so they remain provable even decades from now, when today's encryption may be breakable by quantum computers.

### What it is NOT

| It is NOT… | Because… |
|---|---|
| **A cryptocurrency** | The native unit ("HARA") exists only for internal accounting. It is never bought, sold, or traded, and has no market price. |
| **A system with fees** | Recording a fact costs the participant **nothing**. The transaction price (gas) is permanently set to **zero**. |
| **A speculation or investment vehicle** | There is no mining, no trading, no token sale, no yield. Nobody profits from price movement because there is no price. |
| **A public free-for-all** | It is *permissioned*: only approved organisations can write records. Anyone, however, can *read* and verify them. |
| **A replacement for the certifier** | BPJPH, LPH, MUI and RSPO remain the authorities. The registry only makes their decisions verifiable and tamper-evident. |

The registry is **infrastructure**, operated by HARA as the platform provider, with the certification bodies and supply-chain companies as its users.

---

## 2. The problems it solves, and why a blockchain

### 2.1 Halal certification today

A halal certificate today is a paper document or a PDF. To check it, a buyer must either trust that the issuer's database is online and honest, or telephone the certifying body. Counterfeits circulate freely. International buyers — in Saudi Arabia, the UAE, Malaysia, Singapore — routinely reject Indonesian halal certificates because they cannot verify them at scale.

**The registry's answer:** the existence and current status of each certificate is recorded on a shared, tamper-evident ledger. A buyer or consumer checks the status (active / expired / revoked) directly, with no central database to be offline, hacked, or doubted, and with cryptographic proof of who issued it.

### 2.2 Palm-oil traceability today

RSPO (the Roundtable on Sustainable Palm Oil) requires **mass-balance** accounting: at every step of the supply chain, the volume of certified-sustainable oil flowing *in* must match the volume flowing *out*. Today this is tracked in spreadsheets spread across dozens of mills, refineries, traders, and manufacturers. Reconciliation is slow, fraud is structural, and audits happen long after the fact.

**The registry's answer:** every transfer of certified palm oil is recorded on-chain as a movement of a digital batch token, where **1 token = 1 litre**. You cannot move more litres than you actually hold, so mass-balance is enforced automatically. Every batch can be traced from a refinery's output all the way back to the plantation it came from.

### 2.3 Why a blockchain rather than an ordinary database

A normal database would be cheaper to build. Three things specific to this domain make a shared ledger the right choice:

1. **No single party can be *the* source of truth.** BPJPH issues certificates, LPH inspects, MUI rules on doctrine, RSPO sets sustainability rules, exporters and buyers verify. Asking any one of them to host the master database raises an unanswerable political question — *whose* database? A shared ledger that each party can audit independently sidesteps the problem entirely.
2. **The audit window is regulatory, not operational.** Halal certificates stay valid for years; a palm-oil batch must remain auditable across a supply chain that spans many months. An ordinary database can be quietly edited. A blockchain's history cannot be rewritten without every participant noticing.
3. **Quantum-readiness over a 10-year-plus horizon.** A record created today must still be verifiable in 2035 and beyond. The digital signatures that protect data today could be broken by a future quantum computer. The registry seals every audit record with an additional **post-quantum signature**, so historical records stay provable even if today's classical cryptography is one day defeated.

---

## 3. Core features and services, in plain terms

### 3.1 The chain (the shared ledger)

At the centre is a permissioned blockchain run by four independent **validators** (the computers that agree on what gets recorded). They produce a new "page" of the ledger roughly **every 2 seconds**, and once a record is written it is **final immediately** — there is no waiting and no chance of it being reversed. The network keeps working correctly even if one validator fails.

Because it is permissioned and fee-free, recording a fact is **instant and free** for the participating organisation.

### 3.2 The HaraPalmOil batch token (1 token = 1 litre)

Sustainable palm oil is represented on-chain by the **HaraPalmOil** token. Each *batch* of oil gets its own token type, and **one token equals one litre**. When a plantation's batch is first created ("minted"), the record captures the **RSPO certificate** it was produced under, the **plantation of origin**, and the **production date**. From then on, every time the oil changes hands, the corresponding litres move from one party to the next — and each move is permanently recorded as a **custody hop**.

### 3.3 Traceability batches and custody chains

A *batch* is a quantity of certified oil with a known origin. Its *custody chain* is the ordered list of everyone who has held it — plantation → mill → refinery → trader → exporter, and so on. Because every hop is recorded with volumes, you can always answer: *Where did this oil come from? Who handled it? How much went each way? When?*

### 3.4 The TraceabilityBatchRelay — "one envelope with the whole itinerary"

Moving a batch through many hands, one transfer at a time, is slow and can go wrong if transfers arrive out of order. The **TraceabilityBatchRelay** solves this with a simple idea: instead of mailing a parcel hop by hop, you put **the entire itinerary into one envelope** and hand it over once. The relay then walks the batch through every holder on the list — plantation to final custodian — in a single, all-or-nothing step. Either the whole journey is recorded correctly, or none of it is. It also supports splits and merges (one batch divided among several buyers, or several streams combined), which is exactly how real palm-oil logistics work.

### 3.5 The explorer (Blockscout)

The **explorer** at **https://explorer.ledger.haratrust.io/** is a public website where anyone can browse the ledger — every block, every transaction, every batch token — with no login. It is the registry's equivalent of a public records office: open for inspection by buyers, auditors, journalists, and regulators alike.

### 3.6 The traceability viewer (the custody DAG)

The **traceability viewer** at **https://trace.ledger.haratrust.io/** draws a batch's journey as a picture — a flow diagram of who passed oil to whom. Colours make it readable at a glance: **green** is the plantation/origin, **blue** is a holder who passed everything on, and **red** is the current holder. (A DAG — "directed acyclic graph" — is simply the technical name for a flow diagram that can branch and merge but never loops back on itself.) Access is protected by a login; request credentials from HARA operations.

### 3.7 Post-quantum anchoring (in plain terms)

Periodically, the registry takes a fingerprint ("hash") of a range of records and seals it with two signatures: today's standard one **and** a **post-quantum** one (a NIST-approved scheme called ML-DSA-65). This guards against a threat known as **"harvest now, decrypt later"**: an adversary could copy today's data now and wait for a future quantum computer powerful enough to forge today's signatures. By committing a quantum-resistant signature *today*, the registry ensures that records sealed now can still be proven authentic in the future — even if classical signatures are eventually broken. The small fingerprint goes on-chain; the full signature is stored securely off-chain.

### 3.8 The Strata operations console

**Strata** (**https://console.platform.haratrust.io/**) is the staff-facing control panel HARA uses to operate the platform — managing user accounts and roles, watching the chain's health, and overseeing backups, snapshots, replication, failover, and recovery drills. It is an operations tool, not a public site, but it is what lets HARA give partners confidence that the platform is professionally run.

---

## 4. How each stakeholder uses it

| Stakeholder | What you do | What you see |
|---|---|---|
| **BPJPH** (halal authority) | Record certificate issuance and revocation; have these reflected on a tamper-evident shared ledger | A permanent issuance log; instant, network-wide revocation; a verification portal for international auditors |
| **LPH** (inspection bodies) | Record inspection outcomes that feed certification | Auditable inspection records that no single party can quietly alter; shared governance so no one LPH controls the registry |
| **MUI** (religious authority) | Attach cryptographic proof that a certificate carries an MUI fatwa | Attestation of doctrinal approval; selective disclosure for sensitive ingredient details |
| **RSPO members** — plantations, mills, refiners, traders, exporters | Create batches at origin and record each custody transfer (usually via the relay) | Automatic mass-balance accounting; a complete, provable chain-of-custody ready for export auditors |
| **Exporters** | Pull a batch's full origin-to-port history | Documentary proof of due diligence and traceability for EU CSDDD / EUDR and importer requirements |
| **International buyers** | Verify a supplier's halal status and a batch's RSPO origin before purchase | Independent confirmation without relying on the seller's word or a single database |
| **End consumers** | Scan the QR code on a product | Halal status, plantation of origin, RSPO certificate fingerprint, and timestamps (see §5) |
| **Regulators** | Inspect the public ledger and explorer at any time | An always-available, tamper-evident audit trail rather than after-the-fact spot checks |
| **Integration partners** | Connect their systems to read and write records via the APIs and SDK code | Programmatic access to everything above (see §10 and the Integration Manual) |

---

## 5. How a consumer verifies a product

For a shopper or buyer, verification is meant to be effortless:

1. **Scan the QR code** printed on the product or its certificate.
2. The verifier opens and reads the matching record directly from the registry.
3. **You see, in plain language:**

| What you see | What it means |
|---|---|
| **Halal status** | Whether the certificate is **active**, **expired**, or **revoked** — read live from the ledger, not from a cached PDF |
| **Plantation of origin** | The plantation the underlying palm oil came from |
| **RSPO certificate fingerprint** | A unique fingerprint of the sustainability certificate, so it can be checked against RSPO's own records |
| **Timestamps** | When the batch was produced, when it was first recorded, and when it last changed hands |
| **Custody trail** (optional) | A link into the traceability viewer to see the full journey from plantation to product |

Because the verifier reads from a shared, tamper-evident ledger, the answer cannot be faked by a dishonest seller, and it does not break if any single company's website is down.

---

## 6. How a partner or company onboards

Onboarding is designed to be light. At a high level:

1. **Request an account.** Contact HARA operations at **ops@haratrust.io** to be approved as a participant. You'll agree on which roles you need (for example, minting batches, or simply reading data).
2. **Receive your deployer key.** HARA operations issues your organisation a secure signing key (a "deployer key") that identifies you on the registry. This is what authorises your records.
3. **Get your account funded.** A new account must be activated with a tiny one-time top-up before its first record (a technical formality — there are still **no fees**). HARA operations does this for you.
4. **Start recording custody.** Using the SDKs and the [Integration Manual](../guides/hara-registry-integration-manual.md), your systems begin creating batches and recording custody hops — typically by handing the relay the full itinerary for each shipment (see §3.4).
5. **Verify and reconcile.** Use the explorer, the traceability viewer, and the traceability API to confirm your records and reconcile mass-balance.

Most partners are productive within days, because the registry speaks the same language as standard Ethereum tooling — your engineers do not have to learn a bespoke platform.

---

## 7. Standards and compliance

The registry is built to satisfy the rules its users actually face:

| Standard / regulation | What it covers | How the registry helps |
|---|---|---|
| **RSPO chain-of-custody** | Mass-balance accounting for sustainable palm oil | Volumes are tracked per litre; you cannot transfer more than you hold, so mass-balance is mechanically enforced |
| **BPJPH halal certification** | Indonesian halal assurance | Tamper-evident issuance and revocation records, verifiable by anyone |
| **EU CSDDD** (Corporate Sustainability Due Diligence Directive) | Supply-chain due diligence for goods sold in the EU | Provable, end-to-end custody history as documentary evidence |
| **EU EUDR** (Deforestation Regulation) | Proof that commodities are deforestation-free and traceable to origin | Batch-level traceability back to a named plantation with timestamps |
| **UU PDP** (Indonesian Personal Data Protection law) | Handling of personal data | Privacy-by-design: only fingerprints go on-chain; sensitive data stays off-chain with selective disclosure (see §9) |
| **ISO 27001 / SOC 2** | Information-security management | On the roadmap; required for acceptance in export markets (Saudi, UAE, Singapore) |
| **NIST FIPS 204 / FIPS 203** | Post-quantum cryptography standards | Audit anchors are sealed with ML-DSA-65 (FIPS 204) today, with FIPS 203 key-exchange on the roadmap |

---

## 8. Operational characteristics

The platform matures in phases. Figures below summarise what to expect; the [Technical Manual](../technical/hara-registry-technical-manual.md) carries the detail.

| Characteristic | Today (early phase) | Pilot phase | National phase |
|---|---|---|---|
| **Uptime target** | Best-effort, fast recovery from backups | 99.5% monthly (~3.5 hrs downtime/month) | 99.9% monthly (~43 min downtime/month) |
| **Throughput** | ~50 transactions/sec sustained, ~500/sec burst (measured ~322 TPS under stress tests) | ~200 transactions/sec sustained | ~1,000 transactions/sec sustained |
| **Recovery objective (data loss)** | Restore from frequent backups | RPO ~24 hours | Near-real-time replication |
| **Recovery objective (time to restore)** | Operator-led restore | RTO ~4 hours | Multi-region, minimal interruption |
| **Resilience** | Backups proven retrievable off-site (weekly read-back drills); tolerates one validator failure | + announced maintenance windows | + multi-region active-active, 24/7 on-call |

The platform runs entirely on **Indonesian sovereign cloud infrastructure** (Nevacloud), keeping data within Indonesia — an important property for both regulators and national-interest considerations.

---

## 9. Privacy by design

The registry is deliberately built so that **sensitive information never lands on the public ledger**. Three principles make this work:

1. **Hash-only on-chain.** Instead of storing a certificate, a contract, or personal details, the registry stores only a **fingerprint** (a hash) of it. A fingerprint proves a document exists and hasn't changed, but reveals nothing about its contents to anyone who doesn't already hold the document.
2. **Off-chain blobs.** The actual documents — certificates, lab reports, RSPO paperwork — live in secure off-chain storage controlled by the data owner, not on the shared ledger. The ledger only points to and fingerprints them.
3. **Selective disclosure.** A party can prove a specific fact (for example, "this product is halal-certified" or "this batch is RSPO-certified") **without** revealing everything else. Sensitive ingredient or commercial details are shared only with those entitled to see them.

The result: the public can verify the *claims* that matter, while confidential business and personal data stays private — consistent with Indonesia's UU PDP and with commercial confidentiality.

---

## 10. Where to go next

| Resource | Link | For |
|---|---|---|
| **Technical Manual** | [`doc/technical/hara-registry-technical-manual.md`](../technical/hara-registry-technical-manual.md) | Developers and auditors who want depth |
| **Integration Manual** | [`doc/guides/hara-registry-integration-manual.md`](../guides/hara-registry-integration-manual.md) | Engineers connecting a system, with TypeScript/SDK code |
| **Public block explorer** | https://explorer.ledger.haratrust.io/ | Browsing the ledger, blocks, transactions, and the batch token |
| **Traceability viewer + API** | https://trace.ledger.haratrust.io/ | Visual custody trails and the `/v1/*` REST API (login required) |
| **JSON-RPC endpoints** | reads `https://rpc.ledger.haratrust.io/read/` · writes `https://rpc.ledger.haratrust.io/write/` · subscriptions `https://rpc.ledger.haratrust.io/ws` | Programmatic chain access |
| **Strata operations console** | https://console.platform.haratrust.io/ | HARA operations staff |
| **Operations contact** | ops@haratrust.io | Accounts, credentials, deployer keys, support |

**Key on-chain addresses** (chain ID **131216**) for partners who need them:

| Contract | Address | Role |
|---|---|---|
| HaraPalmOil (batch token, 1 token = 1 litre) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | The palm-oil batch token; each transfer is a custody hop |
| TraceabilityBatchRelay | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | Executes a whole custody itinerary in one step |
| PQAnchorRegistry | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | Post-quantum (ML-DSA-65) audit anchors |
| ContractRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | Name-to-address directory of platform contracts |
| GovernanceContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | Role-gated platform governance |
| AnchorRegistry (legacy) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | Legacy classical-only anchoring (compatibility) |

SDK code and worked examples (TypeScript and more) ship with the [Integration Manual](../guides/hara-registry-integration-manual.md).

### Companion products (built on the same trust layer)

- **hara-did** — `did:hara` decentralised identity for issuers (BPJPH/LPH/MUI) and certified businesses.
- **hara-halal-passport** — the consumer-facing halal certificate as a non-transferable ("soulbound") NFT, with a scan-to-verify app.
- **hara-xchange** — a market layer for tokenised palm-oil and carbon credits.

---

## 11. Glossary

| Term | Plain-language meaning |
|---|---|
| **Anchor** | A fingerprint of a range of records, sealed and recorded on-chain so the records can be proven authentic later |
| **Batch** | A quantity of certified palm oil with a known origin; on-chain it is one token type where 1 token = 1 litre |
| **Blockchain / chain** | A shared, tamper-evident ledger that many parties keep in agreement without trusting one another |
| **Blockscout** | The public explorer website for browsing the ledger |
| **BPJPH** | Indonesia's halal certification authority |
| **Custody hop** | One transfer of a batch from one holder to the next |
| **DAG** | "Directed acyclic graph" — a flow diagram that can branch and merge but never loops back; used to draw custody trails |
| **Deployer key** | The secure signing key HARA issues to a partner to authorise its records |
| **ERC-1155** | The token standard behind HaraPalmOil; one contract holds many batch types |
| **ERC-721 soulbound** | A non-transferable digital certificate; the form the halal passport takes |
| **Finality** | The property that once a record is written, it is permanent and cannot be reversed |
| **Gas** | The usual cost of recording on a blockchain — here permanently set to **zero** |
| **Harvest now, decrypt later** | The threat of an adversary storing today's data to break its encryption with a future quantum computer |
| **LPH** | Indonesian halal inspection body |
| **Mass balance** | RSPO accounting where certified volume in must equal certified volume out at each step |
| **ML-DSA-65** | The NIST FIPS 204 post-quantum signature scheme the registry uses for anchoring |
| **MUI** | Indonesian Council of Ulama, the religious authority issuing halal fatwas |
| **Permissioned** | Only approved organisations may write; anyone may read and verify |
| **Post-quantum (PQ)** | Cryptography designed to stay secure even against future quantum computers |
| **QBFT** | The agreement method the validators use to stay in sync (instant finality) |
| **Relay** | The TraceabilityBatchRelay — moves a batch through its whole itinerary in one step |
| **RSPO** | Roundtable on Sustainable Palm Oil, the international sustainability certifier |
| **Selective disclosure** | Proving one specific fact without revealing everything else |
| **Strata** | HARA's internal operations console |
| **Validator** | One of the computers that agree on what the ledger records |

---

## 12. Frequently asked questions

**Is Hara Registry a cryptocurrency? Can I invest in it?**
No. There is no coin to buy, no trading, no price, and no investment. The internal unit exists only for technical accounting and is never bought or sold.

**Does it cost money to record or verify a record?**
No. Recording is free for participants (transaction fees are permanently set to zero), and reading or verifying records on the explorer is free and open to anyone.

**Who can write to the registry?**
Only organisations that HARA has approved and given a role to — for example BPJPH, LPH, MUI, and RSPO member companies. Everyone else can read and verify, but not write.

**Can records be deleted or changed after the fact?**
No. The ledger is tamper-evident: history cannot be quietly rewritten. Status changes (such as a revoked certificate) are added as new records, so the full sequence stays visible and auditable.

**Is my confidential business data exposed on a public ledger?**
No. Only fingerprints (hashes) go on-chain. Your actual documents stay in off-chain storage you control, and you can prove specific facts without revealing the rest (see §9).

**What does "post-quantum" mean for me as a buyer or regulator?**
It means a record sealed today can still be proven authentic many years from now, even if a future quantum computer can break today's ordinary digital signatures. Your long-lived certificates and audit trails are future-proofed.

**Is the data stored in Indonesia?**
Yes. The platform runs on Indonesian sovereign cloud infrastructure (Nevacloud), keeping data within national borders.

**How do I verify a product as a consumer?**
Scan the QR code. You'll see the halal status, the plantation of origin, the RSPO certificate fingerprint, and the relevant timestamps — read live from the shared ledger (see §5).

**How does my company join?**
Contact HARA operations at **ops@haratrust.io** to be approved, receive a deployer key, get your account activated, and start recording custody (see §6).

**How is this different from a normal database?**
A database has a single owner who could change it, and asking competing bodies to share one raises the question of *whose* database. A shared ledger is independently auditable by every party, cannot be quietly rewritten, and is built to stay verifiable across a multi-year regulatory window — and, uniquely, into the quantum era (see §2.3).

**Where do developers find APIs and example code?**
In the [Integration Manual](../guides/hara-registry-integration-manual.md) and the [Technical Manual](../technical/hara-registry-technical-manual.md), plus the public explorer and traceability API listed in §10.

---

*For accounts, credentials, deployer keys, or partnership questions, contact HARA operations at **ops@haratrust.io**.*
