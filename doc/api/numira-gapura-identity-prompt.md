# Prompt — Numira / HaraDID team: Gapura identity integration

*(Hand this to the Numira/HaraDID session or team. It's self-contained.)*

---

You are working on **Numira ID / HaraDID** — the `did:hara` identity layer of HARA. **HARA
Gapura** (EUDR market-access, ADR-0019) is integrating with HARA Registry through a
HARA-operated **Gapura Gateway** facade. The Gateway does the *anchoring* itself, but for
**identity it proxies to you**. We need you to close the identity gaps so the Gateway's
`/v1/did/*` and `/v1/identities/*` endpoints resolve.

**Context you can rely on**
- The `did:hara` method is already specified (issuer DIDs on-chain via `IssuerRegistry`;
  holder DIDs via Sidetree + a resolver service). Chain id `131216`.
- Gapura sends **DIDs and hashes only** — never geometry, never PII.
- SSO is **Authentik** (ADR-0018); **Numira DID-SSO was deferred**.
- The Gateway's identity **contract is fixed** in `doc/api/openapi-gapura.yaml`
  (schemas `DidResolution`, `IdentityRequest`, `IdentityRegistration`, `Operation`, `Binding`)
  and described in `doc/api/gapura-integration-guide.md` §4. Keep responses matching those
  shapes so the Gateway can pass them through.

**Deliver these six things:**

1. **Register the new `did:hara` sub-namespaces.** Gapura uses DIDs the current method spec
   doesn't define (it only has `did:hara:iss:<chain>:<id>` and Sidetree suffixes):
   - `did:hara:obj:<mapPassportId>` — Map Passport objects / credentials (the anchor subjects)
   - `did:hara:authority:<id>` — authority orgs & regulators, e.g. `did:hara:authority:big`
   - `did:hara:surveyor-id` / actor DIDs — field surveyors, authority staff
   For each: which registry backs it (on-chain `IssuerRegistry` vs Sidetree holder), the
   identifier grammar, and resolution rules. Update the method spec
   (`doc/guides/haradid-pathway.md` §3.2–3.3) via PR.

2. **Expose a stable Resolver HTTP endpoint** the Gateway calls server-to-server. Prefer the
   W3C DID Resolution HTTP binding: `GET {resolverBase}/1.0/identifiers/{did}` →
   `{ didDocument, didResolutionMetadata, didDocumentMetadata }`, where
   `didDocumentMetadata` includes `anchored, created, updated, deactivated,
   backing (on-chain-issuer | sidetree)`. Give us the **staging and prod** base URLs and the
   **auth** the resolver expects (mesh-internal only, mTLS, or a token).

3. **Decide where identity onboarding lives** — pick one and tell us:
   - (a) Onboarding stays in Numira; the Gateway's `POST /v1/identities` just **forwards** to a
     Numira registration API — give us that endpoint + payload; or
   - (b) Numira exposes no write API (operator-driven onboarding) and the Gateway **drops
     `identity:write`**, resolve-only.
   For issuer/authority DIDs (on-chain, synchronous) vs actor/holder DIDs (Sidetree-batched,
   async), confirm the sync-vs-`202 + operationId` behaviour and the operation-status endpoint.

4. **Confirm the DID ↔ Authentik binding model.** Because DID-SSO is deferred there is **no
   automatic binding today**. The Gateway will keep an explicit `{ authentikSub ↔ did, tenant }`
   map (the Authentik JWT `sub` is the join key), created at tenant onboarding. Confirm that's
   acceptable, and sketch the future path (when Numira DID-SSO ships, the DID becomes a
   first-class token claim and the map is retired). If Numira **already** has any subject↔DID
   mapping, tell us so we don't duplicate it.

5. **Revocation signal.** How does the Gateway learn a DID was deactivated/revoked —
   `RevocationRegistry` event, or `deactivated: true` in resolver metadata? We surface
   `410 did_deactivated`. Specify the source of truth and a recommended cache TTL.

6. **HARA-side actions you need.** List anything that requires the HARA Registry operator —
   e.g. `IssuerRegistry` role grants for new authority DIDs, a contract deploy, or a mesh peer
   for the resolver.

**Constraints:** DIDs/hashes only, no PII. Keep the resolver response W3C-compliant so the
Gateway passes it through untouched.

**Return:** the namespace spec + method-spec PR; resolver (and optional registration) endpoint
URLs for staging/prod with their auth model; the onboarding-ownership decision; the
binding-model confirmation; the revocation signal; and the list of HARA-side actions.
