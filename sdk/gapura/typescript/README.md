# @hara/gapura-sdk

TypeScript client SDK for the **HARA Gapura Gateway** — anchoring (hashes only),
identity (`did:hara` / Numira), and geometry-blind usage metering.

> This SDK targets the **Gateway**, not the chain. The Gateway is a HARA-operated
> facade over `PQAnchorRegistry` (chain 131216); it holds the `ANCHOR_ROLE` chain
> key and the ML-DSA-65 PQ signing key. You send **hashes and DIDs only** — never
> geometry, never PII, and never a chain key.

Every anchor is inherently **dual-signed** — a hybrid **ECDSA** (on-chain existence
+ timestamp) plus an **ML-DSA-65** post-quantum signature. That hybrid *is* the dual
proof; there is no external second chain and no flag to set.

- ESM, Node 18+ (uses the global `fetch`).
- Zero runtime dependencies.

## Install

```sh
npm install @hara/gapura-sdk
```

## Auth setup

Service-to-service auth is OAuth2 **client-credentials via Authentik** (ADR-0018).
`ClientCredentialsAuth` exchanges your client id/secret for a short-lived JWT,
caches it, and refreshes ~30s before expiry.

```ts
import { GapuraClient, ClientCredentialsAuth } from '@hara/gapura-sdk';

const auth = new ClientCredentialsAuth({
  tokenUrl: 'https://auth.haratrust.io/application/o/token/',
  clientId: 'gapura-backend',
  clientSecret: process.env.GAPURA_CLIENT_SECRET!,
  scopes: ['anchor:write', 'anchor:read', 'identity:read', 'metering:read'],
});

const gap = new GapuraClient({
  baseUrl: 'https://gapura.ledger.haratrust.io/v1',
  auth,
});
```

Only the Gapura backend should hold an `anchor:write` token — never ship one to a
browser. Consoles call your backend, which calls this SDK.

## Quickstart

### Anchor a digest

`anchors.create` is safe to retry: if you don't pass an `idempotencyKey`, one is
generated with `crypto.randomUUID()`. Anchoring an already-anchored digest returns
the existing anchor (`200`).

```ts
const anchor = await gap.anchors.create({
  digest: '0x9b2c...',            // 32-byte hex, hashes only
  hashAlg: 'sha256',
  objectDid: 'did:hara:obj:mp:8f3a...',
  purpose: 'map-passport',
});

console.log(anchor.anchorId, anchor.status);          // e.g. gap_anc_01HZX... confirmed
console.log(anchor.signatures);                        // { ecdsa: true, mlDsa65: true }
```

### Verify a digest

```ts
const res = await gap.anchors.verify({ digest: '0x9b2c...', hashAlg: 'sha256' });
if (!res.anchored) {
  // not on the ledger
} else {
  const v = res.anchors[0]?.verification;
  console.log(v?.ecdsaOnChain, v?.pqVerified, v?.pqKeyHash);   // the dual/hybrid proof
}
```

### Resolve a DID

```ts
const doc = await gap.identity.resolve('did:hara:authority:big');
console.log(doc.didDocumentMetadata?.backing);        // 'on-chain-issuer' | 'sidetree'
```

### Query usage

```ts
const usage = await gap.metering.usage({
  tenant: 'gapura',
  from: '2026-06-01',
  to: '2026-06-30',
  granularity: 'day',
});
console.log(usage.metrics?.anchorTxCount);
```

## Error handling

Every non-2xx response is an RFC 9457 `application/problem+json`, surfaced as a
typed `ProblemError`.

```ts
import { isProblem } from '@hara/gapura-sdk';

try {
  await gap.anchors.create({ digest: 'not-hex', objectDid, purpose: 'map-passport' });
} catch (err) {
  if (isProblem(err)) {
    console.error(err.code, err.status, err.detail, err.traceId);
    // e.g. invalid_digest 400 "digest must be 32-byte 0x-prefixed hex" 01HZX...
  } else {
    throw err;
  }
}
```

The client automatically retries `429` (respecting `Retry-After`) and `503` with
exponential backoff, up to 3 attempts.

## API surface

- `anchors.create(body, { idempotencyKey? })`, `anchors.get(id)`, `anchors.verify({ digest, hashAlg? })`, `anchors.status(id)`
- `identity.resolve(did)`, `identity.register(body)`, `identity.operation(id)`, `identity.bindingBySubject(sub)`, `identity.createBinding(did, { authentikSub, tenant })`
- `metering.usage({ tenant, from, to, granularity?, metric? })`, `metering.quotas(tenant)`

## Development

```sh
npm install
npm run build        # tsc → dist
npm run typecheck    # tsc --noEmit
```

## License

Apache-2.0
