# HARA Gapura Gateway

HARA-operated facade that **HARA Gapura** calls. It holds the `ANCHOR_ROLE`
chain key and the ML-DSA-65 PQ signing key (from Vault) and turns hash-anchor
requests into on-chain `PQAnchorRegistry.recordAnchor` calls. Gapura sends
**hashes and DIDs only** — never geometry, never PII.

Contract-first against [`doc/api/gapura-integration-guide.md`](../../doc/api/gapura-integration-guide.md)
and [`doc/api/openapi-gapura.yaml`](../../doc/api/openapi-gapura.yaml).

> **Dual-signature model.** Every anchor is inherently dual-signed: the **ECDSA**
> consensus signature lands the `recordAnchor` tx on-chain (existence + timestamp),
> and an **ML-DSA-65** post-quantum signature whose `keccak256` is committed
> on-chain (`pqSignatureHash`). That hybrid *is* the "dual public anchor" — there
> is **no external second chain** and **no `dualPublicAnchor` flag**.

Chain facts: id **131216**, `gasPrice 0`, legacy (type-0) txs, `PQAnchorRegistry`
`0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`, write RPC
`https://rpc.ledger.haratrust.io/write/`, read RPC `https://rpc.ledger.haratrust.io/read/`.

---

## Run

```bash
cd services/gapura-gateway
npm install
cp .env.example .env      # then fill in (or leave dev defaults)
npm run dev               # tsx watch src/server.ts → listens on :8930
# typecheck only:
npm run typecheck         # tsc --noEmit
```

Out of the box (all dev defaults) the Gateway boots with:
- **DEV-BYPASS auth** (no Authentik env) — every request is tenant `dev` with all scopes.
- **in-memory store** (empty `PG_URL`) — non-persistent.
- **STUB HaraDID** (no resolver URL) — identity routes return placeholder DID docs.
- **anchor writes DISABLED** — `ANCHOR_ECDSA_KEY` / `PQ_MLDSA_SEED` are placeholders,
  so `POST /v1/anchors` returns `502 anchor_failed`. Everything else works.

`GET /healthz` reports `writesEnabled` so you can see whether the keys are wired.

---

## REAL vs STUB / TODO

### REAL (implemented)
- **Anchoring core** (`src/services/anchor-service.ts`) — digest → `canonicalMessage`
  → ML-DSA-65 sign → `pqSignatureHash = keccak256(sig)` → `recordAnchor(merkleRoot=
  sha3Root=digest, blockFrom=blockTo=safe head, eventCount=1, anchorChain=tag from
  purpose|tenant, pqSignatureHash)` → legacy tx (gasPrice 0, chainId 131216) via viem
  wallet to the write RPC → wait for receipt → parse `AnchorRecorded` for `onChainId`
  → persist keyed by digest → return the `Anchor` DTO with `signatures {ecdsa:true,
  mlDsa65:true}`. Natural idempotency: a re-anchor of a known digest returns the
  existing anchor.
- **PQ crypto** (`src/services/pq.ts`) — ML-DSA-65 keygen-from-seed, sign, verify,
  `publicKeyHash = keccak256(pubkey)`, and a `canonicalMessage()` byte-identical to
  the platform `anchor-worker`.
- **Auth** (`src/auth.ts`) — Authentik RS256 JWT verify via remote JWKS, issuer +
  audience check, per-route scope enforcement (real when the Authentik env is set).
- **Errors** (`src/errors.ts`) — RFC 9457 `application/problem+json`, codes per §7.
- **Idempotency-Key** header handling + `409 idempotency_conflict` (`src/routes/anchors.ts`).
- **Verify / status / get** read paths, bindings (`src/routes/*`, in-memory store).
- **In-memory store** (`src/store/memory.ts`) — default, fully working.

### STUB / TODO
- **Anchor writes need Vault keys** — disabled until `ANCHOR_ECDSA_KEY` + `PQ_MLDSA_SEED`
  are real (see below).
- **PQ signature blob storage** — the raw ~3.3 KB ML-DSA-65 sig is **not yet** persisted.
  TODO: PUT it to MinIO bucket `hara-pq-anchors` (mirroring the anchor-worker), so
  `verify()` can re-run the off-chain ML-DSA-65 check. Today `verify()` surfaces the
  stored `pqVerified` flag with this TODO.
- **HaraDID client** (`src/clients/haradid.ts`) — REAL HTTP proxy when
  `HARADID_RESOLVER_URL` is set; STUB placeholder DID docs otherwise.
- **Postgres store** (`src/store/postgres.ts`) — pg-backed skeleton (schema below),
  used only when `PG_URL` is set; not exercised against a live DB.
- **Metering** (`src/routes/metering.ts`) — correct contract shape, **placeholder
  zeros**. TODO: wire chain-log indexer (anchor counts) + Numira resolution logs +
  Gapura verification reports (§9 item 6).
- **DEV-BYPASS auth** — active only when the Authentik env is unset; never in prod.

---

## Vault wiring

Two secrets, injected as env vars at deploy time (never committed):

