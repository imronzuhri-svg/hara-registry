/**
 * Thin client to the HaraDID resolver/registry.
 *
 * REAL when HARADID_RESOLVER_URL is set: proxies resolve/register over HTTP.
 * STUB when unset: returns a clearly-marked placeholder DID document / operation
 * so identity routes work in dev without a live resolver.
 *
 * Identity onboarding lives in HaraDID / Numira — the Gateway proxies and
 * orchestrates; it does not re-implement the did:hara method (§4).
 */

import { config } from "../config.js";
import type {
  DidResolution,
  IdentityRegistration,
  IdentityRequest,
  Operation,
} from "../types.js";

const RESOLVER = config.haradidResolverUrl;

export class HaraDidClient {
  constructor(private readonly baseUrl: string | undefined = RESOLVER) {}

  get isStub(): boolean {
    return !this.baseUrl;
  }

  /** Resolve a did:hara DID to a W3C DID Resolution result (§4.1). */
  async resolve(did: string): Promise<DidResolution> {
    if (!this.baseUrl) return stubResolution(did);

    // REAL: GET {resolver}/1.0/identifiers/{did} (Universal Resolver shape).
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/1.0/identifiers/${encodeURIComponent(did)}`,
      { headers: { accept: "application/did+ld+json" } },
    );
    if (res.status === 404) throw new DidClientError("did_not_found", did);
    if (res.status === 410) throw new DidClientError("did_deactivated", did);
    if (!res.ok) throw new DidClientError("did_unresolvable", `${res.status}`);
    return (await res.json()) as DidResolution;
  }

  /** Register a tenant/authority DID (§4.2). Delegates to HaraDID/Numira. */
  async register(req: IdentityRequest): Promise<IdentityRegistration | Operation> {
    if (!this.baseUrl) return stubRegistration(req);

    // REAL: POST {resolver}/1.0/register with the caller-supplied public key.
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/1.0/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new DidClientError("did_unresolvable", `register ${res.status}`);
    return (await res.json()) as IdentityRegistration | Operation;
  }

  /** Poll a Sidetree batching operation (§4.2, 202 path). */
  async getOperation(operationId: string): Promise<Operation> {
    if (!this.baseUrl) {
      return { operationId, state: "confirmed", did: `did:hara:actor:stub-${operationId}` };
    }
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/1.0/operations/${encodeURIComponent(operationId)}`,
    );
    if (!res.ok) throw new DidClientError("did_not_found", operationId);
    return (await res.json()) as Operation;
  }
}

export class DidClientError extends Error {
  constructor(
    readonly reason: "did_not_found" | "did_deactivated" | "did_unresolvable",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "DidClientError";
  }
}

// ── STUBs (dev only; clearly marked) ─────────────────────────────────────────

function stubResolution(did: string): DidResolution {
  return {
    didDocument: {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      // STUB verification method — NOT a real key.
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: "JsonWebKey2020",
          controller: did,
          publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "STUB_NO_RESOLVER_CONFIGURED" },
        },
      ],
      service: [],
    },
    didResolutionMetadata: {
      contentType: "application/did+ld+json",
      retrieved: new Date().toISOString(),
      note: "STUB — HARADID_RESOLVER_URL unset; not a real resolution",
    },
    didDocumentMetadata: {
      anchored: false,
      deactivated: false,
      backing: did.includes(":authority:") ? "on-chain-issuer" : "sidetree",
    },
  };
}

function stubRegistration(req: IdentityRequest): IdentityRegistration {
  const ns = req.namespaceHint ?? "actor";
  const slug = req.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
  return {
    did: `did:hara:${ns}:stub-${slug}`,
    didDocument: { id: `did:hara:${ns}:stub-${slug}`, note: "STUB registration" },
    registration: {
      backing: req.subjectType === "actor" ? "sidetree" : "on-chain-issuer",
      state: "confirmed",
    },
  };
}
