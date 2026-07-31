/**
 * Evidence + retention routes (§5). REAL — wired to LedgerService.
 *   POST   /v1/evidence                (Numira) register content hash under retention (idempotent)
 *   GET    /v1/evidence/:evidenceId     (public)  retention state
 *   PATCH  /v1/evidence/:evidenceId     (Numira) set/lift hold, extend-only retention
 *   DELETE /v1/evidence/:evidenceId     (Numira) refuse w/ 409 retention_locked while locked (attempt anchored)
 */

import type { FastifyInstance } from "fastify";
import { requireTenant } from "../auth.js";
import { sendProblem } from "../errors.js";
import type { LedgerService } from "../services/ledger.js";
import type { EvidenceRequest } from "../types.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerEvidenceRoutes(
  app: FastifyInstance,
  deps: { ledger: LedgerService },
): void {
  const { ledger } = deps;

  // ── POST /v1/evidence ─────────────────────────────────────────────────────────
  app.post("/v1/evidence", { preHandler: requireTenant }, async (req, reply) => {
    const body = req.body as EvidenceRequest;
    if (!body || typeof body.contentHash !== "string" || !HASH_RE.test(body.contentHash)) {
      return sendProblem(reply, "invalid_hash", "contentHash must be 32-byte 0x-prefixed hex");
    }
    if (!body.retention || typeof body.retention.until !== "string" || !DATE_RE.test(body.retention.until)) {
      return sendProblem(reply, "invalid_request", "retention.until must be YYYY-MM-DD");
    }
    if (typeof body.retention.basis !== "string" || body.retention.basis.length === 0) {
      return sendProblem(reply, "invalid_request", "retention.basis is required");
    }
    const { evidence, alreadyRegistered } = await ledger.registerEvidence(body, req.tenantDid);
    return reply.code(alreadyRegistered ? 200 : 201).send(evidence);
  });

  // ── GET /v1/evidence/:evidenceId (public) ─────────────────────────────────────
  app.get("/v1/evidence/:evidenceId", async (req, reply) => {
    const { evidenceId } = req.params as { evidenceId: string };
    return reply.send(await ledger.getEvidence(evidenceId));
  });

  // ── PATCH /v1/evidence/:evidenceId (tenant-scoped) ────────────────────────────
  app.patch("/v1/evidence/:evidenceId", { preHandler: requireTenant }, async (req, reply) => {
    const { evidenceId } = req.params as { evidenceId: string };
    const body = (req.body ?? {}) as { legalHold?: boolean; extendUntil?: string };
    if (body.legalHold !== undefined && typeof body.legalHold !== "boolean") {
      return sendProblem(reply, "invalid_request", "legalHold must be a boolean");
    }
    if (body.extendUntil !== undefined && !DATE_RE.test(body.extendUntil)) {
      return sendProblem(reply, "invalid_request", "extendUntil must be YYYY-MM-DD");
    }
    if (body.legalHold === undefined && body.extendUntil === undefined) {
      return sendProblem(reply, "invalid_request", "provide legalHold and/or extendUntil");
    }
    return reply.send(await ledger.updateRetention(evidenceId, body, req.tenantDid));
  });

  // ── DELETE /v1/evidence/:evidenceId (tenant-scoped) ───────────────────────────
  app.delete("/v1/evidence/:evidenceId", { preHandler: requireTenant }, async (req, reply) => {
    const { evidenceId } = req.params as { evidenceId: string };
    await ledger.deleteEvidence(evidenceId, req.tenantDid); // throws 409 retention_locked while locked
    return reply.code(204).send();
  });
}
