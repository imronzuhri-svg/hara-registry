# Hand-off to Numira / HaraDID — identity for the Aurum ↔ Registry Ledger integration

**From:** HARA Registry team **Re:** the `did:hara` + token pieces the Registry Ledger needs
so HARA Aurum can anchor attestations and verifiers can resolve them.

The Registry Ledger (see [`aurum-ledger-integration-guide.md`](aurum-ledger-integration-guide.md))
is contract-complete and building. Two things are **owned by Numira/HaraDID**, not Registry, and
are on the critical path to GA. This prompt specifies exactly what to deliver.

## 1. Register the `did:hara` sub-namespaces Aurum uses

The method spec (`../guides/haradid-pathway.md`) defines `did:hara:iss:*` (on-chain issuer) and
Sidetree holder suffixes, but **not** the sub-namespaces the Ledger resolves in every proof:

| DID form | Used for | Backing |
|---|---|---|
| `did:hara:tenant:<slug>` | the **issuer/writer** (token subject; write scope) | on-chain issuer (IssuerRegistry) — an operator/tenant org |
| `did:hara:report:<uuid>` | surveyor inspection report (the attestation subject) | Sidetree (record DID) |
| `did:hara:assay:<uuid>` | assay certificate | Sidetree |
| `did:hara:passport:<uuid>` | the passport a bundle of attestations backs (`GET /verify?subject=`) | Sidetree / Atlas-issued |

**Deliver:** register these four sub-namespaces in the `did:hara` method spec + resolver, with
resolution rules (which registry backs each, how to resolve, deactivation semantics), so
`resolve(did)` returns a DID Document for each. Without this, the Ledger's `/verify` bundle and
issuer-authenticity checks can't complete. (This is the same class of item as the Gapura
`obj/authority/surveyor` namespaces — please register both sets together.)

## 2. Numira token for the Ledger (auth)

Aurum authenticates to the Ledger with a **Numira-issued JWT** (pass-through; the Ledger does not
run its own auth). Deliver:

- Issue service/tenant JWTs with:
  - `iss` = Numira, signed with a key published at a **JWKS** URL the Ledger can fetch.
  - `aud` = `attest.ledger.haratrust.io` (the Ledger validates this).
  - a **tenant claim** = the caller's `did:hara:tenant:<slug>` — the Ledger scopes **writes** to it
    (an attestation whose `issuer` ≠ the token tenant is rejected `403 forbidden_tenant`).
  - short TTL; standard `exp`/`iat`.
- Confirm the JWKS endpoint + claim names so the Ledger's verify preHandler can be wired.

Reads of proofs/status are **public** (no token) — only writes need the token.

## 3. Confirm the ownership split (Aurum's open question #1)

Registry's answer, please confirm: **Numira issues credentials; the Registry Ledger owns
status-of-record** (`active | superseded | revoked`). The VC's own signature (`vcProof`) travels
with the attestation and is verifiable offline; its **lifecycle status** is resolved from the
Ledger (`GET /attestations/{id}/status`), where each change is an anchored leaf. If Numira intends
to own status instead, tell us and we'll resolve status by proxying Numira rather than anchoring it.

## 4. (Optional, later) on-chain status registry

There is **no `RevocationRegistry` contract** in the Registry today (only `IssuerRegistry`). The
Ledger's anchored status log is the record of authority and is sufficient. If HaraDID wants an
on-chain status/revocation registry (e.g. StatusList2021 / bitstring), we can add it behind the
same `/status` API without a breaking change — flag if that's on your roadmap.

---
**Summary of asks:** (1) register `did:hara:tenant|report|assay|passport`; (2) issue Numira JWTs
with `aud=attest.ledger.haratrust.io` + tenant-DID claim, expose JWKS; (3) confirm Numira-issues /
Registry-owns-status; (4) tell us if an on-chain status contract is wanted. Items 1–2 are on the
GA critical path. Contact: `ops@haratrust.io`.
