# HARA Registry Ledger

HARA-operated facade **behind the HARA Aurum integration**. It makes the
attestations and event chain behind a passport **tamper-evident and publicly
verifiable** — without giving verifiers tenant access. Aurum sends **hashes and
DIDs only** — never tenant payloads.

Contract-first against [`doc/api/aurum-ledger-integration-guide.md`](../../doc/api/aurum-ledger-integration-guide.md)
and [`doc/api/openapi-aurum-ledger.yaml`](../../doc/api/openapi-aurum-ledger.yaml).
Modelled closely on the sibling [`services/gapura-gateway`](../gapura-gateway).

> **Transparency-log model.** The Ledger keeps a per-tenant **append-only RFC 6962
> SHA-256 Merkle transparency log** (`src/transparency-log.ts`). Every leaf
> (attestation, status change, evidence registration, refused-delete attempt)
> produces an offline-verifiable **inclusion proof**, and tree heads (**Signed Tree
> Heads**) are committed on-chain via a **Ledger-scoped `PQAnchorRegistry`**
> (hybrid ECDSA + ML-DSA-65). `consistency` proofs show a chain was not rewritten.

Chain facts: id **131216**, `gasPrice 0`, legacy (type-0) txs, write RPC
`https://rpc.ledger.haratrust.io/write/`, read RPC `https://rpc.ledger.haratrust.io/read/`.
The `PQAnchorRegistry` instance MUST be the Ledger-scoped one — **not** the shared
platform registry `0x8A791620…C318`.

---

## Run

```bash
cd services/registry-ledger
npm install
cp .env.example .env      # then fill in (or leave dev defaults)
npm run dev               # tsx watch src/server.ts → listens on :8940
# typecheck only:
npm run typecheck         # tsc --noEmit
# transparency-log self-test (RFC 6962 inclusion + consistency):
npm run selftest          # tsx src/transparency-log.ts --selftest
```

This is a **standalone npm package with its own `node_modules`** — it is NOT part
of the `services/` pnpm workspace. Node 22, Fastify.

Out of the box (all dev defaults) the Ledger boots with:
- **DEV-BYPASS auth** (no Numira env) — every write is tenant `did:hara:tenant:dev`.
- **in-memory store** (empty `PG_URL`) — non-persistent.
- **on-chain anchoring DISABLED** — `ANCHOR_ECDSA_KEY` / `PQ_MLDSA_SEED` are
  placeholders and/or `PQ_ANCHOR_REGISTRY` is not a Ledger-scoped instance, so STHs
  come back **locally-signed but UNANCHORED** (no `anchor` field). Everything else —
  append, inclusion proofs, consistency proofs, status, retention, verify — works.

`GET /healthz` reports `writesEnabled` so you can see whether anchoring is wired.

---

## REAL vs STUB / TODO

### REAL (implemented + correct)
- **`src/transparency-log.ts` — THE CORE.** Append-only **RFC 6962** SHA-256 Merkle
  transparency log per `log_id`: `append(leaf) → leaf_index`, `currentRoot()` /
  `treeSize()`, `inclusionProof(leaf_index, tree_size)`, `consistencyProof(first,
  second)`. `leaf hash = SHA256(0x00‖leaf)`, `node hash = SHA256(0x01‖left‖right)`.
  Ships the standalone RFC 6962 §2.1.1/§2.1.2 **verifiers** the SDK must agree with,
  plus an internal **self-test** (`npm run selftest`) that checks every inclusion +
  consistency proof for trees up to size 33, pins the empty/single-leaf vectors, and
  runs a tampered-leaf negative control.
- **`src/services/pq.ts`** — ML-DSA-65 keygen-from-seed / sign / verify,
  `publicKeyHash = keccak256(pubkey)` (copied from `anchor-worker/src/pq.ts`), plus
  `canonicalSTH()` — the deterministic byte layout the Ledger signs per STH.
- **`src/services/anchor.ts`** — publishes a Signed Tree Head and anchors it:
  `recordAnchor(merkleRoot = sha3Root = STH root_hash, blockFrom = blockTo = safe
  head, eventCount = tree_size, anchorChain = keccak256("log_id"), pqSignatureHash =
  keccak256(ml_dsa65.sign(canonical STH)))` via a viem **legacy** tx (`type "legacy"`,
  `gasPrice 0`, `chainId 131216`, explicit gas) to the write RPC → wait for receipt +
  revert check → parse `AnchorRecorded` for `onChainId` → STH with
  `anchor:{chainId,txHash,onChainId,contract}`.
- **`src/config.ts`** — env loading; `PQ_ANCHOR_REGISTRY` defaults to the zero address
  (never the shared platform registry), `isLedgerScopedRegistry()` rejects both the
  zero and shared-platform addresses, `SHARED_PLATFORM_PQ_ANCHOR_REGISTRY` exported.
- **`src/auth.ts`** — Numira JWT bearer verify via remote JWKS (issuer + audience
  `attest.ledger.haratrust.io`), tenant-DID (`did:hara:tenant:*`) extraction,
  `enforceTenant()` for write tenant-scoping (403 `forbidden_tenant`). DEV-BYPASS when
  the Numira env is unset.
