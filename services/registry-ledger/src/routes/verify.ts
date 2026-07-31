/**
 * Verify route (§6). REAL — public, offline-verifiable bundle.
 *   GET /v1/verify?subject=did:hara:passport:…
 *
 * Returns every backing attestation (+ inclusion proof + STH), the relevant
 * checkpoints, and the evidence retention state for a passport DID — so a
 * regulator/auditor can verify without tenant access.
 */

import type { FastifyInstance } from "fastify";
import { sendProblem } from "../errors.js";
import type { LedgerService } from "../services/ledger.js";

const DID_RE = /^did:hara:/;

export function registerVerifyRoutes(
  app: FastifyInstance,
  deps: { ledger: LedgerService },
): void {
  const { ledger } = deps;

  app.get("/v1/verify", async (req, reply) => {
    const { subject } = req.query as { subject?: string };
    if (!subject || !DID_RE.test(subject)) {
      return sendProblem(reply, "invalid_did", "subject must be a did:hara identifier");
    }
    return reply.send(await ledger.verifyBundle(subject));
  });
}
