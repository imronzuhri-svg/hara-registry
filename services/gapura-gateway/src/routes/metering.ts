/**
 * Metering routes (§5) — STUB aggregator.
 *
 * The contract shape is REAL (matches openapi-gapura.yaml), but the numbers are
 * placeholder zeros. TODO: wire the real aggregation backend —
 *   • chain-log indexer  → anchorTxCount / anchorCostUnits
 *   • Numira resolution log feed → numiraIdResolutions / atlasDidMints
 *   • Gapura verification reporting hook → passportVerifications
 * (see §9 item 6 of the integration guide).
 *   GET /v1/metering/usage    scope metering:read
 *   GET /v1/metering/quotas   scope metering:read
 */

import type { FastifyInstance } from "fastify";
import { requireScope } from "../auth.js";
import { sendProblem } from "../errors.js";
import type { Quotas, Usage } from "../types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerMeteringRoutes(app: FastifyInstance): void {
  // ── GET /v1/metering/usage ──────────────────────────────────────────────────
  app.get("/v1/metering/usage", { preHandler: requireScope("metering:read") }, async (req, reply) => {
    const q = req.query as {
      tenant?: string;
      from?: string;
      to?: string;
      granularity?: string;
      metric?: string;
    };
    if (!q.tenant) return sendProblem(reply, "invalid_request", "tenant is required");
    if (!q.from || !DATE_RE.test(q.from) || !q.to || !DATE_RE.test(q.to)) {
      return sendProblem(reply, "invalid_period", "from/to must be YYYY-MM-DD");
    }
    const granularity = q.granularity ?? "total";

    // STUB: zeros until the aggregation backend is built.
    const usage: Usage = {
      tenant: q.tenant,
      period: { from: q.from, to: q.to, granularity },
      metrics: {
        numiraIdResolutions: 0,
        atlasDidMints: 0,
        passportVerifications: 0,
        anchorTxCount: 0,
        anchorCostUnits: 0,
      },
      series: granularity === "day" || granularity === "month" ? [] : undefined,
      quotas: {
        anchorTxCount: { limit: 200000, used: 0, resetsAt: monthStartNext() },
      },
      generatedAt: new Date().toISOString(),
    };
    return reply.send(usage);
  });

  // ── GET /v1/metering/quotas ─────────────────────────────────────────────────
  app.get("/v1/metering/quotas", { preHandler: requireScope("metering:read") }, async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant) return sendProblem(reply, "invalid_request", "tenant is required");

    // STUB shape.
    const quotas: Quotas = {
      tenant,
      quotas: {
        anchorTxCount: { limit: 200000, used: 0, resetsAt: monthStartNext() },
      },
    };
    return reply.send(quotas);
  });
}

function monthStartNext(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}
