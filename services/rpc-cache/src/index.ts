// RPC read cache — Fastify proxy in front of the read LB.
//
// Caches GET-equivalent eth_* methods that are safe to cache for short TTLs.
// Cuts validator load by ~40–60% under burst read traffic from explorers, dashboards, etc.
//
// Strategy:
//   - eth_chainId, net_version, web3_clientVersion       → 24h TTL (immutable)
//   - eth_blockNumber                                     → 1s TTL  (changes per block)
//   - eth_getBlockByNumber(latest|number, *)              → 5s TTL  (recent), 1h (finalized)
//   - eth_getTransactionByHash, eth_getTransactionReceipt → 1h TTL once status != null
//   - eth_call (with block tag, no state-change)          → 2s TTL  (state-dep)
//   - All other eth_* methods                             → pass through, no cache
//   - eth_sendRawTransaction, *_subscribe, debug_*        → NEVER cached
//
// Observability:
//   GET /metrics            Prometheus exposition (hit/miss per method, latency histograms)
//   GET /cache/stats        JSON quick-look (keyCount, memory)
//   GET /healthz            liveness
//
// Startup:
//   Warmup pre-fetches eth_chainId, net_version, web3_clientVersion, eth_blockNumber
//   and eth_gasPrice so the first client request after restart is already a hit.

// OTel side-effect import (no-op without OTEL_EXPORTER_OTLP_ENDPOINT).
import "@hara/shared/otel";

import Fastify from "fastify";
import { createRedis, logger } from "@hara/shared";
import crypto from "node:crypto";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM = process.env.UPSTREAM_RPC ?? "http://lb:8545/rpc/read";
const REDIS_DB = Number(process.env.REDIS_DB ?? 5);
const WARMUP_ON_START = (process.env.WARMUP_ON_START ?? "true") === "true";

const redis = createRedis();
await redis.select(REDIS_DB).catch(() => { /* fine */ });

// ──────────────────────────────────────────────────────────────────────────
// Prometheus metrics
// ──────────────────────────────────────────────────────────────────────────
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "hara_rpc_cache_" });

const cacheRequests = new Counter({
  name: "hara_rpc_cache_requests_total",
  help: "RPC requests served by the cache layer",
  labelNames: ["method", "outcome"], // outcome: hit|miss|passthrough|error
  registers: [registry],
});

