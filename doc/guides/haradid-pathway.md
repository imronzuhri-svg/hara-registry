# HaraDID Development Pathway
## Hybrid DID Architecture — Issuer DIDs On-Chain, Holder DIDs via Sidetree

This document is the dedicated development pathway for **HaraDID**, the decentralized identity layer of the HaraLedger ecosystem.

It is a companion to `haraledger_ecosystem_development_blueprint.md` and supersedes section 4.2 (DID Registry Contract) of that document.

---

# 1. Design Philosophy

HaraDID must support two very different populations:

| Population | Count | Examples | Trust Model |
|---|---:|---|---|
| **Issuer DIDs** | ~10,000 | BPJPH, LPH, MUI, exporters, importers, manufacturers, auditors | Regulated, accountable, public |
| **Holder DIDs** | Billions | Individual consumers, products, batches, devices | Pseudonymous, privacy-sensitive, high volume |

Treating both populations the same way is the mistake most blockchain DID projects make.

HaraDID uses a **hybrid pattern** modeled after EBSI (EU) and DIF Sidetree:

- **Issuer DIDs** are first-class on-chain entities with individual records, governance, and revocation.
- **Holder DIDs** are batched via the **Sidetree protocol** anchored to HaraLedger, with full DID operations stored off-chain.

This gives regulators what they need (clear on-chain identity for accountable parties) while keeping consumer-side scale economically viable.

---

# 2. Architectural Overview

```text
                ┌─────────────────────────────────────────┐
                │             HaraDID Resolver API         │
                │   resolve(did) → DID Document + Proofs   │
                └────────────────┬────────────────────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            │                                         │
            ▼                                         ▼
┌─────────────────────────┐            ┌──────────────────────────┐
│  IssuerRegistry.sol      │            │  Sidetree Resolver        │
│  (HaraLedger)            │            │  - reads anchor file       │
│  - one row per issuer    │            │  - fetches CAS batch       │
│  - role + accreditation  │            │  - replays DID ops         │
│  - revocation status     │            │  - returns DID doc         │
└─────────────────────────┘            └────────────┬─────────────┘
            ▲                                       │
            │                                       ▼
            │                          ┌──────────────────────────┐
            │                          │  Content-Addressed Store   │
            │                          │  (CAS)                     │
            │                          │  - MinIO + Postgres index  │
            │                          │  - holds batch files       │
            │                          └────────────┬─────────────┘
            │                                       │
            │                                       ▼
            │                          ┌──────────────────────────┐
            │                          │  SidetreeAnchor.sol        │
            │                          │  (HaraLedger)              │
            │                          │  - anchor txs (one per     │
            │                          │     batch of ~10k ops)     │
            │                          └──────────────────────────┘
            │                                       ▲
            │                                       │
            └──────────── governance ───────────────┘
                          (validators, admin)
```

**Key invariant:** The chain's storage cost is **flat per batch**, not per DID. One on-chain transaction can anchor 10,000+ holder DID operations.

---

# 3. DID Method Specification

## 3.1 Method Name

`did:hara`

## 3.2 Method-Specific Identifier Structure

### Issuer DIDs (on-chain)

```
did:hara:iss:<chain-id>:<issuer-id>
```

- `iss` = subtype marker for issuer
- `chain-id` = HaraLedger network identifier (e.g., `mainnet`, `testnet`)
- `issuer-id` = bytes32 hex, registered in `IssuerRegistry.sol`

Example:
```
did:hara:iss:mainnet:0x4a7c...e21f
```

### Holder DIDs (Sidetree)

```
did:hara:<sidetree-suffix>
```

- Long-form (before anchoring): `did:hara:<short>:<initialState>`
- Short-form (after anchoring): `did:hara:<suffix>`

Suffix derivation follows the **DIF Sidetree v1.0 specification**: SHA-256 of canonicalized create operation.

Example:
```
did:hara:EiClkZMDxPKqC9c-umQfTkR8vvZ9JPhl_xLDI9Nfk38w5w
```

