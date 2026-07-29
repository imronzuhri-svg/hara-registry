# hara-gapura

Python client SDK for the **HARA Gapura Gateway** — the HARA-operated facade over
`PQAnchorRegistry` (chain 131216). It covers **anchoring** (hashes only),
**identity** (`did:hara` / Numira), and geometry-blind **usage metering**.

Gapura sends **hashes and DIDs only** — never geometry, never PII. The Gateway
holds the `ANCHOR_ROLE` chain key and the ML-DSA-65 post-quantum key; every anchor
is inherently **dual-signed** (hybrid ECDSA + ML-DSA-65) — there is no external
chain and no flag to set.

- Distribution: `hara-gapura` · import package: `hara_gapura` · version `0.1.0`
- Python 3.10+ · sync HTTP via `requests` · fully type-hinted (ships `py.typed`)
- Contract: [`openapi-gapura.yaml`](../../../doc/api/openapi-gapura.yaml),
  [integration guide](../../../doc/api/gapura-integration-guide.md)

## Install

```bash
pip install hara-gapura
# from source:
pip install -e .
```

## Quickstart

```python
from hara_gapura import GapuraClient, ClientCredentialsAuth

auth = ClientCredentialsAuth(
    client_id="gapura-backend",
    client_secret="...",           # from Authentik, out-of-band
    scope=["anchor:write", "anchor:read", "identity:read", "metering:read"],
)
gap = GapuraClient("https://gapura.ledger.haratrust.io/v1", auth=auth)

# Anchor a digest (idempotency key auto-generated; safe to retry)
anchor = gap.anchors.create(
    digest="0x9b2c...",
    hash_alg="sha256",
    object_did="did:hara:obj:mp:8f3a...",
    purpose="map-passport",
)
print(anchor["anchorId"], anchor["status"], anchor["signatures"])  # {'ecdsa': True, 'mlDsa65': True}

# Verify a digest
res = gap.anchors.verify(digest="0x9b2c...", hash_alg="sha256")
if not res["anchored"]:
    ...  # not on the ledger

# Anchor tx lifecycle
status = gap.anchors.status(anchor["anchorId"])  # pending | confirmed | failed

# Identity
doc = gap.identity.resolve("did:hara:authority:big")
binding = gap.identity.binding_by_subject("ak_9f3c...")

# Metering
usage = gap.metering.usage(
    tenant="gapura", from_="2026-06-01", to="2026-06-30", granularity="day"
)
quotas = gap.metering.quotas("gapura")
```

## Auth

Service-to-service auth is **OAuth2 client-credentials via Authentik** (ADR-0018).
`ClientCredentialsAuth` exchanges the client id/secret for a short-lived JWT,
caches it, and refreshes ~30s before expiry. Scopes gate each domain:
`anchor:write`, `anchor:read`, `identity:read`, `identity:write`, `metering:read`.

If you already hold a token, use `StaticTokenAuth(token)`. Any object with an
`auth_header() -> str` method satisfies the `AuthProvider` protocol.

## Error handling

Every non-2xx response raises `ProblemError`, populated from the RFC 9457
`application/problem+json` body. Branch on the stable `code`, not `detail`:

```python
from hara_gapura import ProblemError

try:
    gap.anchors.create(digest="not-hex", hash_alg="sha256",
                        object_did="did:hara:obj:mp:1", purpose="map-passport")
except ProblemError as e:
    print(e.status, e.code, e.detail, e.trace_id)
    if e.code == "invalid_digest":
        ...
```

The client retries `429` (respecting `Retry-After`) and `503` with exponential
backoff, up to 3 attempts.
