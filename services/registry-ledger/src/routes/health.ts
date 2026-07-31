/**
 * Health route. REAL. Unauthenticated liveness probe.
 *   GET /healthz
 */

import type { FastifyInstance } from "fastify";
import type { AnchorService } from "../services/anchor.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { anchors: AnchorService },
): void {
  app.get("/healthz", async () => {
    return {
      ok: true,
      service: "registry-ledger",
      // Surfaces whether the on-chain anchor path is Vault-wired + Ledger-scoped.
      writesEnabled: deps.anchors.writesEnabled,
      pqKeyHash: deps.anchors.pqKeyHash,
      time: new Date().toISOString(),
    };
  });
}