## 3.3 Operations

Both subtypes support the standard W3C DID lifecycle:

| Operation | Issuer DID | Holder DID |
|---|---|---|
| Create | On-chain `registerIssuer()` | Sidetree create op, batched |
| Update | On-chain `updateIssuer()` | Sidetree update op, batched |
| Recover | On-chain admin recovery | Sidetree recover op (separate recovery key) |
| Deactivate | On-chain `deactivateIssuer()` | Sidetree deactivate op, batched |
| Resolve | Direct contract call | Resolver replays batches from anchor → CAS |

---

# 4. On-Chain Components

## 4.1 IssuerRegistry.sol

Holds the canonical record for every regulated issuer.

```solidity
contract IssuerRegistry {
    enum IssuerRole { BPJPH, LPH, MUI, Exporter, Importer, Manufacturer, Auditor, Other }
    enum Status     { Active, Suspended, Revoked }

    struct Issuer {
        bytes32     publicKeyHash;       // hash of current signing key
        bytes32     serviceEndpointHash; // hash of off-chain endpoint doc
        bytes32     accreditationHash;   // hash of accreditation document
        IssuerRole  role;
        Status      status;
        uint64      registeredAt;
        uint64      updatedAt;
        address     controller;          // wallet that may update
    }

    mapping(bytes32 => Issuer) public issuers; // issuerId => Issuer

    event IssuerRegistered(bytes32 indexed issuerId, IssuerRole role, address controller);
    event IssuerUpdated(bytes32 indexed issuerId, bytes32 publicKeyHash);
    event IssuerStatusChanged(bytes32 indexed issuerId, Status newStatus);
    event IssuerKeyRotated(bytes32 indexed issuerId, bytes32 oldKeyHash, bytes32 newKeyHash);
}
```

**Rules**
- Only `GOVERNANCE_ROLE` may call `registerIssuer()`.
- Only the issuer's `controller` (or `GOVERNANCE_ROLE` in recovery) may call `updateIssuer()`.
- Status changes (suspend/revoke) require `GOVERNANCE_ROLE`.
- Full DID document is **served off-chain** at `serviceEndpoint`; chain holds the hash.

**Why not store the DID document?**
Even for 10,000 issuers, on-chain JSON-LD storage is wasteful. Off-chain serving with on-chain hash gives the same trust guarantee at <5% of the cost.

## 4.2 SidetreeAnchor.sol

Anchors holder-DID operation batches.

```solidity
contract SidetreeAnchor {
    struct Anchor {
        bytes32 anchorFileHash;  // CAS pointer to anchor file
        uint32  operationCount;  // number of DID ops in this batch
        uint64  timestamp;
    }

    mapping(uint256 => Anchor) public anchors; // anchorId => Anchor
    uint256 public latestAnchorId;

    event BatchAnchored(uint256 indexed anchorId, bytes32 anchorFileHash, uint32 operationCount);
}
```

**Rules**
- Only the `BATCHER_ROLE` (operated by the Sidetree batcher service) may anchor.
- One anchor = one batch of up to ~10,000 holder DID operations.
- Anchor file format follows the DIF Sidetree v1.0 spec (anchor file → map file → chunk file).

## 4.3 RevocationRegistry.sol

Unified revocation across both issuer DIDs and credentials they issue.

```solidity
contract RevocationRegistry {
    // For credentials issued by any DID (issuer or holder)
    struct StatusList {
        bytes32 listRoot;    // Merkle root or StatusList2021 bitstring hash
        uint64  size;
        uint64  updatedAt;
    }

    mapping(bytes32 => StatusList) public lists; // listId => StatusList

    event StatusListUpdated(bytes32 indexed listId, bytes32 listRoot, uint64 size);
}
```

Uses the **W3C StatusList2021** standard so revocation is privacy-preserving and verifiable without revealing population size or individual lookups.

---

# 5. Off-Chain Components

## 5.1 Sidetree Batcher Service