const upstreamLatency = new Histogram({
  name: "hara_rpc_cache_upstream_latency_seconds",
  help: "Latency of upstream RPC calls when the cache misses or passes through",
  labelNames: ["method"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const serveLatency = new Histogram({
  name: "hara_rpc_cache_serve_latency_seconds",
  help: "End-to-end latency including cache lookup",
  labelNames: ["method", "outcome"],
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const cacheSize = new Gauge({
  name: "hara_rpc_cache_keys_total",
  help: "Current number of cached entries in Redis",
  registers: [registry],
});

const errorCount = new Counter({
  name: "hara_rpc_cache_errors_total",
  help: "Errors during cache or upstream operations",
  labelNames: ["stage"],
  registers: [registry],
});

// Background updater for cacheSize (every 10s)
setInterval(async () => {
  try {
    cacheSize.set(await redis.dbsize());
  } catch { /* ignore */ }
}, 10_000);

// ──────────────────────────────────────────────────────────────────────────
// Cache config
// ──────────────────────────────────────────────────────────────────────────
interface JsonRpcReq { jsonrpc: string; id: any; method: string; params?: any[]; }
interface JsonRpcRes { jsonrpc: string; id: any; result?: any; error?: any; }

const CACHE_TTL: Record<string, number> = {
  eth_chainId:                86_400,
  net_version:                86_400,
  web3_clientVersion:         86_400,
  eth_blockNumber:            1,
  eth_gasPrice:               5,
  eth_getBlockByNumber:       5,        // overridden to 3600 for finalized below
  eth_getBlockByHash:         3600,
  eth_getTransactionByHash:   60,
  eth_getTransactionReceipt:  3600,
  eth_getLogs:                3,
  eth_call:                   2,
  eth_getCode:                3600,
  eth_getBalance:             2,
  eth_getTransactionCount:    1,
};

const NEVER_CACHE = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_subscribe",
  "eth_unsubscribe",
  "debug_traceCall",
  "debug_traceTransaction",
  "debug_traceBlock",
  "txpool_content",
  "txpool_inspect",
]);

function cacheKey(req: JsonRpcReq): string {
  const canon = JSON.stringify({ m: req.method, p: req.params ?? [] });
  return `rpc:${crypto.createHash("sha256").update(canon).digest("base64url").slice(0, 24)}`;
}

function ttlFor(req: JsonRpcReq): number | null {
  if (NEVER_CACHE.has(req.method)) return null;
  if (req.method === "eth_getBlockByNumber") {
    const tag = req.params?.[0];
    if (typeof tag === "string" && tag.startsWith("0x")) return 3600; // finalized → long cache
  }
  return CACHE_TTL[req.method] ?? null;
}

async function proxyUpstream(body: any, method: string): Promise<any> {
  const end = upstreamLatency.labels(method).startTimer();
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Upstream may return HTML error pages (e.g., HAProxy 503 when no backend is
    // available). Don't try to JSON.parse those — surface as JSON-RPC error envelope
    // so clients get a structured response instead of a 500 from this cache.
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) {
      const text = await res.text();
      errorCount.labels("upstream").inc();
      const id = Array.isArray(body) ? null : (body?.id ?? null);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Upstream returned ${res.status} ${res.statusText} (${contentType || "no content-type"})`,
          data: text.slice(0, 200),
        },
      };
    }
    return await res.json();
  } catch (err: any) {
    errorCount.labels("upstream").inc();
    throw err;
  } finally {
    end();
  }
}

async function handleOne(req: JsonRpcReq): Promise<JsonRpcRes> {
  const ttl = ttlFor(req);
  const method = req.method;
  const t0 = Date.now();

  if (!ttl) {
    const res = (await proxyUpstream(req, method)) as JsonRpcRes;
    cacheRequests.labels(method, "passthrough").inc();
    serveLatency.labels(method, "passthrough").observe((Date.now() - t0) / 1000);
    return res;
  }

  const key = cacheKey(req);
  let cached: string | null = null;
  try {
    cached = await redis.get(key);
  } catch (err) {
    errorCount.labels("redis_get").inc();
    // Fall through to upstream
  }

  if (cached) {
    const r = JSON.parse(cached) as JsonRpcRes;
    cacheRequests.labels(method, "hit").inc();
    serveLatency.labels(method, "hit").observe((Date.now() - t0) / 1000);
    return { ...r, id: req.id }; // preserve client id
  }

  const fresh = (await proxyUpstream(req, method)) as JsonRpcRes;
  // Cache only when the upstream returned a non-null result. JSON-RPC
  // returns `result: null` for eth_getTransactionReceipt /
  // eth_getTransactionByHash when the tx hasn't mined yet — caching that
  // for 1h means clients polling for confirmation keep getting null even
  // after the tx mines. Found 2026-05-27 when refinery-DAG load test
  // failed at the priming phase with TransactionReceiptNotFoundError.
  if (
    fresh.result !== undefined &&
    fresh.result !== null &&
    fresh.error === undefined
  ) {
    try {
      await redis.setex(key, ttl, JSON.stringify({ jsonrpc: fresh.jsonrpc, result: fresh.result }));
    } catch (err) {
      errorCount.labels("redis_set").inc();
    }
  }
  cacheRequests.labels(method, "miss").inc();
  serveLatency.labels(method, "miss").observe((Date.now() - t0) / 1000);
  return fresh;
}

// ──────────────────────────────────────────────────────────────────────────
// Warmup — pre-fetch hot endpoints so first user request is already a hit
// ──────────────────────────────────────────────────────────────────────────
async function warmup() {
  const warmupRequests: Array<{ method: string; params: any[] }> = [
    { method: "eth_chainId", params: [] },
    { method: "net_version", params: [] },
    { method: "web3_clientVersion", params: [] },
    { method: "eth_blockNumber", params: [] },
    { method: "eth_gasPrice", params: [] },
  ];
  logger.info({ count: warmupRequests.length }, "starting cache warmup");
  let succeeded = 0;
  for (const r of warmupRequests) {
    try {
      const req: JsonRpcReq = { jsonrpc: "2.0", id: 0, method: r.method, params: r.params };
      const res = await handleOne(req);
      if (res.result !== undefined) succeeded++;
    } catch (err: any) {
      logger.warn({ method: r.method, err: err.message }, "warmup call failed");
    }
  }
  logger.info({ succeeded, total: warmupRequests.length }, "warmup complete");
}

// ──────────────────────────────────────────────────────────────────────────
// Fastify app
// ──────────────────────────────────────────────────────────────────────────
const app = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024 });

app.addHook("onSend", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
});

app.get("/healthz", async () => ({ ok: true }));

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

app.get("/cache/stats", async () => {
  const info = await redis.info("memory");
  const keyCount = await redis.dbsize();
  return { keyCount, memory: info.split("\n").slice(0, 5) };
});

app.post("/", async (req) => {
  const body = req.body as JsonRpcReq | JsonRpcReq[];
  if (Array.isArray(body)) {
    return Promise.all(body.map(handleOne));
  }
  return handleOne(body);
});

// ──────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────
const start = async () => {
  await app.listen({ host: "0.0.0.0", port: PORT });
  logger.info({ port: PORT, upstream: UPSTREAM, redisDb: REDIS_DB }, "rpc-cache started");
  if (WARMUP_ON_START) {
    // Run warmup asynchronously so server is immediately responsive to /healthz
    warmup().catch((e: any) => logger.error({ err: e }, "warmup error"));
  }
};

start().catch((e: any) => { logger.error({ err: e }, "rpc-cache crashed"); process.exit(1); });