| Env | Meaning |
|---|---|
| `ANCHOR_ECDSA_KEY` | 0x + 64 hex private key that **holds `ANCHOR_ROLE`** on `PQAnchorRegistry` and is **pre-funded** (Besu drops zero-balance senders even at gasPrice 0). Signs + lands the `recordAnchor` tx. |
| `PQ_MLDSA_SEED` | 0x + 64 hex (32-byte) seed → `ml_dsa65.keygen(seed)`. Its `keccak256(pubkey)` is the PQ key hash frozen into each anchor. |

While either is the `__from_vault__` placeholder, `POST /v1/anchors` returns
`502 anchor_failed`; reads still work.

### ⚠️ Open decision — shared vs Gapura-scoped PQ identity

`PQAnchorRegistry.currentPQKeyHash` is a **single contract-wide value**, and it is
set/rotated by the **platform `anchor-worker`** (it calls `rotatePQKey` on cold
start to match its own seed). Every anchor is frozen against whatever
`currentPQKeyHash` is live at submit time. So the Gapura Gateway has two options:

1. **Reuse the platform PQ identity** — set `PQ_MLDSA_SEED` to the *same* seed the
   anchor-worker uses, so `currentPQKeyHash` matches and Gapura anchors verify
   against the shared key. Couples Gapura to the platform's PQ key rotation.
2. **Gapura-scoped `PQAnchorRegistry` instance** — deploy a separate registry
   whose `currentPQKeyHash` the Gateway controls (its own seed / rotation). Keeps
   Gapura's PQ identity independent and its anchors in a separate id space.

This must be decided before GA. If the Gateway uses a seed whose pubkey hash does
**not** match the live `currentPQKeyHash`, anchors still record, but they will be
tagged with the platform's key hash — not Gapura's — which breaks off-chain PQ
verification against the Gapura pubkey. (The Gateway does **not** call `rotatePQKey`;
that is intentionally left to whoever owns the registry.)

---

## Postgres schema (used when `PG_URL` is set)

Full DDL lives in `src/store/postgres.ts`. Summary:

```sql
CREATE TABLE gapura_anchor (
  anchor_id text PRIMARY KEY, digest text NOT NULL UNIQUE, hash_alg text NOT NULL,
  on_chain_id text, object_did text NOT NULL, purpose text NOT NULL, actor_did text,
  tenant text NOT NULL, tx_hash text, block_number bigint, log_index integer,
  pq_key_hash text NOT NULL, pq_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL, failure_reason text,
  anchored_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gapura_idempotency (
  key text PRIMARY KEY, body_hash text NOT NULL,
  anchor_id text NOT NULL REFERENCES gapura_anchor(anchor_id),
  stored_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gapura_binding (
  authentik_sub text PRIMARY KEY, did text NOT NULL, tenant text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now()
);
```

---

## §9 provisioning checklist (HARA-side, before GA)

1. **Deploy this Gateway** (staging first) with `ANCHOR_ROLE` key + ML-DSA-65 seed
   from Vault and a Postgres metadata/idempotency store.
2. **Sandbox env** `https://gapura.sandbox.haratrust.io/v1` pointing at a **separate
   staging `PQAnchorRegistry`** (so sandbox anchors never pollute prod). Seed a
   `gapura-sandbox` tenant + test object DIDs.
3. **Authentik app + client-credentials** for `gapura-backend` (staging + prod) with
   the five scopes (`anchor:write`, `anchor:read`, `identity:read`, `identity:write`,
   `metering:read`); set `AUTHENTIK_JWKS_URL` / `AUTHENTIK_ISSUER` / `AUTHENTIK_AUDIENCE`.
4. **Register the `did:hara` sub-namespaces** (`obj:`, `authority:`, `surveyor-id`,
   actor) in the method spec + resolver; set `HARADID_RESOLVER_URL`.
5. **Webhook onboarding** — endpoint registration + per-tenant signing secret
   (`anchor.confirmed` / `anchor.failed`; not yet implemented here).
6. **Metering backend** (later pass) — chain-log indexer, Numira resolution feed,
   Gapura verification reporting hook.

---

## Endpoints

| Method | Path | Scope |
|---|---|---|
| POST | `/v1/anchors` | `anchor:write` |
| GET | `/v1/anchors?digest=` | `anchor:read` |
| POST | `/v1/verify` | `anchor:read` |
| GET | `/v1/anchors/:anchorId` | `anchor:read` |
| GET | `/v1/anchors/:anchorId/status` | `anchor:read` |
| GET | `/v1/did/:did` | `identity:read` |
| POST | `/v1/identities` | `identity:write` |
| GET | `/v1/identities/operations/:operationId` | `identity:read` |
| GET | `/v1/identities/by-subject/:authentikSub` | `identity:read` |
| POST | `/v1/identities/:did/bindings` | `identity:write` |
| GET | `/v1/metering/usage` | `metering:read` |
| GET | `/v1/metering/quotas` | `metering:read` |
| GET | `/healthz` | — |