Long-running worker that:
1. Receives DID operations from the HaraDID API (create/update/recover/deactivate).
2. Validates op signatures and Sidetree protocol rules.
3. Buffers ops until batch is full **or** flush timer expires.
4. Builds the three Sidetree files:
   - **Chunk file** — opaque op payloads
   - **Map file** — references chunk file, lists ops
   - **Anchor file** — references map file, lists DID suffixes
5. Pushes all three to CAS (MinIO + Postgres index).
6. Calls `SidetreeAnchor.anchor(anchorFileHash, opCount)` on HaraLedger.

**Batching parameters (Phase 2 starting values)**
- Max batch size: 10,000 ops
- Max batch wait: 10 minutes
- Max anchor file size: 1 MB
- Max chunk file size: 20 MB

These match DIF Sidetree v1.0 defaults; tune in production based on real throughput.

## 5.2 Content-Addressed Store (CAS)

Sidetree assumes an IPFS-like CAS. HaraDID uses a **simplified internal CAS**:

```text
MinIO bucket: hara-cas
  /sha256/<first2>/<hash> → binary blob

PostgreSQL table: cas_index
  hash CHAR(64) PRIMARY KEY
  size BIGINT
  content_type VARCHAR
  created_at TIMESTAMPTZ
  pinned BOOLEAN
```

**Why not real IPFS?**
- IPFS adds operational complexity (DHT, gateway, peer mgmt).
- Trust model is already permissioned — public DHT gains nothing.
- MinIO + Postgres gives content-addressed semantics with backup/DR we already operate.
- Migration to IPFS later is trivial because Sidetree only needs `get(hash) → blob`.

**Replication**
- Primary CAS on Nevacloud.
- Mirror to Huawei object storage (per blueprint section 8).
- Validators MAY run independent CAS mirrors to remove single-operator trust.

## 5.3 Sidetree Resolver

Stateless service that resolves `did:hara:<suffix>` by replaying ops.

**Flow**
```
resolve(did)
  1. Look up DID suffix in resolver index (Postgres)
  2. Find latest anchor containing ops for this suffix
  3. Fetch anchor file → map file → chunk file from CAS
  4. Replay ops in canonical order
  5. Apply ops to compute current DID document
  6. Return DID document + proof bundle
```

**Caching**
- Resolved DID docs cached in Redis with TTL = 5 minutes.
- Cache invalidated when a new anchor referencing the DID is observed.

**Resolver Index Table**
```text
did_suffix      CHAR(46)  PRIMARY KEY
created_anchor  BIGINT    -- first anchor mentioning it
latest_anchor   BIGINT    -- most recent anchor mentioning it
op_count        INT
status          VARCHAR   -- active, deactivated
last_resolved   TIMESTAMPTZ
```

Built by the indexer as a derived view of `SidetreeAnchor` events + parsed batch contents.

---

# 6. Key Management

## 6.1 Issuer DID Keys

| Phase | Storage |
|---|---|
| Phase 1 | Encrypted env secrets, manual rotation |
| Phase 2 | Hashicorp Vault, role-based access, audit log |
| Phase 3 | HSM (regulated issuers) or Cloud KMS (private issuers) |
| Phase 4 | MPC + multi-sig for high-value issuers (BPJPH, MUI) |

Issuer key rotation is an on-chain operation (`updateIssuer()`) and emits `IssuerKeyRotated`.

## 6.2 Holder DID Keys

Sidetree separates **signing keys**, **update keys**, and **recovery keys**:

- **Signing key** — used by the holder to sign VCs / authenticate.
- **Update key** — rotates with every update op; commits to next update key hash.
- **Recovery key** — separate, used only if update key is lost; rare, more strongly protected.

Phase 1 holder key storage:
- HaraDID mobile/wallet SDK generates keys on device.
- Secure Enclave (iOS) / StrongBox (Android) where available.
- Encrypted cloud backup of recovery key (user-controlled passphrase).

---

# 7. Verifiable Credentials Layer

DIDs alone are not useful — they exist to issue and hold **Verifiable Credentials**.

