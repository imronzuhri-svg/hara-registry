import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { dbEnabled, ensureSchema, pruneSessions } from "./db.js";
import { resolveSession, createSession, destroySession, roleAtLeast, type Role, type SessionUser } from "./auth.js";
import { listUsers, createUser, updateUser, deleteUser, login, changeOwnPassword, ensureBootstrapOwner } from "./users.js";
import {
  getChain,
  getValidators,
  getAccounts,
  getRpcTier,
  getServices,
  getVault,
  getAlerts,
  getBackups,
  getBackupsReport,
  getHosts,
} from "./sources.js";
import { buildProposal } from "./proposals.js";
import { recordProposal, readAudit } from "./audit.js";
import { getRange, getHostRange, getAnomalies, SERIES } from "./metrics.js";
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
// credentials:true so the session cookie is accepted cross-origin in dev (in
// prod the SPA + API are same-origin behind Caddy, so it's a no-op).
await app.register(cors, { origin: config.corsOrigin, credentials: true });
await app.register(cookie);

// Make req.user available to handlers.
declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const AUTH = dbEnabled();

if (AUTH) {
  await ensureSchema();
  await ensureBootstrapOwner((m) => app.log.warn(m));
  await pruneSessions();
  app.log.info("user-management ENABLED (Postgres-backed auth + RBAC)");
  // Gate every route behind a valid session except healthz + the login endpoint.
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/healthz" || (req.method === "POST" && path === "/api/auth/login")) return;
    const token = req.cookies[config.session.cookieName];
    const user = await resolveSession(token);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    req.user = user;
  });
} else {
  app.log.warn("user-management DISABLED (no CONSOLE_DATABASE_URL) — API open behind the Caddy/WG gate only");
}

/** Role gate for a handler. Returns false (and sends 403) if not permitted. */
function requireRole(req: { user?: SessionUser }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, min: Role): boolean {
  if (!AUTH) return true; // legacy open mode
  if (!req.user || !roleAtLeast(req.user.role, min)) {
    reply.code(403).send({ error: `requires ${min} role` });
    return false;
  }
  return true;
}

const actorOf = (req: { user?: SessionUser; headers: Record<string, unknown> }): string =>
  req.user?.username ?? (req.headers["x-console-actor"] as string) ?? "anonymous";

app.get("/healthz", async () => ({ ok: true }));

// ── Auth + user management ───────────────────────────────────────────────────
app.post("/api/auth/login", async (req, reply) => {
  if (!AUTH) return reply.code(404).send({ error: "auth not enabled" });
  const b = (req.body ?? {}) as { username?: string; password?: string };
  if (!b.username || !b.password) return reply.code(400).send({ error: "username and password required" });
  const u = await login(b.username, b.password);
  if (!u) return reply.code(401).send({ error: "invalid credentials" });
  const token = await createSession(u.id, String(req.headers["user-agent"] ?? ""));
  reply.setCookie(config.session.cookieName, token, {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: config.session.ttlHours * 3600,
  });
  return { user: u };
});

app.get("/api/auth/me", async (req) => ({ user: req.user ?? null, authEnabled: AUTH }));

app.post("/api/auth/logout", async (req, reply) => {
  await destroySession(req.cookies[config.session.cookieName]);
  reply.clearCookie(config.session.cookieName, { path: "/" });
  return { ok: true };
});

app.post("/api/auth/password", async (req, reply) => {
  if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  const b = (req.body ?? {}) as { current?: string; next?: string };
  if (!b.current || !b.next) return reply.code(400).send({ error: "current and next required" });
  try {
    await changeOwnPassword(req.user.id, b.current, b.next);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

// User CRUD — OWNER only.
app.get("/api/users", async (req, reply) => {
  if (!requireRole(req, reply, "owner")) return;
  return { users: await listUsers() };
});
app.post("/api/users", async (req, reply) => {
  if (!requireRole(req, reply, "owner")) return;
  const b = (req.body ?? {}) as { username?: string; password?: string; role?: string; email?: string };
  try {
    return { user: await createUser({ username: b.username ?? "", password: b.password ?? "", role: b.role ?? "viewer", email: b.email, createdBy: actorOf(req) }) };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});
app.patch("/api/users/:id", async (req, reply) => {
  if (!requireRole(req, reply, "owner")) return;
  const id = Number((req.params as { id: string }).id);
  try {
    return { user: await updateUser(id, (req.body ?? {}) as Record<string, string>, req.user!.id) };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});
app.delete("/api/users/:id", async (req, reply) => {
  if (!requireRole(req, reply, "owner")) return;
  const id = Number((req.params as { id: string }).id);
  try {
    await deleteUser(id, req.user!.id);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get("/api/overview", async () => {
  const [chain, validators, accounts, rpcTier, services, vault, alerts, backups, hosts] = await Promise.all([
    safe(getChain),
    safe(getValidators),
    safe(getAccounts),
    safe(getRpcTier),
    safe(getServices),
    safe(getVault),
    safe(getAlerts),
    safe(getBackups),
    safe(getHosts),
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
    hosts,
  };
});

// ── P1 assisted-ops (PROPOSE-ONLY) ───────────────────────────────────────────
// Build the exact command for a privileged action + audit it. Never executes or
// signs. The operator runs the returned command with the appropriate key.
app.post("/api/propose/:kind", async (req, reply) => {
  if (!requireRole(req, reply, "operator")) return;
  const kind = (req.params as { kind: string }).kind;
  const params = (req.body ?? {}) as Record<string, unknown>;
  let proposal;
  try {
    proposal = buildProposal(kind, params);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const actor = actorOf(req);
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

// Dedicated Backups & DR screen: per-job health (ok/failed/overdue/never),
// run duration, latest artifact size + on-disk age, and a fleet summary.
app.get("/api/backups", async (_req, reply) => {
  try {
    return await getBackupsReport(Date.now());
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
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

// Per-host multi-line time series (disk|mem|cpu) for the Hosts screen.
app.get("/api/metrics/host-range", async (req, reply) => {
  const q = req.query as { metric?: string; minutes?: string };
  if (!q.metric) return reply.code(400).send({ error: "metric required (disk|mem|cpu)" });
  try {
    return await getHostRange(q.metric, Number(q.minutes ?? 60), Date.now());
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
  if (!requireRole(req, reply, "operator")) return;
  const b = (req.body ?? {}) as { alertname?: string; hours?: number; comment?: string };
  if (!b.alertname) return reply.code(400).send({ error: "alertname required" });
  const createdBy = actorOf(req);
  try {
    return await createSilence({ alertname: b.alertname, hours: Number(b.hours ?? 1), createdBy, comment: b.comment ?? "" });
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app.delete("/api/alerts/silence/:id", async (req, reply) => {
  if (!requireRole(req, reply, "operator")) return;
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
