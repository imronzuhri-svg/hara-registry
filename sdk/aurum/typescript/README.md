# @hara/registry-ledger-sdk

TypeScript client **and standalone RFC 6962 Merkle verifier** for the
**HARA Registry Ledger** (the credential-ledger role behind HARA Aurum).

The Registry Ledger anchors attestations (VC/record hashes) and event-chain
checkpoints into a per-tenant **RFC 6962/9162 Merkle transparency log** whose
tree heads are committed on-chain via a Ledger-scoped `PQAnchorRegistry`
(chain `131216`, hybrid ECDSA + ML-DSA-65). It serves offline-verifiable
inclusion + consistency proofs, status-of-record, and retention-of-record.

- **Contract-first.** Source of truth: [`openapi-aurum-ledger.yaml`](../../../doc/api/openapi-aurum-ledger.yaml)
  and the [integration guide](../../../doc/api/aurum-ledger-integration-guide.md).
- **Only hashes and DIDs cross the seam** — never tenant payloads.
- **ESM, Node 18+, zero runtime dependencies** (uses global `fetch` and
  `node:crypto`). `typescript` is the only devDependency.

## Install

```bash
npm install @hara/registry-ledger-sdk
```

Node 18+ (global `fetch`, `crypto.randomUUID`). ESM only (`"type": "module"`).

## Auth (Numira token, pass-through)

Writes are **tenant-scoped** from a Numira-issued JWT (carrying the tenant DID
`did:hara:tenant:*`); the SDK attaches `Authorization: Bearer <numira-jwt>`.
**Reads of proofs and status are public** and need no token. Numira issues the
token elsewhere — this SDK is pure pass-through, no OAuth flow.

```ts
import { RegistryLedger, TokenAuth } from '@hara/registry-ledger-sdk';

// Static token…
const led = new RegistryLedger({
  baseUrl: 'https://attest.ledger.haratrust.io/v1',
  token: process.env.NUMIRA_JWT,
});

// …or a getter that refreshes/rotates the token per request:
const led2 = new RegistryLedger({
  baseUrl: 'https://attest.ledger.haratrust.io/v1',
  token: async () => await getFreshNumiraJwt(),
});

// A public, read-only client needs no token:
const publicLed = new RegistryLedger({ baseUrl: 'https://attest.ledger.haratrust.io/v1' });
```

## Quickstart: anchor → verify offline → verify bundle

```ts
import {
  RegistryLedger,
  verifyInclusion,
  verifySthAnchored,
} from '@hara/registry-ledger-sdk';

const led = new RegistryLedger({
  baseUrl: 'https://attest.ledger.haratrust.io/v1',
  token: process.env.NUMIRA_JWT,
});

// 1. Anchor a signed record's hash (payload stays in your tenant store).
//    Idempotent on contentHash — same hash returns the same registry_id (200).
const att = await led.anchor({
  subject: 'did:hara:report:7f3a9c21-4e88',
  issuer: 'did:hara:tenant:surveyor-psi',
  recordType: 'surveyor-report',
  contentHash: '0x' + '…', // sha256 of the canonical signed record
});

// 2. Verify inclusion OFFLINE — no call back to the Ledger.
const ok = verifyInclusion(
  att.log!.leaf_hash!,       // the leaf hash (SHA256(0x00 || leaf_data))
  att.inclusion_proof!,      // { leaf_index, tree_size, audit_path }
  att.sth!.root_hash,        // the anchored STH root
);
console.log('inclusion verified offline:', ok);

// 2b. (optional) confirm the STH root is the value anchored on-chain.
const anchored = await verifySthAnchored(att.sth!, {
  rpcReadUrl: 'https://rpc.ledger.haratrust.io',
});

// 3. Revoke / supersede (tenant-scoped, attributed, itself anchored).
await led.setStatus(att.registry_id, 'revoke', { reason: 'licence withdrawn' });

// 4. Public verification bundle for a passport (offline-verifiable).
const bundle = await led.verifyBundle('did:hara:passport:…');
for (const a of bundle.attestations ?? []) {
  // Resolve the leaf hash for the entry (or reuse the one you anchored).
  const rec = await publicLed.getAttestation(a.registry_id!);
  const good = verifyInclusion(rec.log!.leaf_hash!, a.inclusion_proof!, a.sth!.root_hash);
  console.log(a.registry_id, a.status, 'verified:', good);
}
```