## 7.1 VC Format

- **W3C Verifiable Credentials Data Model 2.0** (JSON-LD).
- Signed with **BBS+** for selective disclosure where privacy matters (e.g., halal certificate holder is a private individual).
- Signed with **EdDSA (Ed25519)** for public/issuer credentials where no selective disclosure is needed.

## 7.2 Credential Examples

```text
HalalCertificateCredential       (BPJPH/LPH → manufacturer DID)
ProductCredential                (manufacturer DID → product DID)
AuditCredential                  (auditor DID → manufacturer DID)
ExporterAccreditationCredential  (BPJPH → exporter DID)
TraceabilityClaimCredential      (manufacturer DID → batch DID)
```

The on-chain Halal Passport NFT (per blueprint section 4.4) references the credential hash. The full VC lives off-chain; the chain only proves *that this credential was validly issued at this time*.

## 7.3 Revocation

Use **StatusList2021** bitstrings, with the bitstring hash committed to `RevocationRegistry.sol`.

- Each issuer maintains one or more status lists.
- Verifier fetches the bitstring off-chain, verifies hash matches the chain, checks the bit.
- Privacy preserved: verifier never tells the issuer which credential they're checking.

---

# 8. Zero-Knowledge Proof Layer

ZK proofs let a holder prove statements about their credentials **without revealing the credentials themselves**. For HaraDID this is not a nice-to-have — it is the only way to satisfy three hard requirements simultaneously:

1. **Privacy** — consumer verifying a product should not leak the manufacturer's identity to competitors; manufacturer verifying their own cert should not leak it to the verifier's analytics.
2. **Unlinkability** — the same halal cert presented twice should not be correlatable across verifiers.
3. **Public verifiability** — third parties (OIC auditors, importing countries) must be able to verify without trusting HARA's servers.

## 8.1 What ZK Proves in HaraDID

| Statement | Why Useful |
|---|---|
| "I hold a valid halal certificate" | Verifier confirms validity without learning which certificate |
| "My certificate was issued by a currently-accredited LPH" | Set-membership proof against `IssuerRegistry` root; doesn't reveal which LPH |
| "My certificate is not revoked" | Non-membership proof against `RevocationRegistry` root |
| "My product passed audit between dates X and Y" | Range proof over credential claim |
| "This product's full supply chain is halal-certified" | Recursive proof over chain of credentials, leaking only the conclusion |
| "I am over 18" / "I am an Indonesian citizen" | Predicate proofs for consumer-facing flows |

Each proof is a few hundred bytes, verifiable in milliseconds, anchorable on-chain if needed for audit.

## 8.2 Cryptographic Stack

**Two complementary primitives:**

### 8.2.1 BBS+ Signatures — for VC-level selective disclosure

- VCs are signed once by the issuer with a BBS+ key.
- Holder derives presentations that reveal *only chosen attributes*.
- No trusted setup, no circuit compilation, no per-proof cost on issuer side.
- Standard: **W3C VC Data Integrity — BBS Cryptosuite v1.0** (`bbs-2023`).
- Library: `@digitalbazaar/bbs-signatures` or `bbs-signatures-rs`.

**Use BBS+ for:** "show this attribute, hide that attribute" within a single credential.

### 8.2.2 zk-SNARKs — for cross-credential / on-chain-verifiable proofs

- Custom circuits compiled to Groth16 or PLONK.
- Verifier contracts deployed on HaraLedger; proofs verified on-chain when audit trail required.
- Off-chain verification in resolver/verifier APIs for cheap consumer flows.

**Use zk-SNARKs for:** set membership, non-revocation, recursive supply chain proofs, predicate proofs.

**Recommended toolchain:**

