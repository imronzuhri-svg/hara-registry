/**
 * Health route. REAL. Unauthenticated liveness probe.
 *   GET /healthz
 */

import type { FastifyInstance } from "fastify";
import type { AnchorService } from "../services/anchor-service.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { anchors: AnchorService },
): void {
  app.get("/healthz", async () => {
    return {
      ok: true,
      service: "gapura-gateway",
      // Surfaces whether the anchor write path is Vault-wired (keys present).
      writesEnabled: deps.anchors.writesEnabled,
      time: new Date().toISOString(),
    };
  });
}
