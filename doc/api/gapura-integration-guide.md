# HARA Gapura ↔ HARA Registry — Integration Guide

**Audience:** the HARA Gapura team (EUDR market-access, ADR-0019) integrating against
HARA Registry for **anchoring**, **identity (Numira / `did:hara`)**, and **usage
metering**. Gapura sends **hashes and DIDs only** — never geometry, never PII.

**Status legend** — read this first, it's the whole point:

| Tag | Meaning |
|---|---|
| 🟢 **LIVE** | Exists in HARA Registry today (on-chain contract + low-level SDK). |
| 🟡 **GATEWAY (to build)** | The contract below is fixed and buildable-against **now**; the HARA-operated *Gapura Gateway* service that serves it is being built in parallel. Build against it contract-first; it will not answer on the live URL until GA. |
| 🔴 **NEEDS PROVISIONING** | Requires an operator/infra action (sandbox env, service creds, DID-namespace registration) — see [§9](#9-what-hara-must-stand-up). |

> **Design decisions (confirmed):** the Gateway is **operated by HARA** — it holds the
> `ANCHOR_ROLE` chain key and the ML-DSA-65 PQ signing key in Vault; Gapura never touches
> a chain key or PQ crypto. **Metering** is fully specified here and built in a later pass.

---

## 1. Architecture

```
 Gapura consoles (React/TS)            Gapura backend (Python/FastAPI)
        │  @hara/gapura-sdk (TS)              │  hara_gapura (Python)
        └───────────────┬─────────────────────┘
                        │  HTTPS + OAuth2 (Authentik service token)   [hashes + DIDs only]
                        ▼
        ┌───────────────────────────────────────────────┐
        │  HARA Gapura Gateway   (HARA-operated, 🟡)      │
        │   • anchor: hash → PQAnchorRegistry.recordAnchor│
        │   • verify: hash → anchor record + PQ proof     │
        │   • identity: proxy to HaraDID resolver/registry│
        │   • metering: geometry-blind usage counters     │
        │   • holds ANCHOR_ROLE key + ML-DSA-65 key (Vault)│
        │   • idempotency + metadata store (Postgres)     │
        └───────┬───────────────┬───────────────┬─────────┘
        🟢       │        🟢      │        🟡      │
    PQAnchorRegistry     HaraDID / Numira     metering store
    (chain 131216)   (IssuerRegistry+Sidetree)  (aggregates)
```

**Why the Gateway (facade), not direct ABI:** `PQAnchorRegistry.recordAnchor` needs a
funded `ANCHOR_ROLE` key, ML-DSA-65 signing, and range-encoding — none of which belong in
a Gapura console or backend. The Gateway holds the key once, does the PQ signing, stores the
`{hash → objectDid → purpose}` metadata the **chain cannot** (the contract has no DID/purpose
field), and centralizes idempotency, metering, and auth. This is the geometry-blind seam.

**Anchoring maps onto the live contract like this** (Gateway-internal, you don't do it):
`recordAnchor(merkleRoot, sha3Root, blockFrom, blockTo, eventCount, anchorChain, pqSignatureHash)`
— for a single passport digest the Gateway sets `merkleRoot = sha3Root = your digest`,
`eventCount = 1`, `blockFrom = blockTo = <safe head>`, `anchorChain = <purpose/tenant tag>`,
`pqSignatureHash = keccak256(ml_dsa65.sign(digest))`. Your `objectDid`, `purpose`, and the
digest↔anchorId link live in the Gateway's Postgres, keyed by the digest.

---

## 2. Base URLs, versioning, auth

| | URL |
|---|---|
| Production (🟡 GA pending) | `https://gapura.ledger.haratrust.io/v1` |
| Sandbox / staging (🔴 to provision) | `https://gapura.sandbox.haratrust.io/v1` |

- **Versioning:** path-versioned (`/v1`). Additive fields are non-breaking (clients must
  ignore unknown fields). Breaking changes ship as `/v2` with ≥90-day overlap and
  `Deprecation` + `Sunset` response headers. SDKs follow SemVer.
- **Auth (service-to-service):** **OAuth2 client-credentials via Authentik** (ADR-0018).
  Gapura's backend exchanges its Authentik client id/secret for a short-lived JWT and sends
  `Authorization: Bearer <jwt>`. Scopes gate each domain: `anchor:write`, `anchor:read`,
  `identity:read`, `identity:write`, `metering:read`. Consoles never call the Gateway
  directly with a user token — the Gapura backend brokers (so the browser never holds an
  anchor-capable token). Optional mTLS on top for the backend↔Gateway hop.

```http
POST https://auth.haratrust.io/application/o/token/      (Authentik)
grant_type=client_credentials&client_id=gapura-backend&client_secret=…&scope=anchor:write anchor:read identity:read metering:read
→ { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 300 }
```

- **Idempotency:** two layers. (a) **Natural** — the digest *is* the key: anchoring an
  already-anchored hash returns the existing anchor (`200`), never a duplicate. (b) **Header**
  — send `Idempotency-Key: <uuid>` on `POST /anchors`; the Gateway caches the response for
  24 h and replays it on retry, returning `409 idempotency_conflict` only if the same key is
  reused with a *different* body.
- **Errors:** RFC 9457 `application/problem+json` everywhere (see [§7](#7-error-model)).

---

## 3. Anchoring 🟢 contract live / 🟡 Gateway

### 3.1 Anchor a digest — `POST /v1/anchors` · scope `anchor:write`

Records a passport/credential hash on HARA Registry. Every anchor is inherently
**dual-signed** — the **ECDSA** consensus signature that lands the `recordAnchor` tx on-chain
(existence + timestamp), **and** an **ML-DSA-65** post-quantum signature whose hash is
committed on-chain (`pqSignatureHash`), with the sig blob + pubkey published off-chain for
verification. That hybrid *is* the "dual public anchor" — there is no external second chain
and no flag to set.

**Request**
```jsonc
// headers: Authorization: Bearer …; Idempotency-Key: 5f… (optional)
{
  "digest":    "0x9b2c…",             // REQUIRED. 32-byte hex hash, hashes only
  "hashAlg":   "sha256",              // "sha256" | "keccak256"; how `digest` was computed
  "objectDid": "did:hara:obj:mp:8f3a…", // REQUIRED. the Map Passport / credential subject
  "purpose":   "map-passport",        // REQUIRED. enum-ish tag, e.g. map-passport|eudr-dds|credential
  "actorDid":  "did:hara:authority:big", // OPTIONAL. who initiated (for provenance/"by whom")
  "metadata":  { "batchRef": "GAP-2026-000123" } // OPTIONAL. small, NO PII, NO geometry
}
```

**Response `201 Created`** (or `200 OK` if this digest was already anchored)
```jsonc
{
  "anchorId": "gap_anc_01HZX…",       // Gateway id (stable, url-safe)
  "onChainId": "4213",                // PQAnchorRegistry anchor id (uint256, string-encoded)
  "digest":   "0x9b2c…",
  "objectDid":"did:hara:obj:mp:8f3a…",
  "purpose":  "map-passport",
  "status":   "confirmed",            // QBFT instant finality — usually confirmed within ~1 block
  "txRef": {
    "chainId": 131216,
    "contract": "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    "txHash":  "0x…",
    "blockNumber": 1016811,
    "logIndex": 0
  },
  "pqKeyHash": "0xa7dca428…",         // ML-DSA-65 pubkey hash this anchor is frozen against
  "signatures": { "ecdsa": true, "mlDsa65": true }, // the dual (hybrid) signature — always both
  "anchoredAt": "2026-06-23T09:14:02Z"
}
```

**SDK**
```ts
// TypeScript — @hara/gapura-sdk
const gap = new GapuraClient({ baseUrl, auth });          // auth = Authentik client-creds
const anchor = await gap.anchors.create({
  digest, hashAlg: "sha256", objectDid, purpose: "map-passport",
}, { idempotencyKey });                                    // safe to retry
```
```python
# Python — hara_gapura
gap = GapuraClient(base_url=BASE, auth=auth)
anchor = gap.anchors.create(
    digest=digest, hash_alg="sha256", object_did=object_did, purpose="map-passport",
    idempotency_key=idem)                                  # safe to retry
```

**Errors:** `400 invalid_digest` (not 32-byte hex), `400 invalid_did`, `403 forbidden_scope`,
`409 idempotency_conflict`, `422 unanchorable` (Gateway couldn't map to a valid `recordAnchor`),
`502 anchor_failed` (chain submit reverted — see `detail`).

### 3.2 Verify an anchor — `GET /v1/anchors?digest=0x…` (or `POST /v1/verify`) · scope `anchor:read` (or public read on the verify portal)

Given a hash, confirm it's anchored, when, and by whom. Read-only; safe for the verify
portal and auditors.

**Response `200`**
```jsonc
{
  "digest": "0x9b2c…",
  "anchored": true,
  "anchors": [
    {
      "anchorId": "gap_anc_01HZX…",
      "objectDid": "did:hara:obj:mp:8f3a…",
      "purpose": "map-passport",
      "anchoredBy": { "tenant": "gapura", "actorDid": "did:hara:authority:big" },
      "anchoredAt": "2026-06-23T09:14:02Z",
      "txRef": { "chainId": 131216, "txHash": "0x…", "onChainId": "4213" },
      "verification": {
        "ecdsaOnChain": true,        // recordAnchor tx is on-chain (existence + timestamp)
        "pqVerified": true,          // Gateway re-checked ML-DSA-65 sig off-chain against pqKeyHash
        "pqKeyHash": "0xa7dca428…"   // ECDSA-on-chain + PQ-verified together = the dual/hybrid proof
      },
      "status": "confirmed"
    }
  ],
  "asOf": "2026-06-23T09:20:00Z"
}
```
`anchored:false` with `anchors:[]` when the digest has never been anchored.

```ts
const res = await gap.anchors.verify({ digest, hashAlg: "sha256" });
if (!res.anchored) { /* not on the ledger */ }
```
```python
res = gap.anchors.verify(digest=digest, hash_alg="sha256")
```

### 3.3 Anchor tx lifecycle — `GET /v1/anchors/{anchorId}/status` + webhooks · scope `anchor:read`

HARA Registry is QBFT with **instant finality** (~sub-second, single-block), so most anchors
are `confirmed` almost immediately. The lifecycle is still explicit so you can gate the verify
portal on `confirmed` and catch the rare `failed`.

**Response `200`**
```jsonc
{
  "anchorId": "gap_anc_01HZX…",
  "status": "confirmed",              // pending | confirmed | failed
  "confirmations": 12,
  "blockNumber": 1016811,
  "cost": { "gas": "0", "unit": "HARA", "note": "permissioned chain, gasPrice 0 — no fee; metering counts tx" },
  "signatures": { "ecdsa": true, "mlDsa65": true },
  "failureReason": null
}
```

**Webhooks (preferred) or polling — you choose:**
- **Webhooks:** register a callback (see [§9](#9-what-hara-must-stand-up) for onboarding). The
  Gateway POSTs signed events on state change: `anchor.confirmed`, `anchor.failed`. Payload is
  the [§3.3](#33-anchor-tx-lifecycle) body plus
  `event`, `id`, `deliveredAt`. Signature: `X-Gapura-Signature: sha256=<hmac>` over the raw
  body with your webhook secret (verify before trusting).
- **Polling:** `GET …/status` with `If-None-Match`/ETag; poll interval ≥ 2 s.

---

## 4. Identity (Numira ID / `did:hara`) 🟢 method live / 🟡 Gateway proxy

The `did:hara` method is defined in `doc/guides/haradid-pathway.md`: **issuer/authority DIDs
are on-chain** (`IssuerRegistry`), **holder/actor DIDs are Sidetree** with a resolver service.
Identity *onboarding lives in HaraDID / Numira* — the Gateway **proxies and orchestrates**; it
does not re-implement the DID method.

> ⚠️ **Namespace alignment needed (🔴).** Your DIDs — `did:hara:obj:…`,
> `did:hara:authority:big`, `did:hara:surveyor-id`, actor DIDs — use `obj:`/`authority:`
> sub-namespaces that are **not yet registered** in the `did:hara` method spec (which today
> defines `did:hara:iss:<chain>:<id>` and Sidetree suffixes). Before GA, HaraDID must register
> these sub-namespaces (resolution rules + which registry backs each). Tracked in [§9](#9-what-hara-must-stand-up).

### 4.1 Resolve a DID — `GET /v1/did/{did}` · scope `identity:read`

**Response `200`** — W3C DID Resolution result:
```jsonc
{
  "didDocument": {
    "id": "did:hara:authority:big",
    "verificationMethod": [ { "id": "…#key-1", "type": "JsonWebKey2020", "publicKeyJwk": { … } } ],
    "service": [ … ]
  },
  "didResolutionMetadata": { "contentType": "application/did+ld+json", "retrieved": "…" },
  "didDocumentMetadata": { "anchored": true, "created": "…", "updated": "…", "deactivated": false,
                            "backing": "on-chain-issuer" }   // on-chain-issuer | sidetree
}
```
`404 did_not_found`, `410 did_deactivated`, `400 did_unresolvable` (bad method/namespace).

```ts
const doc = await gap.identity.resolve("did:hara:authority:big");
```
```python
doc = gap.identity.resolve("did:hara:authority:big")
```

### 4.2 Issue / register a tenant or authority DID — `POST /v1/identities` · scope `identity:write`

Onboards a Gapura tenant org or authority-staff identity. **This delegates to HaraDID/Numira**
— issuer/authority DIDs are written to `IssuerRegistry` on-chain; actor/holder DIDs are batched
through Sidetree. The Gateway returns once the DID is registered (or `202` + a poll ref for the
Sidetree-batched case).

**Request**
```jsonc
{
  "subjectType": "authority",        // authority | tenant-org | actor
  "displayName": "BIG (Badan Informasi Geospasial)",
  "controllerJwk": { "kty": "OKP", "crv": "Ed25519", "x": "…" }, // caller-supplied public key; Gateway never sees private keys
  "namespaceHint": "authority"        // maps to did:hara:authority:…
}
```
**Response `201`/`202`**
```jsonc
{ "did": "did:hara:authority:big", "didDocument": { … },
  "registration": { "backing": "on-chain-issuer", "txRef": { "chainId": 131216, "txHash": "0x…" }, "state": "confirmed" } }
```
`202` returns `{ "operationId": "…", "state": "batching" }` for Sidetree; poll
`GET /v1/identities/operations/{operationId}`.

> **Where identity really lives:** if you'd rather call HaraDID/Numira directly for
> onboarding, the Gateway is optional for `identity:write` — it exists so Gapura has **one**
> auth model and audit trail. Resolution (`4.1`) you'll always want via the Gateway (caching,
> metering).

### 4.3 DID ↔ Authentik binding — `GET/POST /v1/identities/{did}/bindings` · scope `identity:read`/`identity:write`

**Because Numira DID-SSO was deferred (ADR-0018 → Authentik), there is no automatic binding
today.** DIDs and Authentik identities are separate. The Gateway maintains an **explicit map**
so Gapura can go both ways:

- Your consoles authenticate with Authentik → the JWT carries `sub` (+ `email`).
- The Gateway stores `{ authentikSub ↔ did, tenant, boundAt }`.
- Resolve either direction:
  - `GET /v1/identities/by-subject/{authentikSub}` → `{ did, tenant }`
  - `POST /v1/identities/{did}/bindings` body `{ "authentikSub": "…", "tenant": "gapura" }`

```jsonc
// GET /v1/identities/by-subject/ak_9f3c…
{ "authentikSub": "ak_9f3c…", "did": "did:hara:authority:big", "tenant": "gapura", "boundAt": "…" }
```

When Numira DID-SSO ships, this collapses: the DID becomes a first-class claim in the token and
the map is retired. Until then, **the Authentik `sub` is the join key** and the Gapura backend
owns creating the binding at onboarding time.

---

## 5. Usage metering (geometry-blind) 🟡 spec now / build later

Scoped to Gapura, for the HARA Ops console. **No geometry, no PII** — pure counters. The
contract is fixed here; the aggregation backend (chain-log indexer + Numira resolution logs +
Gapura-reported verifications) is a follow-up build.

### 5.1 Query usage — `GET /v1/metering/usage` · scope `metering:read`

Query: `?tenant=gapura&from=2026-06-01&to=2026-06-30&granularity=day&metric=all`

**Response `200`**
```jsonc
{
  "tenant": "gapura",
  "period": { "from": "2026-06-01", "to": "2026-06-30", "granularity": "day" },
  "metrics": {
    "numiraIdResolutions": 18342,     // DID resolves via §4.1
    "atlasDidMints": 96,              // new DIDs issued via §4.2 (Atlas actors)
    "passportVerifications": 5120,    // §3.2 verify calls (Gapura-reported + Gateway-observed)
    "anchorTxCount": 5211,            // §3.1 anchors submitted on-chain
    "anchorCostUnits": 0              // gasPrice 0 → 0; unit is tx-count for billing, not gas
  },
  "series": [ { "date": "2026-06-01", "anchorTxCount": 173, "…": 0 } ],  // present when granularity=day
  "quotas": { "anchorTxCount": { "limit": 200000, "used": 5211, "resetsAt": "2026-07-01T00:00:00Z" } },
  "generatedAt": "2026-06-23T09:25:00Z"
}
```

### 5.2 Quotas + streaming
- `GET /v1/metering/quotas` → current limits + consumption per metric.
- **Streaming to the Ops dashboard:** webhook `metering.quota.threshold` (fires at 80/90/100%)
  and a nightly `metering.rollup` event; or poll `5.1`. A push/SSE stream can be added later.

```ts
const usage = await gap.metering.usage({ tenant: "gapura", from, to, granularity: "day" });
```
```python
usage = gap.metering.usage(tenant="gapura", from_="2026-06-01", to="2026-06-30", granularity="day")
```

---

## 6. SDKs (TS + Python)

Two thin, typed clients over the Gateway — **not** over the chain (the Gateway hides keys/PQ):

- **TypeScript** `@hara/gapura-sdk` — for the React consoles' backend-for-frontend and any
  Node service. (Browsers call *your* backend, which calls the SDK — never ship an
  `anchor:write` token to the browser.)
- **Python** `hara_gapura` — for the FastAPI backend.

Both expose the same surface: `client.anchors.{create,get,verify,status}`,
`client.identity.{resolve,register,bindings}`, `client.metering.{usage,quotas}`, an
`auth` provider that does the Authentik client-credentials exchange + token refresh, built-in
retries with idempotency, and typed `ProblemError`. **These are generated to match
[`openapi-gapura.yaml`](openapi-gapura.yaml)** so they never drift from the contract.

> The low-level chain SDK (`@hara/registry-sdk` / `hara_registry`, with the `anchor` module)
> stays available for HARA-internal use, but Gapura should use `gapura-sdk` — you do not want
> a chain key in Gapura.

---

## 7. Error model

RFC 9457 `application/problem+json`:
```jsonc
{
  "type": "https://gapura.ledger.haratrust.io/errors/invalid_digest",
  "title": "Invalid digest",
  "status": 400,
  "code": "invalid_digest",           // stable machine code (SDK maps to ProblemError.code)
  "detail": "digest must be 32-byte 0x-prefixed hex",
  "instance": "/v1/anchors",
  "traceId": "01HZX…"
}
```
| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_digest` / `invalid_did` / `invalid_period` | malformed input |
| 401 | `unauthenticated` | missing/expired token |
| 403 | `forbidden_scope` | token lacks the required scope |
| 404 | `did_not_found` / `anchor_not_found` | unknown DID/anchor |
| 409 | `idempotency_conflict` | same `Idempotency-Key`, different body |
| 410 | `did_deactivated` | DID revoked |
| 422 | `unanchorable` | can't map to a valid `recordAnchor` |
| 429 | `rate_limited` | over rate/quota; `Retry-After` set |
| 502 | `anchor_failed` | chain submit reverted (`detail` has revert reason) |
| 503 | `chain_unavailable` | RPC/validator degraded — safe to retry (idempotent) |

---

## 8. Rate limits & SLA (targets — 🔴 finalize at GA)

- Per-tenant token bucket; response headers `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`. Proposed defaults: `anchor:write` 50 rps burst 100; reads 200 rps.
- SLA targets: 99.9% Gateway availability; anchor confirm p95 < 3 s (bounded by QBFT block
  time); resolve p95 < 150 ms (cached). Numbers finalized in the Gapura↔HARA SLA at GA.

---

## 9. What HARA must stand up (🔴 provisioning checklist)

So Gapura has real creds to build against, these are HARA-side actions (not something the SDK
can create):

1. **Deploy the Gapura Gateway** (staging first) — HARA-operated, `ANCHOR_ROLE` key + ML-DSA-65
   key from Vault, Postgres metadata/idempotency store.
2. **Sandbox environment** — `https://gapura.sandbox.haratrust.io/v1`, pointing at a **separate
   staging `PQAnchorRegistry` instance** (so sandbox anchors never pollute prod's 3,300+
   anchors). Seed a `gapura-sandbox` tenant + a handful of test object DIDs.
3. **Authentik app + client-credentials** for `gapura-backend` (staging + prod) with the five
   scopes; hand Gapura the client id/secret out-of-band.
4. **Register the `did:hara` sub-namespaces** (`obj:`, `authority:`, `surveyor-id`, actor) in
   the method spec + resolver — the alignment item from [§4](#4-identity-numira-id-didhara).
5. **Webhook onboarding** — endpoint registration + per-tenant signing secret.
6. **Metering backend** (later pass) — chain-log indexer for anchor counts, Numira resolution
   log feed, Gapura verification reporting hook.

**Sandbox creds are provisioned by HARA (items 2–3, 5) — they can't be generated from the SDK.**
Once the Gateway staging is up, HARA hands Gapura: sandbox base URL, Authentik client
id/secret, a webhook secret, and seed test DIDs.

---

## 10. Answers to your specific asks (quick index)

| You asked | Answer |
|---|---|
| Facade/SDK or direct ABI? | **Facade + SDK**, TS *and* Python — [§1](#1-architecture), [§6](#6-sdks-ts--python). |
| Idempotency on anchor | Digest is the key (natural) + `Idempotency-Key` header — [§2](#2-base-urls-versioning-auth). |
| Auth model (svc-to-svc) | OAuth2 client-credentials via **Authentik** (ADR-0018), scoped — [§2](#2-base-urls-versioning-auth). |
| Anchor tx lifecycle | `GET …/status` + signed webhooks; QBFT instant finality; `cost` is gas-free — [§3.3](#33-anchor-tx-lifecycle). |
| Resolve DID | `GET /v1/did/{did}` — [§4.1](#41-resolve-a-did). |
| Issue/register DIDs — where identity lives | HaraDID/Numira; Gateway proxies — [§4.2](#42-issue--register-a-tenant-or-authority-did). |
| DID ↔ Authentik binding | No auto-binding today (DID-SSO deferred); explicit map, Authentik `sub` is the join key — [§4.3](#43-did--authentik-binding). |
| Metering (geometry-blind) | Specified now, built later — [§5](#5-usage-metering-geometry-blind). |
| Sandbox/testnet + creds | To provision; HARA hands them over — [§9](#9-what-hara-must-stand-up). |
| Versioning / rate limits / SLA | [§2](#2-base-urls-versioning-auth), [§8](#8-rate-limits--sla). |
| OpenAPI / JSON-Schema bundle | [`openapi-gapura.yaml`](openapi-gapura.yaml). |

---
*Canonical chain facts: [`hara-registry-facts.md`](hara-registry-facts.md). DID method:
[`../guides/haradid-pathway.md`](../guides/haradid-pathway.md). Contract:
`PQAnchorRegistry 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`, chain 131216.*