| Layer | Choice | Why |
|---|---|---|
| Circuit language | **Circom 2** (primary), **Noir** (evaluation) | Circom has mature Iden3 circuits we can reuse; Noir is more ergonomic for new work |
| Proving system | **Groth16** for fixed circuits, **PLONK** (Halo2) for evolving ones | Groth16: smallest proofs, on-chain verifier ~250k gas; PLONK: no per-circuit trusted setup |
| Verifier contracts | Auto-generated Solidity from snarkjs | Standard pattern, audited templates |
| Wallet prover | WASM build of snarkjs / `arkworks-rs` via wasm-pack | Runs in mobile wallet, ~1–5 s proof generation |

**Reuse, don't reinvent.** The **Iden3 / Polygon ID circuit library** already provides battle-tested circuits for:
- Credential signature verification
- Issuer set membership (Sparse Merkle Tree)
- Revocation non-membership (SMT)
- Credential expiry / validity window
- Selective disclosure of claims

HaraDID adopts these circuits with HaraLedger-specific anchoring instead of writing them from scratch.

## 8.3 On-Chain ZK Infrastructure

### 8.3.1 Issuer Accreditation Tree

`IssuerRegistry.sol` is extended to maintain a **Sparse Merkle Tree** of `(issuerId → status)` so issuer accreditation is provable in ZK.

```solidity
// addition to IssuerRegistry.sol
bytes32 public issuerStateRoot;  // root of SMT over all issuers
uint64  public issuerStateEpoch;
event IssuerStateRootUpdated(uint64 epoch, bytes32 newRoot);

function publishIssuerStateRoot(bytes32 newRoot) external onlyRole(GOVERNANCE_ROLE) {
    issuerStateRoot = newRoot;
    issuerStateEpoch++;
    emit IssuerStateRootUpdated(issuerStateEpoch, newRoot);
}
```

A ZK proof can now show "issuer X was Active at epoch N" without revealing X.

### 8.3.2 ZK-Friendly Revocation Registry

`RevocationRegistry.sol` adds a parallel **SMT root** alongside the StatusList2021 root, because StatusList2021 bitstrings are not efficient inside SNARKs:

```solidity
struct StatusList {
    bytes32 listRoot;       // StatusList2021 bitstring hash (existing)
    bytes32 smtRoot;        // NEW: Sparse Merkle Tree root for ZK proofs
    uint64  size;
    uint64  updatedAt;
}
```

Verifiers choose: cheap bitstring check for non-private flows, ZK non-membership proof for private flows.

### 8.3.3 Verifier Contracts

For each circuit, a Solidity verifier is deployed:

```text
HalalCertValidityVerifier.sol      → verifies "valid halal cert exists"
IssuerAccreditationVerifier.sol    → verifies "issuer was accredited at time T"
NonRevocationVerifier.sol          → verifies "cert not revoked at epoch N"
SupplyChainProvenanceVerifier.sol  → verifies recursive chain-of-credentials proof
```

These are auto-generated from circuits and gated behind a `ZKVerifierRouter.sol` that maps a circuit ID to its verifier contract — so circuits can be upgraded without breaking integrations.

## 8.4 Off-Chain ZK Components

### 8.4.1 Wallet Prover (HaraDID Wallet SDK)

Runs entirely on the holder's device:
- Loads circuit + proving key (downloaded once, cached).
- Loads holder's credentials and the relevant Merkle witnesses (fetched via resolver API).
- Generates proof in WASM/native; typical time: 1–5 s on a mid-range phone.
- Hands proof to verifier as a QR code, deep link, or API call.

### 8.4.2 Witness Service

Stateless service that gives holders the Merkle witnesses they need to construct proofs:

```
GET /v1/zk/witness/issuer-accreditation?issuerId=<hash>&epoch=<n>
GET /v1/zk/witness/non-revocation?listId=<hash>&credentialIndex=<i>
```

Holders fetch witnesses but never reveal which witness they use — the witness service sees the query but the verifier never does. Witnesses can also be cached client-side to remove this leakage entirely.

### 8.4.3 Verifier SDK

Drop-in library for verifiers (BPJPH portals, exporter platforms, foreign authorities):

