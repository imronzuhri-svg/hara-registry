/**
 * Anchor routes (§3). REAL — wired to AnchorService.
 *   POST /v1/anchors                  scope anchor:write   (honors Idempotency-Key)
 *   GET  /v1/anchors?digest=          scope anchor:read    (verify)
 *   POST /v1/verify                   scope anchor:read    (verify-portal form)
 *   GET  /v1/anchors/:id              scope anchor:read
 *   GET  /v1/anchors/:id/status       scope anchor:read
 */

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireScope } from "../auth.js";
import { ProblemError, sendProblem } from "../errors.js";
import type { AnchorService } from "../services/anchor-service.js";
import type { Store } from "../store/index.js";
import type { AnchorRequest, HashAlg } from "../types.js";

const DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;
const DID_RE = /^did:hara:/;

function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

export function registerAnchorRoutes(
  app: FastifyInstance,
  deps: { anchors: AnchorService; store: Store },
): void {
  const { anchors, store } = deps;

  // ── POST /v1/anchors ───────────────────────────────────────────────────────
  app.post("/v1/anchors", { preHandler: requireScope("anchor:write") }, async (req, reply) => {
    const body = req.body as AnchorRequest;

    if (!body || typeof body.digest !== "string" || !DIGEST_RE.test(body.digest)) {
      return sendProblem(reply, "invalid_digest", "digest must be 32-byte 0x-prefixed hex");
    }
    if (typeof body.objectDid !== "string" || !DID_RE.test(body.objectDid)) {
      return sendProblem(reply, "invalid_did", "objectDid must be a did:hara identifier");
    }
    if (typeof body.purpose !== "string" || body.purpose.length === 0) {
      return sendProblem(reply, "invalid_request", "purpose is required");
    }
    if (body.actorDid !== undefined && !DID_RE.test(body.actorDid)) {
      return sendProblem(reply, "invalid_did", "actorDid must be a did:hara identifier");
    }
    const hashAlg: HashAlg = body.hashAlg ?? "sha256";

    // Idempotency-Key (§2b): replay cached response, 409 on same key + different body.
    const idemKey = req.headers["idempotency-key"];
    const key = Array.isArray(idemKey) ? idemKey[0] : idemKey;
    const reqHash = bodyHash(body);
    if (key) {
      const cached = await store.getIdempotency(key);
      if (cached) {
        if (cached.bodyHash !== reqHash) {
          return sendProblem(reply, "idempotency_conflict", "same Idempotency-Key, different body");
        }
        const anchor = await anchors.getAnchor(cached.anchorId);
        return reply.code(200).send(anchor);
      }
    }

    const { anchor, alreadyAnchored } = await anchors.createAnchor({
      digest: body.digest,
      hashAlg,
      objectDid: body.objectDid,
      purpose: body.purpose,
      actorDid: body.actorDid,
      metadata: body.metadata,
      tenant: req.tenant,
    });

    if (key) {
      await store.putIdempotency({
        key,
        bodyHash: reqHash,
        anchorId: anchor.anchorId,
        storedAt: Date.now(),
      });
    }

    return reply.code(alreadyAnchored ? 200 : 201).send(anchor);
  });

  // ── GET /v1/anchors?digest= (verify) ────────────────────────────────────────
  app.get("/v1/anchors", { preHandler: requireScope("anchor:read") }, async (req, reply) => {
    const { digest } = req.query as { digest?: string };
    if (!digest || !DIGEST_RE.test(digest)) {
      return sendProblem(reply, "invalid_digest", "digest query param must be 32-byte 0x-prefixed hex");
    }
    return reply.send(await anchors.verify(digest));
  });

  // ── POST /v1/verify (portal form) ───────────────────────────────────────────
  app.post("/v1/verify", { preHandler: requireScope("anchor:read") }, async (req, reply) => {
    const { digest } = (req.body ?? {}) as { digest?: string };
    if (!digest || !DIGEST_RE.test(digest)) {
      return sendProblem(reply, "invalid_digest", "digest must be 32-byte 0x-prefixed hex");
    }
    return reply.send(await anchors.verify(digest));
  });

  // ── GET /v1/anchors/:anchorId ───────────────────────────────────────────────
  app.get("/v1/anchors/:anchorId", { preHandler: requireScope("anchor:read") }, async (req, reply) => {
    const { anchorId } = req.params as { anchorId: string };
    // status is a sub-path; guard so /status doesn't fall through to here.
    if (anchorId === undefined) throw new ProblemError("anchor_not_found", "missing id");
    return reply.send(await anchors.getAnchor(anchorId));
  });

  // ── GET /v1/anchors/:anchorId/status ────────────────────────────────────────
  app.get("/v1/anchors/:anchorId/status", { preHandler: requireScope("anchor:read") }, async (req, reply) => {
    const { anchorId } = req.params as { anchorId: string };
    return reply.send(await anchors.getStatus(anchorId));
  });
}
