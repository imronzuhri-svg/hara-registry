/**
 * Checkpoint routes (§4). REAL — wired to LedgerService.
 *   POST /v1/anchors                          (Numira) submit checkpoint (root+size) → anchored STH
 *   GET  /v1/anchors/consistency               (public)  RFC 6962 consistency proof (?log_id=&from=&to=)
 */

import type { FastifyInstance } from "fastify";
import { requireTenant } from "../auth.js";
import { sendProblem } from "../errors.js";
import type { LedgerService } from "../services/ledger.js";
import type { CheckpointRequest } from "../types.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function registerCheckpointRoutes(
  app: FastifyInstance,
  deps: { ledger: LedgerService },
): void {
  const { ledger } = deps;

  // ── POST /v1/anchors ──────────────────────────────────────────────────────────
  app.post("/v1/anchors", { preHandler: requireTenant }, async (req, reply) => {
    const body = req.body as CheckpointRequest;
    if (!body || typeof body.log_id !== "string" || body.log_id.length === 0) {
      return sendProblem(reply, "invalid_request", "log_id is required");
    }
    if (typeof body.root_hash !== "string" || !HASH_RE.test(body.root_hash)) {
      return sendProblem(reply, "invalid_hash", "root_hash must be 32-byte 0x-prefixed hex");
    }
    if (!Number.isInteger(body.tree_size) || body.tree_size < 1) {
      return sendProblem(reply, "invalid_request", "tree_size must be a positive integer");
    }
    const checkpoint = await ledger.submitCheckpoint(body.log_id, body.tree_size, body.root_hash);
    return reply.code(201).send(checkpoint);
  });

  // ── GET /v1/anchors/consistency (public) ──────────────────────────────────────
  app.get("/v1/anchors/consistency", async (req, reply) => {
    const q = req.query as { log_id?: string; from?: string; to?: string };
    if (!q.log_id) return sendProblem(reply, "invalid_request", "log_id is required");
    const from = Number(q.from);
    const to = Number(q.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      return sendProblem(reply, "invalid_request", "from/to must be positive integers");
    }
    return reply.send(await ledger.getConsistency(q.log_id, from, to));
  });
}