```typescript
const result = await haraVerifier.verifyPresentation(proof, {
  circuit: "halal-cert-validity",
  requiredIssuerAccreditation: true,
  requireNonRevocation: true,
  maxAge: "30d",
});
// result: { valid: true, claims: { ... only disclosed fields ... } }
```

Verifier SDK can run **fully offline** for circuits whose roots are cached — important for ports/customs scenarios with poor connectivity.

## 8.5 Privacy Modes

HaraDID supports three presentation modes per credential type; the holder chooses:

| Mode | Reveals | Use Case |
|---|---|---|
| **Public** | Full VC contents | Public certificate registry lookups |
| **Selective Disclosure (BBS+)** | Chosen attributes only | B2B verification ("show me the product type, hide the manufacturer") |
| **Zero-Knowledge** | Only the truth value of the predicate | Consumer scans QR; sees "verified halal", learns nothing else |

Default for consumer-facing flows: **Zero-Knowledge**. Default for regulator-facing flows: **Public**. Default for B2B: **Selective Disclosure**.

## 8.6 Trusted Setup & Key Ceremony

Groth16 circuits require a per-circuit trusted setup.

- HaraDID runs a **public multi-party ceremony** for each Groth16 circuit, with contributors from BPJPH, MUI, validators, and independent civil-society observers.
- Ceremony artifacts (`.zkey`, transcripts, contribution hashes) published on HaraLedger Anchor Registry.
- PLONK (Halo2) circuits use a single universal setup, eliminating per-circuit ceremonies — preferred for circuits expected to evolve.

## 8.7 Open ZK Research Items

Tracked separately, not blocking D1–D5:

- Recursive proof aggregation (aggregate 1000 holder presentations into one for batch audit).
- On-chain verifier gas optimization (PLONK verifier currently ~350k gas; Groth16 ~250k).
- Post-quantum signature migration path (BBS+ is not PQ-safe; plan a path to lattice-based credentials).

---

# 9. Resolver API

Public REST endpoint:

```
GET /v1/identifiers/{did}
```

Returns:
```json
{
  "didDocument": { ... W3C DID Document ... },
  "didDocumentMetadata": {
    "created": "2026-05-12T10:00:00Z",
    "updated": "2026-05-12T10:00:00Z",
    "deactivated": false,
    "method": "hara",
    "subtype": "holder" | "issuer"
  },
  "didResolutionMetadata": {
    "contentType": "application/did+ld+json",
    "anchorId": 4827,
    "anchorTxHash": "0x...",
    "anchorChain": "haraledger-mainnet"
  }
}
```

Implements **DIF Universal Resolver** driver interface so external verifiers can resolve `did:hara` via standard tooling.

---

# 10. Development Roadmap

## Stage D1 — Issuer DID MVP (Weeks 1–6)

- `IssuerRegistry.sol` deployed on Besu QBFT dev chain.
- HaraDID Issuer Portal (web UI for BPJPH/LPH/MUI to onboard).
- Off-chain DID document service + hash anchor.
- Universal Resolver driver for `did:hara:iss:*`.
- Unit + integration tests, ~50 test issuers.

**Exit criteria:** Can register, update, rotate keys, resolve issuer DIDs end-to-end.

## Stage D2 — Holder DID MVP via Sidetree (Weeks 7–14)

- `SidetreeAnchor.sol` deployed.
- Sidetree batcher service (TypeScript or Go).
- CAS layer (MinIO + Postgres).
- Sidetree resolver service.
- HaraDID Wallet SDK (mobile + web) for create/update/recover.
- Load test: 100,000 holder DIDs, single batcher.

**Exit criteria:** Single batch anchors 10,000 DIDs; resolution <500 ms p95.

## Stage D3 — Verifiable Credentials (Weeks 15–20)

- VC issuance API for issuers.
- VC verification API for verifiers (with optional QR code flow).
- BBS+ and EdDSA signing libraries integrated.
- `RevocationRegistry.sol` with StatusList2021 lists.
- HaraDID Wallet shows credentials, supports presentation.

**Exit criteria:** End-to-end flow: BPJPH issues halal cert as VC → manufacturer holds → verifier checks → revocation works.

