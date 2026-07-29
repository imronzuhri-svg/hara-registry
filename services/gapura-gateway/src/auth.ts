/**
 * Authentik JWT auth (OAuth2 client-credentials, ADR-0018).
 *
 * REAL: when AUTHENTIK_JWKS_URL/ISSUER/AUDIENCE are set, every request is
 * verified RS256 against the remote JWKS, with issuer + audience checked, and
 * the required per-route scope enforced. `req.tenant` and `req.sub` are set.
 *
 * DEV-BYPASS (clearly marked): when the Authentik env is unset, verification is
 * skipped and the request is treated as tenant `dev` / subject `dev-subject`
 * with all scopes. This is for local dev only — production must set the env.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { config } from "./config.js";
import { sendProblem } from "./errors.js";
import type { Scope } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Authentik tenant (from the `tenant`/`azp`/`client_id` claim). */
    tenant: string;
    /** Authentik subject (`sub`). */
    sub: string;
    /** Scopes granted by the token. */
    scopes: string[];
  }
}

const AUTH_ENABLED =
  !!config.authentik.jwksUrl &&
  !!config.authentik.issuer &&
  !!config.authentik.audience;

// REAL: cached remote JWKS (jose refreshes keys as needed).
const jwks = config.authentik.jwksUrl
  ? createRemoteJWKSet(new URL(config.authentik.jwksUrl))
  : null;

/** Extract scopes from an Authentik token (space-delimited `scope`, or `scp`). */
function scopesFrom(payload: JWTPayload): string[] {
  const raw = (payload["scope"] ?? payload["scp"]) as unknown;
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function tenantFrom(payload: JWTPayload): string {
  return (
    (payload["tenant"] as string | undefined) ??
    (payload["azp"] as string | undefined) ??
    (payload["client_id"] as string | undefined) ??
    "unknown"
  );
}

/**
 * Build a preHandler that authenticates the request and enforces `required`
 * scope. Attach per-route: `{ preHandler: requireScope("anchor:write") }`.
 */
export function requireScope(required: Scope): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // ── DEV-BYPASS ────────────────────────────────────────────────────────
    if (!AUTH_ENABLED) {
      req.tenant = "dev";
      req.sub = "dev-subject";
      req.scopes = [
        "anchor:write",
        "anchor:read",
        "identity:read",
        "identity:write",
        "metering:read",
      ];
      return;
    }

    // ── REAL verification ─────────────────────────────────────────────────
    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) {
      return sendProblem(reply, "unauthenticated", "missing Bearer token");
    }
    const token = header.slice("Bearer ".length).trim();

    let payload: JWTPayload;
    try {
      const res = await jwtVerify(token, jwks!, {
        issuer: config.authentik.issuer,
        audience: config.authentik.audience,
      });
      payload = res.payload;
    } catch (e) {
      return sendProblem(
        reply,
        "unauthenticated",
        `token verification failed: ${(e as Error).message}`,
      );
    }

    const scopes = scopesFrom(payload);
    if (!scopes.includes(required)) {
      return sendProblem(
        reply,
        "forbidden_scope",
        `token lacks required scope '${required}'`,
      );
    }

    req.tenant = tenantFrom(payload);
    req.sub = String(payload.sub ?? "unknown");
    req.scopes = scopes;
  };
}
