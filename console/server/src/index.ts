import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import {
  getChain,
  getValidators,
  getAccounts,
  getRpcTier,
  getServices,
  getVault,
  getAlerts,
  getBackups,
} from "./sources.js";
import { buildProposal } from "./proposals.js";
import { recordProposal, readAudit } from "./audit.js";
import { getRange, getAnomalies, SERIES } from "./metrics.js";
import { createSilence, listSilences, deleteSilence } from "./alerts.js";
import { getInsights } from "./insights.js";
import { askCopilot } from "./copilot.js";

// Each section is wrapped so one unreachable source (e.g. an internal mesh
// service in dev) reports {available:false} instead of failing the whole page.
type Section<T> = { available: true; data: T } | { available: false; error: string };

async function safe<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, data: await fn() };
  } catch (e) {
    return { available: false, error: (e as Error).message };
  }
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: config.corsOrigin });

app.get("/healthz", async () => ({ ok: true }));

app.get("/api/overview", async () => {
  const [chain, validators, accounts, rpcTier, services, vault, alerts, backups] = await Promise.all([
    safe(getChain),
    safe(getValidators),
    safe(getAccounts),
    safe(getRpcTier),
    safe(getServices),
    safe(getVault),
    safe(getAlerts),
    safe(getBackups),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    chain,
    validators,
    accounts,
    rpcTier,
    services,
    vault,
    alerts,
    backups,
  };
});

// ── P1 assisted-ops (PROPOSE-ONLY) ───────────────────────────────────────────
// Build the exact command for a privileged action + audit it. Never executes or
// signs. The operator runs the returned command with the appropriate key.
app.post("/api/propose/:kind", async (req, reply) => {
  const kind = (req.params as { kind: string }).kind;
  const params = (req.body ?? {}) as Record<string, unknown>;
  let proposal;
  try {
    proposal = buildProposal(kind, params);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const actor =
    (req.headers["x-console-actor"] as string) ||
    (req.headers["authorization"] ? "hara (basic-auth)" : "anonymous");
  await recordProposal({
    ts: new Date().toISOString(),
    actor,
    kind: proposal.kind,
    summary: proposal.summary,
    risk: proposal.risk,
    params,
    commands: proposal.commands,
  });
  return proposal;
});

app.get("/api/audit", async (req) => {
  const limit = Number((req.query as { limit?: string }).limit ?? 100);
  return { entries: await readAudit(limit) };
});

// ── Time-series + anomalies ──────────────────────────────────────────────────
app.get("/api/metrics/series", async () =>
  Object.entries(SERIES).map(([name, d]) => ({ name, unit: d.unit, label: d.label }))
);

app.get("/api/metrics/range", async (req, reply) => {
  const q = req.query as { series?: string; minutes?: string };
  if (!q.series) return reply.code(400).send({ error: "series required" });
  try {
    return await getRange(q.series, Number(q.minutes ?? 60), Date.now());
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get("/api/anomalies", async () => ({ generatedAt: new Date().toISOString(), anomalies: await getAnomalies(Date.now()) }));

// Intelligence — Phase 1 (reliability) + Phase 2 (optimisation), read-only.
app.get("/api/insights", async () => getInsights(Date.now()));

// Phase 4 — operator copilot (read-only, grounded). 503 if no COPILOT_API_KEY.
app.get("/api/copilot/status", async () => ({ configured: !!process.env.COPILOT_API_KEY }));
app.post("/api/copilot", async (req, reply) => {
  const q = ((req.body ?? {}) as { question?: string }).question;
  if (!q || !q.trim()) return reply.code(400).send({ error: "question required" });
  try {
    return await askCopilot(q.trim(), Date.now());
  } catch (e) {
    const msg = (e as Error).message;
    return reply.code(msg.includes("not configured") ? 503 : 502).send({ error: msg });
  }
});

// ── Alert silences (acknowledge / ignore) ───────────────────────────────────
app.get("/api/alerts/silences", async () => ({ silences: await listSilences() }));

app.post("/api/alerts/silence", async (req, reply) => {
  const b = (req.body ?? {}) as { alertname?: string; hours?: number; comment?: string };
  if (!b.alertname) return reply.code(400).send({ error: "alertname required" });
  const createdBy = (req.headers["x-console-actor"] as string) || "hara (console)";
  try {
    return await createSilence({ alertname: b.alertname, hours: Number(b.hours ?? 1), createdBy, comment: b.comment ?? "" });
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app.delete("/api/alerts/silence/:id", async (req, reply) => {
  try {
    await deleteSilence((req.params as { id: string }).id);
    return { ok: true };
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((addr) => app.log.info(`Strata Console API listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