## Stage D4 — Halal Passport Integration (Weeks 21–26)

- `HalalPassport.sol` (ERC-721 + ERC-5192) integrated with HaraDID.
- Minting a passport NFT requires a valid VC from a BPJPH/LPH issuer DID.
- Burning a passport triggers credential revocation.
- Public verification API resolves NFT → certificate VC → issuer DID → chain trust.

**Exit criteria:** Halal Passport works only through verified HaraDID issuance flow.

## Stage D5 — Scale Hardening (Weeks 27–36)

- Multi-batcher coordination (leader election, sharding).
- CAS replication to Huawei + per-validator mirrors.
- Resolver horizontal scaling, Redis cluster.
- ClickHouse analytics on DID operation history.
- Load test: 10 million holder DIDs, 100 ops/sec sustained.

**Exit criteria:** Sustained 100 ops/sec, no anchor lag >2 minutes, resolution <300 ms p95 at 10M DIDs.

## Stage D6 — Zero-Knowledge Proof Layer (Weeks 37–48)

Implements the ZK design in §8.

**D6.1 BBS+ selective disclosure (Weeks 37–40)**
- Integrate BBS+ signing in issuer service (`bbs-2023` cryptosuite).
- HaraDID Wallet derives selective-disclosure presentations.
- Verifier SDK validates BBS+ presentations offline.

**D6.2 Anchored SMT roots (Weeks 39–41)**
- Extend `IssuerRegistry.sol` with `issuerStateRoot` + epoch publishing.
- Extend `RevocationRegistry.sol` with `smtRoot`.
- Indexer maintains SMT off-chain, publishes root on each epoch.
- Witness service endpoint live.

**D6.3 SNARK circuits via Iden3 toolchain (Weeks 41–45)**
- Adapt Iden3 circuits: issuer accreditation, non-revocation, credential validity.
- Trusted setup ceremony for each Groth16 circuit (public, multi-party).
- Deploy auto-generated verifier contracts + `ZKVerifierRouter.sol`.
- Wallet prover (WASM build) integrated, target 1–5 s proof time on mid-range Android.

**D6.4 Privacy modes in clients (Weeks 44–47)**
- Three presentation modes (Public / Selective Disclosure / Zero-Knowledge) selectable per credential type.
- QR-code presentation format defined; verifier SDK accepts all three.
- Consumer scan flow defaults to ZK mode.

**D6.5 Audit & PLONK evaluation (Weeks 46–48)**
- External audit of circuits, verifier contracts, and ceremony artifacts.
- Spike: PLONK (Halo2) port of one circuit for comparison; decide on long-term proving system.

**Exit criteria:**
- Consumer can scan halal product QR, get "verified halal" answer, with cryptographic proof, leaking nothing else.
- Proof verifies offline in verifier SDK in <50 ms.
- Independent audit report published, no critical findings open.

## Stage D7 — Governance & Federation (Weeks 49–56)

- Multi-controller issuer DIDs (n-of-m signing).
- Issuer-level governance via `GovernanceContract`.
- Federation hooks for international halal authorities (OIC member states).
- Cross-chain resolver bridge (read `did:hara` from Avalanche / Polygon CDK post-migration).

## Stage D8 — Migration Rehearsal (Weeks 57–64)

- Re-deploy `IssuerRegistry`, `SidetreeAnchor`, `RevocationRegistry` on Avalanche Subnet staging.
- Replay anchor history to populate new chain's resolver index.
- Dual-resolver mode: clients query both chains during cutover.
- Final cutover plan, archive Besu network read-only.

---

# 11. Migration Constraints (Besu → Avalanche / Polygon CDK)

Same portability rules as the ecosystem blueprint, with DID-specific additions:

