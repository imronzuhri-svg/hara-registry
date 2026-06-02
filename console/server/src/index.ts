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

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((addr) => app.log.info(`Strata Console API listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