> A `verifyBundle` entry carries the `inclusion_proof` and `sth` but not the leaf
> hash; resolve it via `getAttestation(registry_id)` (`.log.leaf_hash`) or reuse
> the leaf you originally anchored.

## The offline-verification story

The whole point of a transparency log is that **anyone** — a regulator or
auditor with no tenant access — can verify the evidence behind a passport
**without trusting (or even contacting) the Ledger**:

- `verifyInclusion(leafHash, proof, root)` reconstructs the tree root from the
  audit path per **RFC 6962 §2.1.1** and compares it to the STH root.
- `verifyConsistency(first, second, path)` confirms the later tree **extends**
  the earlier one per **RFC 6962 §2.1.2** — a **rewritten chain fails**.
- Both are **pure, dependency-free, no network** (SHA-256 via `node:crypto`).
- `verifySthAnchored(sth, { rpcReadUrl })` is the one optional network step: a
  read-only `eth_call` of `anchors(onChainId)` on the STH's `PQAnchorRegistry`
  contract, confirming the on-chain `merkleRoot` === `sth.root_hash` and
  `eventCount` === `sth.tree_size`.

RFC 6962 hashing rules (implemented exactly):

```
leaf hash = SHA256( 0x00 || leaf_data )
node hash = SHA256( 0x01 || left || right )
```

```ts
import {
  verifyInclusion,
  verifyConsistency,
  leafHash,
  nodeHash,
  hexToBytes,
  bytesToHex,
} from '@hara/registry-ledger-sdk';

// Consistency: prove tree `to` extends tree `from` (no rewrite).
const cp = await led.getConsistency('tenant:surveyor-psi:events', 90000, 90210);
const consistent = verifyConsistency(cp.first, cp.second, cp.consistency_path);
```

Hashes are accepted as either `0x`-hex strings or `Uint8Array`.

## API surface

| Area | Method |
|---|---|
| attestations | `anchor(req, { idempotencyKey? })` · `getAttestation(id)` · `getProof(id, treeSize?)` · `getStatus(id)` · `setStatus(id, 'revoke'\|'supersede', { reason, supersededBy? })` |
| checkpoints | `submitCheckpoint(req)` · `getConsistency(logId, from, to)` |
| evidence | `registerEvidence(req)` · `getEvidence(id)` · `updateRetention(id, { legalHold?, extendUntil? })` · `deleteEvidence(id)` |
| verify | `verifyBundle(subjectDid)` |
| verifier (standalone) | `verifyInclusion` · `verifyConsistency` · `verifySthAnchored` · `leafHash` · `nodeHash` · hex helpers |

`anchor` auto-generates an `Idempotency-Key` (`crypto.randomUUID()`) when none is
given. The client parses `application/problem+json` into a `ProblemError`
(RFC 9457 fields: `type/title/status/code/detail/instance/traceId` + raw
`problem`), and retries `429` (honoring `Retry-After`) and `503` with
exponential backoff (max 3 attempts).

```ts
import { isProblem } from '@hara/registry-ledger-sdk';
try {
  await led.deleteEvidence('ev:9c21');
} catch (e) {
  if (isProblem(e) && e.code === 'retention_locked') {
    // refused while under retention/hold — the attempt was itself anchored.
  }
}
```

## Build & test

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # builds, then runs the RFC 6962 verifier self-test
```

The self-test (`scripts/selftest.mjs`) builds reference RFC 6962 trees with an
independent implementation, generates real inclusion and consistency proofs, and
asserts the verifier accepts valid proofs and rejects tampered ones (flipped
roots, mutated audit paths, rewritten history).

## License

Apache-2.0
