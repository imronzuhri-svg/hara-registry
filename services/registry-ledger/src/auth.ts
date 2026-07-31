/**
 * Numira JWT auth (bearer, tenant-DID scoped).
 *
 * REAL: when NUMIRA_JWKS_URL/ISSUER are set, every write request is verified
 * RS256 against the remote JWKS, with issuer + audience (`attest.ledger.haratrust.io`)
 * checked. The token carries the tenant DID (`did:hara:tenant:*`); we extract it
 * and set `req.tenantDid`. Writes are tenant-scoped from that DID — a route that
 * writes on behalf of a different issuer/tenant must be rejected with
 * 403 forbidden_tenant (enforced in the route via `enforceTenant`).
 *
 * DEV-BYPASS (clearly marked): when the Numira env is unset, verification is
 * skipped and the request is treated as tenant `did:hara:tenant:dev`. Dev only —
 * production must set the env.
 *
 * Proof/status reads are PUBLIC (no token) — this preHandler is attached only to
 * the write routes.
 *
 * Modelled on services/gapura-gateway/src/auth.ts.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { config } from "./config.js";
import { ProblemError, sendProblem } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The tenant DID (`did:hara:tenant:*`) from the Numira token. */
    tenantDid: string;
    /** The token subject (`sub`). */
    sub: string;
  }
}

const AUTH_ENABLED = !!config.numira.jwksUrl && !!config.numira.issuer;

// REAL: cached remote JWKS (jose refreshes keys as needed).
const jwks = config.numira.jwksUrl ? createRemoteJWKSet(new URL(config.numira.jwksUrl)) : null;

const TENANT_DID_RE = /^did:hara:tenant:/;

/** Extract the tenant DID claim. Numira may carry it as `tenant`, `did`, or `sub`. */
function tenantDidFrom(payload: JWTPayload): string | undefined {
  const candidates = [payload["tenant"], payload["did"], payload.sub];
  for (const c of candidates) {
    if (typeof c === "string" && TENANT_DID_RE.test(c)) return c;
  }
  return undefined;
}

/**
 * preHandler that authenticates a WRITE request and sets `req.tenantDid` + `req.sub`.
 * Attach to tenant-scoped routes: `{ preHandler: requireTenant }`.
 */
export const requireTenant: preHandlerHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  // ── DEV-BYPASS ──────────────────────────────────────────────────────────────
  if (!AUTH_ENABLED) {
    req.tenantDid = "did:hara:tenant:dev";
    req.sub = "did:hara:tenant:dev";
    return;
  }

  // ── REAL verification ─────────────────────────────────────────────────────────
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return sendProblem(reply, "unauthenticated", "missing Bearer token");
  }
  const token = header.slice("Bearer ".length).trim();

  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, jwks!, {
      issuer: config.numira.issuer,
      audience: config.numira.audience,
    });
    payload = res.payload;
  } catch (e) {
    return sendProblem(reply, "unauthenticated", `token verification failed: ${(e as Error).message}`);
  }

  const tenantDid = tenantDidFrom(payload);
  if (!tenantDid) {
    return sendProblem(reply, "unauthenticated", "token carries no did:hara:tenant claim");
  }
  req.tenantDid = tenantDid;
  req.sub = String(payload.sub ?? tenantDid);
};

/**
 * Enforce tenant-scoping: the resource's issuer/tenant must match the token's
 * tenant DID, else 403 forbidden_tenant. Call from write handlers.
 */
export function enforceTenant(req: FastifyRequest, resourceTenantDid: string): void {
  if (req.tenantDid !== resourceTenantDid) {
    throw new ProblemError(
      "forbidden_tenant",
      `token tenant ${req.tenantDid} may not write for ${resourceTenantDid}`,
    );
  }
}