- **`src/errors.ts`** — RFC 9457 `application/problem+json`, the §7 code set.
- **`src/store/memory.ts`** — the DEFAULT store, fully working (attestations, status
  history, evidence + retention, checkpoints, per-log leaves).
- **All routes** — every OpenAPI operation (`src/routes/*`), wired to the ledger core.

### STUB / TODO
- **On-chain anchoring needs Vault keys + a Ledger-scoped registry** — until then STHs
  are locally-signed but UNANCHORED (see above / `services/anchor.ts`).
- **PQ signature blob storage** — the raw ~3.3 KB ML-DSA-65 sig is **not yet** persisted.
  TODO: PUT it to MinIO bucket `hara-pq-anchors` keyed by `{log_id, tree_size}` so the
  SDK verifier can re-run the off-chain PQ check (mirrors the anchor-worker). Off-chain
  payload / MinIO storage is otherwise **out of scope** — the Ledger stores hashes only.
- **`src/store/postgres.ts`** — pg-backed skeleton with full CREATE TABLE DDL, used only
  when `PG_URL` is set; not exercised against a live DB.
- **Checkpoint-only consistency** — `GET /v1/anchors/consistency` derives a real RFC 6962
  path only for logs whose leaves the Ledger holds (appended via this service). For a
  log where the client submitted **roots only**, there are no leaves to walk →
  `422 proof_unavailable`.
- **Webhooks** (§8) and **rate limiting** (§2) — not implemented here.
- **DEV-BYPASS auth** — active only when the Numira env is unset; never in prod.

---

## Semantics

### Retention = record-of-authority (no-delete-before-expiry)
`POST /v1/evidence` registers a content hash under `{until, basis, legalHold}` as an
anchored leaf. `DELETE` is **refused** with `409 retention_locked` while `until` is in
the future OR `legalHold` is set — and the **refused attempt is itself appended as a
leaf and anchored** (auditable). After expiry with no hold, deletion is allowed and
recorded. `PATCH` may set/lift `legalHold` and **extend** `until` (never shorten →
`409 status_conflict`).

### Status = active | superseded | revoked (each change an anchored leaf)
`POST /v1/attestations/{id}/revoke` (tenant-scoped) appends a **status leaf** (in the
same tenant log), anchors the new STH, and returns the new `StatusRecord` with its
inclusion proof. Registry **owns status-of-record**; a re-revoke of an already-revoked
record → `409 status_conflict`.

### Proofs resolve against a Signed Tree Head
Every `inclusion_proof` / `consistency_path` is verifiable against the STH's
`root_hash`; the STH root is (when anchoring is enabled) committed on-chain, so proofs
need no server round-trip. `leaf hash = SHA256(0x00‖leaf)`, `node hash =
SHA256(0x01‖left‖right)` — RFC 6962 exactly, so the SDK's standalone verifier agrees.

### Hashes + DIDs only
The Ledger never receives or stores tenant payloads — only content hashes, DIDs, and
retention/status metadata.

---

## Open decisions (before GA)

1. **Ledger-scoped `PQAnchorRegistry` instance (model c).** Deploy a dedicated instance
   (separate anchor id-space from the platform / Gapura / Atlas) and register it as
   `RegistryLedgerAnchor` in ContractRegistry; point `PQ_ANCHOR_REGISTRY` at it. Anchor
   writes stay disabled until this is a real scoped instance (never `0x8A79…C318`).
2. **Numira token audience.** The Ledger validates `aud = attest.ledger.haratrust.io`
   (`NUMIRA_AUDIENCE`) + the `did:hara:tenant:*` claim; confirm Numira issues tokens with
   that audience and tenant-DID claim wired.
3. **`did:hara` sub-namespaces** (`report|tenant|passport|assay`) registered in the method
   spec / resolver.
4. **Sandbox** `attest.sandbox.haratrust.io` seeded with Aurum golden-path fixtures.

---

## Log-id convention

- Attestation / status / evidence leaves for a tenant → `tenant:<slug>` where `<slug>` is
  the tail of `did:hara:tenant:<slug>` (matches the guide's `tenant:surveyor-psi`).
- Event-chain checkpoints use the **client-supplied** `log_id` (e.g.
  `tenant:surveyor-psi:events`).

---

## Endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/v1/attestations` | Numira (tenant-scoped) |
| GET | `/v1/attestations/:registryId` | public |
| GET | `/v1/attestations/:registryId/proof` | public |
| GET | `/v1/attestations/:registryId/status` | public |
| POST | `/v1/attestations/:registryId/revoke` | Numira (tenant-scoped) |
| POST | `/v1/anchors` | Numira (tenant-scoped) |
| GET | `/v1/anchors/consistency` | public |
| POST | `/v1/evidence` | Numira (tenant-scoped) |
| GET | `/v1/evidence/:evidenceId` | public |
| PATCH | `/v1/evidence/:evidenceId` | Numira (tenant-scoped) |
| DELETE | `/v1/evidence/:evidenceId` | Numira (tenant-scoped) |
| GET | `/v1/verify?subject=` | public |
| GET | `/healthz` | — |

---

## Postgres schema (used when `PG_URL` is set)

Full DDL lives in `src/store/postgres.ts` (`ledger_attestation`, `ledger_status`,
`ledger_evidence`, `ledger_checkpoint`, `ledger_leaf`).