1. **No `block.number` in DID logic.** Use timestamps.
2. **All Sidetree state reconstructable from events.** Anchor events must contain enough info to rebuild the resolver index from block 0.
3. **CAS is chain-independent.** MinIO contents survive chain migration unchanged.
4. **Sidetree protocol version pinned per anchor.** Allows mixed-version replay during upgrades.
5. **Issuer DIDs use stable `issuerId` (bytes32), not contract address.** So issuer identity survives contract redeployment.
6. **Resolver caches `chainId` alongside anchor refs.** Multi-chain resolution works during migration window.

---

# 12. Comparison to Alternatives Considered

| Approach | Why Not Chosen |
|---|---|
| One DID per row on-chain (Sovrin, KILT, Parameta MyID) | Doesn't scale to billions; linear state growth |
| Pure Sidetree for all DIDs incl. issuers | Loses the "regulated issuer is a first-class on-chain entity" property regulators want |
| did:web for issuers | No blockchain trust anchor; weak against DNS attacks |
| did:ethr (event replay) for holders | Resolution gets expensive at scale; no native batching |
| cheqd-style commercial DID writes | Wrong economic model for a national/OIC trust ledger |
| Homegrown Merkle anchoring | Reinventing Sidetree poorly; no spec compliance, no ecosystem tooling |
| ZK proofs only (e.g., Semaphore/Sismo style) without VC layer | Loses W3C VC interoperability; verifiers outside HARA can't consume |
| BBS+ only, no SNARKs | Can't do cross-credential proofs (set membership, recursive provenance) |
| AnonCreds (Hyperledger Indy ZK) | Tied to Indy ledger model; doesn't fit hybrid IssuerRegistry+Sidetree architecture |

The hybrid **IssuerRegistry + Sidetree** approach is the only one that satisfies all four requirements simultaneously:
- Regulated issuer visibility on-chain
- Billion-scale holder DIDs
- W3C / DIF standards compliance
- Chain-portability (Besu → Avalanche / CDK)

---

# 13. Open Questions for Decision

Before Stage D1 starts, the team should resolve:

1. **Batcher operator model** — Single HARA-operated batcher (simple), or multi-batcher with leader election (more decentralized)?
2. **CAS trust** — Single MinIO operator, or require each validator to mirror?
3. **Wallet distribution** — Standalone HaraDID Wallet app, or SDK embedded in partner apps (BPJPH portal, exporter platforms)?
4. **Recovery UX** — Passphrase-based, social recovery, custodial fallback for non-technical users, or all three tiered by user choice?
5. **Issuer onboarding gatekeeper** — Pure on-chain governance vote, or off-chain regulator approval signed and committed on-chain?
6. **Privacy default** — BBS+ selective disclosure by default for holder VCs, or opt-in?
7. **Proving system** — Groth16 (smaller proofs, per-circuit ceremony) or PLONK/Halo2 (universal setup, slightly larger proofs)? Default recommendation: Groth16 for D6.1–D6.3, PLONK evaluation in D6.5, switch in Stage D7 if PLONK matures.
8. **ZK ceremony participants** — who signs as contributors to the trusted setup? BPJPH + MUI + validators + independent observers is the proposed mix; needs formal commitment before D6.3.

Each of these has architectural implications and should be decided before code is written, not after.

---

# 14. Summary

HaraDID = **IssuerRegistry (Pattern A) + Sidetree (Pattern B) + ZK Proof Layer**.

- ~10,000 regulated issuers live on-chain as first-class entities.
- Billions of holder DIDs anchored via DIF Sidetree v1.0 batches.
- All credentials are W3C VCs with StatusList2021 revocation.
- **Privacy via three-tier presentation modes**: public, BBS+ selective disclosure, or full zero-knowledge.
- **ZK proofs** of issuer accreditation, non-revocation, validity, and supply-chain provenance using reused Iden3/Polygon ID circuits + on-chain Groth16 verifier contracts.
- Chain-portable so Besu → Avalanche / Polygon CDK migration is mechanical.
- Standards-compliant so external verifiers and OIC partners can resolve `did:hara` via Universal Resolver and verify ZK presentations with the open Verifier SDK.

This is the development pathway. Implementation follows Stages D1–D8.
