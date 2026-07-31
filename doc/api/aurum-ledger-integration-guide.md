# HARA Registry Ledger ↔ HARA Aurum — Integration Guide

**Audience:** the HARA Aurum team, making the attestations and event chain behind a passport
**tamper-evident and publicly verifiable** via HARA Registry — *without* giving verifiers
tenant access. This is the **credential-ledger** role: Registry proves an attestation
*exists, is authentic, and its status*; it never adjudicates conformity.

**Status legend:**

| Tag | Meaning |
|---|---|
| 🟢 **LIVE** | Exists in HARA Registry today (on-chain contract + low-level code). |
| 🟡 **LEDGER (to build)** | The contract below is fixed and buildable-against **now**; the HARA-operated **Registry Ledger** service that serves it is being built in parallel. Build against it contract-first. |
| 🔴 **NEEDS PROVISIONING** | Operator/infra action (sandbox + fixtures, Numira token audience, `did:hara` namespace registration) — see [§10](#10-what-hara-must-stand-up). |

> **Design decisions (HARA Registry team's answers to your §8 open questions):** all four
> confirmed — see [§9](#9-answers-to-your-open-questions). In short: **transparency-log proofs
> (RFC 6962/9162, SHA-256, offline-verifiable)**, tree heads anchored on-chain via
> `PQAnchorRegistry`; **status-of-record and retention-of-record are Registry's**; the event
> chain is **checkpoint-anchored** (you keep the chain, we anchor heads + serve proofs).

---

## 1. Architecture

```
 Aurum backend (Node/TS)
     │  @hara/registry-ledger-sdk        Numira token (tenant DID) — writes tenant-scoped
     │  + standalone proof verifier       proofs & status are PUBLIC (no tenant access)
     ▼
 ┌────────────────────────────────────────────────────────────┐
 │  HARA Registry Ledger   (HARA-operated, 🟡)                  │
 │   • append-only Merkle transparency log per tenant (RFC 6962)│
 │   • attestations: anchor VC/record hash → registry_id + proof│
 │   • proofs: inclusion (leaf∈tree) + consistency (B extends A)│
 │   • status-of-record: active | superseded | revoked (audited)│
 │   • evidence + retention-of-record (no-delete-before-expiry) │
 │   • verify bundle by passport DID (offline-verifiable)       │
 │   • signs Tree Heads; anchors {root, tree_size} on-chain     │
 └───────────────┬──────────────────────────┬──────────────────┘
        🟢         │                🟢         │
   PQAnchorRegistry (tree-head anchor)   HaraDID / Numira (issuer DIDs, token)
   chain 131216  (recordAnchor: root+size)  (VC issuance; status stays here)
```

**Only hashes and DIDs cross the seam.** Aurum submits the **content hash** of a signed
record (never the tenant payload); the Ledger stores metadata + the hash as a Merkle leaf.
Proofs and status are then publicly resolvable by anyone holding the passport/record DID.

**How the on-chain anchor works (Ledger-internal):** the Ledger maintains a SHA-256 Merkle
transparency log per tenant. Periodically (and on demand) it publishes a **Signed Tree Head
(STH)** = `{tree_size, root_hash, timestamp}` and anchors it via
`PQAnchorRegistry.recordAnchor(merkleRoot = root_hash, eventCount = tree_size, …, pqSignatureHash)`
— so the head is timestamped, ECDSA-landed, **and** ML-DSA-65 (post-quantum) committed.
Every inclusion/consistency proof resolves against an STH whose root is **anchored on-chain**,
which is what makes it offline-verifiable and tamper-evident.

---

## 2. Base URLs, versioning, auth

| | URL |
|---|---|
| Production (🟡 GA pending) | `https://attest.ledger.haratrust.io/v1` |
| Sandbox (🔴 to provision, Aurum fixtures) | `https://attest.sandbox.haratrust.io/v1` |

- **OpenAPI 3.1 is the source of truth:** [`openapi-aurum-ledger.yaml`](openapi-aurum-ledger.yaml).
- **Versioning:** path-versioned (`/v1`); additive = non-breaking; breaking → `/v2` with a
  `Deprecation`+`Sunset` window; SDK follows **SemVer**; a `CHANGELOG` ships with the SDK.
- **Auth (Numira pass-through):** `Authorization: Bearer <numira-jwt>`. The token carries the
  **tenant DID** (`did:hara:tenant:*`); **writes are tenant-scoped** from it. **Reads of
  proofs and status are public** (no token needed) — that is the whole point of the ledger.
  The Ledger validates the Numira JWT signature + audience `attest.ledger.haratrust.io`.
- **Idempotency:** the **content hash is the key** — submitting the same record hash returns
  the **same `registry_id`** (`200`), never a duplicate leaf. `Idempotency-Key` header is
  accepted as belt-and-suspenders.
- **Errors:** RFC 9457 `application/problem+json` (see [§7](#7-error-model)).
- **Rate limits:** `RateLimit-Limit/Remaining/Reset` headers; per-tenant buckets.

---

## 3. Attestations 🟢 anchor live / 🟡 Ledger

### 3.1 Anchor an attestation — `POST /v1/attestations`

Anchor a signed VC/record (surveyor report, assay, gate decision, custody event). The record
**payload stays in your tenant store** — you send its hash + metadata.

**Request** (Numira bearer)
```jsonc
{
  "subject": "did:hara:report:7f3a9c21-4e88",   // the record DID
  "issuer":  "did:hara:tenant:surveyor-psi",     // must match the token's tenant scope
  "recordType": "surveyor-report",               // surveyor-report|assay|gate-decision|custody-event
  "contentHash": "0x…",                          // sha256 of the canonical signed record (hashes only)
  "hashAlg": "sha256",
  "issuedAt": "2026-12-28T03:19:00Z",
  "vcProof": { "type": "Ed25519Signature2020", "jws": "…" }, // the VC's own signature (verifiable offline)
  "links": { "passport": "did:hara:passport:…" }             // optional: bind to a passport for §6 verify
}
```

**Response `201`** (or `200` if this `contentHash` was already anchored)
```jsonc
{
  "registry_id": "reg:att:7f3a…",
  "subject": "did:hara:report:7f3a9c21-4e88",
  "issuer":  "did:hara:tenant:surveyor-psi",
  "status":  "active",
  "anchored_at": "2026-12-28T03:20:00Z",
  "log": { "log_id": "tenant:surveyor-psi", "leaf_index": 41208, "leaf_hash": "0x…" },
  "inclusion_proof": {                           // proves this leaf ∈ the tree at `sth`
    "leaf_index": 41208, "tree_size": 41209, "audit_path": ["0x…","0x…"]
  },
  "sth": {                                        // the anchored Signed Tree Head it's proven against
    "tree_size": 41209, "root_hash": "0x…", "timestamp": "2026-12-28T03:20:00Z",
    "anchor": { "chainId": 131216, "txHash": "0x…", "onChainId": "812" }
  }
}
```
Verify offline with the SDK: `verifyInclusion(leafHash, inclusion_proof, sth.root_hash)` and
(optionally) `verifySthAnchored(sth)` against the read RPC.

### 3.2 Resolve — `GET /v1/attestations/{registry_id}` (public)
Returns the metadata above (subject, issuer, type, status, anchored_at, log ref) — **never the
tenant payload**.

### 3.3 Inclusion proof — `GET /v1/attestations/{registry_id}/proof?tree_size=` (public)
Returns `{ leaf_index, tree_size, audit_path, sth }`. Omit `tree_size` for the latest STH.

### 3.4 Status — `GET /v1/attestations/{registry_id}/status` (public)
`{ "status": "active" | "superseded" | "revoked", "since": "…", "reason": "…", "supersededBy": "reg:att:…"? , "proof": { … } }`.
Each status change is itself a leaf in the log (audited + anchored), so status is tamper-evident.

### 3.5 Revoke / supersede — `POST /v1/attestations/{registry_id}/revoke` (tenant-scoped)
```jsonc
{ "action": "revoke" | "supersede", "reason": "licence withdrawn", "supersededBy": "reg:att:…"? }
```
Attributed to the token's actor DID, appended as a status leaf, anchored. Returns the new
status record + its inclusion proof.

**SDK**
```ts
const led = new RegistryLedger({ baseUrl, token });               // Numira token
const att = await led.anchor({ subject, issuer, recordType, contentHash });
const ok  = led.verifyInclusion(att.log.leaf_hash, att.inclusion_proof, att.sth.root_hash); // offline
await led.setStatus(att.registry_id, "revoked", { reason: "…" });
```

---

## 4. Event-chain checkpoints + consistency 🟢 anchor live / 🟡 Ledger

Your append-only `events` chain stays yours. Append each event's hash to a named Ledger log
(so we can prove **inclusion**), and we anchor tree heads (checkpoints) so we can prove the
chain **was not rewritten** (**consistency**).

- **`POST /v1/anchors`** — submit a checkpoint for a tenant chain log.
  ```jsonc
  { "log_id": "tenant:surveyor-psi:events", "tree_size": 90210, "root_hash": "0x…" }
  ```
  → `{ "checkpoint_id": "ckpt:…", "sth": { tree_size, root_hash, timestamp, anchor: {txHash,onChainId} } }`.
  (If you also append leaves via `/attestations` or a `/logs/{id}/entries` batch, the Ledger
  builds the tree and returns inclusion proofs; if you only submit roots, we anchor them and
  serve **consistency** proofs between your submitted heads.)
- **`GET /v1/anchors/consistency?log_id=&from=&to=`** (public) — RFC 6962 consistency proof
  that the tree at size `to` **extends** the tree at size `from` (no rewrite/removal).
  → `{ first: {tree_size, root_hash}, second: {tree_size, root_hash}, consistency_path: ["0x…"] }`.
  Verify offline: `verifyConsistency(from, to, consistency_path)`.

> A **rewritten chain fails the consistency proof** — that is the acceptance test in your §7.

---

## 5. Evidence hashes + retention (record-of-authority) 🟡 Ledger

- **`POST /v1/evidence`** (tenant-scoped) — register a content hash under retention.
  ```jsonc
  { "contentHash": "0x…", "hashAlg": "sha256",
    "retention": { "until": "2033-12-28", "basis": "EUDR-Art38-5yr", "legalHold": false },
    "links": { "subject": "did:hara:report:…" } }
  ```
  → `{ "evidence_id": "ev:…", "anchored": true, "sth": {…}, "retention": {…} }`. The registration
  is a leaf → anchored, so the retention commitment is itself tamper-evident.
- **`GET /v1/evidence/{id}`** (public) — retention state `{ until, basis, legalHold, deletable: false }`.
- **`PATCH /v1/evidence/{id}`** (tenant-scoped) — set/lift `legalHold`; **extend** retention
  (never shorten below the recorded basis).
- **`DELETE /v1/evidence/{id}`** — **refused** (`409 retention_locked`) while `until` is in the
  future or `legalHold` is set; the refused attempt is logged **and anchored** (auditable).
  After expiry with no hold, deletion is allowed and recorded.

**Registry is the record-of-authority; your Sprint-6 local store mirrors it.** No-delete-before-expiry
is enforced here, not merely advised.

---

## 6. Public verification bundle 🟡 Ledger

**`GET /v1/verify?subject=did:hara:passport:…`** (public) — everything a regulator/auditor needs
to verify a passport's backing evidence **offline, without tenant access**:
```jsonc
{
  "subject": "did:hara:passport:…",
  "generated_at": "…",
  "attestations": [
    { "registry_id": "reg:att:…", "recordType": "surveyor-report", "status": "active",
      "subject": "did:hara:report:…", "issuer": "did:hara:tenant:…",
      "inclusion_proof": {…}, "sth": { root_hash, tree_size, anchor: {chainId, txHash, onChainId} } },
    …
  ],
  "checkpoints": [ { "log_id": "…:events", "sth": {…} } ],
  "evidence": [ { "evidence_id": "ev:…", "retention": {…} } ]
}
```
The SDK's **standalone verifier** re-checks every `inclusion_proof`/`consistency_path` against the
`sth.root_hash`, and (optionally) confirms each `sth.root_hash` is the value **anchored on-chain**
at `anchor.txHash` — no call to the Ledger required. A `did:hara:*` resolution step confirms issuer
authenticity. That is end-to-end offline verifiability.

---

## 7. Error model
RFC 9457 `application/problem+json`, stable `code`:
`invalid_hash`, `invalid_did`, `unauthenticated`, `forbidden_tenant` (writing outside your token's
tenant), `not_found`, `already_anchored` (→ returned as 200 with the existing record, not an error),
`retention_locked`, `status_conflict`, `proof_unavailable`, `rate_limited`, `chain_unavailable`.

## 8. Webhooks
Signed (`X-Registry-Signature: sha256=…`), retried with backoff. Events: `attestation.anchored`,
`attestation.status_changed`, `checkpoint.anchored`, `evidence.retention_expiring`. Or poll the
`GET` endpoints (all public, ETag-cached).

## 9. Answers to your open questions

1. **VC issuance vs status — yes, Registry owns status-of-record.** Numira issues the credential
   (`issuer = did:hara:tenant:*`); the Ledger owns its **status/revocation** ledger (each change
   an anchored leaf). Resolve via `GET …/status`. (No on-chain `RevocationRegistry` today — the
   anchored status log is the record; a future status contract can complement it without an API
   change.)
2. **Event chain — checkpoint-anchored (your assumption).** You keep the hash-linked chain; the
   Ledger anchors tree heads and serves inclusion + consistency proofs. Cheaper and RFC-6962-clean.
3. **Retention — Registry is the record-of-authority**, your local store mirrors. No-delete-before-expiry
   is enforced at the Ledger ([§5](#5-evidence-hashes--retention-record-of-authority--ledger)).
4. **Proof format — RFC 6962/9162 Merkle (SHA-256): inclusion + consistency, offline-verifiable.**
   The SDK ships a standalone verifier; STH roots are anchored on-chain via `PQAnchorRegistry`
   so proofs need no server round-trip.

## 10. What HARA must stand up (🔴 provisioning)

1. Deploy the **Registry Ledger** service (transparency-log + status + retention + verify), with
   its **own Ledger-scoped `PQAnchorRegistry` instance** (model c — separate anchor id-space from
   the platform / Gapura / Atlas), registered as `RegistryLedgerAnchor` in ContractRegistry.
2. **Sandbox** `attest.sandbox.haratrust.io` seeded with **Aurum's golden-path fixtures**
   (surveyor report, assay, event-chain) so your doctrine suite runs green.
3. **Numira token audience** `attest.ledger.haratrust.io` + tenant-DID claim wired for validation.
4. Register the `did:hara:report|tenant|passport|assay` sub-namespaces in the method spec/resolver
   (hand-off: [`numira-aurum-identity-prompt.md`](numira-aurum-identity-prompt.md)).
5. Webhook onboarding + per-tenant signing secret.

---
*Chain facts: [`hara-registry-facts.md`](hara-registry-facts.md). On-chain anchor:
`PQAnchorRegistry` (Ledger-scoped instance), chain 131216 — commits `{root_hash, tree_size}` per STH.*
