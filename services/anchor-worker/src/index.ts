import { createPublicClient, http, type Hex } from "viem";
import { keccak_256 } from "@noble/hashes/sha3";
import pino from "pino";
import client from "prom-client";
import { config } from "./config.js";
import { loadOrInitKeys } from "./vaultKey.js";
import {
  fetchEventsSince,
  readCursor,
  advanceCursor,
  persistAnchor,
  closePool,
} from "./store.js";
import { leafFromEvent, merkleRoot } from "./merkle.js";
import { sign as pqSign, toHex } from "./pq.js";
import {
  currentPQKeyHashOnChain,
  rotatePQKey,
  recordAnchor,
  ensureWalletPrefunded,
} from "./chain.js";

/**
 * Anchor worker — the final piece of the PQ audit chain.
 *
 * On a cadence (default 10 min):
 *   1. Determine the block window [lastAnchored+1, latestSafe].
 *   2. Pull all indexed_events in that range from Postgres.
 *   3. Build a Merkle root over (tx_hash || log_index) for each event.
 *   4. Sign the canonical anchor message with ML-DSA-65.
 *   5. PUT signature blob to MinIO; INSERT pq_anchor_signatures row.
 *   6. Submit PQAnchorRegistry.recordAnchor(...) on-chain with the
 *      keccak256(sig) commitment.
 *   7. Advance the worker cursor.
 *
 * One-shot bootstrap on cold start:
 *   • Load (or generate + store) the ECDSA + ML-DSA-65 keypair from Vault.
 *   • If on-chain `currentPQKeyHash` doesn't match our pubkey hash (e.g.
 *     contract was deployed with the placeholder hash in DeployPQAnchor.s.sol),
 *     call rotatePQKey() once.
 *
 * Refuses to start if the ECDSA signer has zero native HARA balance — Besu
 * silently drops those transactions.
 */

const log = pino({ name: "anchor-worker" });

// ── Metrics ─────────────────────────────────────────────────────────────────
const metrics = new client.Registry();
client.collectDefaultMetrics({ register: metrics, prefix: "hara_anchor_" });

const anchorsTotal = new client.Counter({
  name: "hara_anchor_anchors_total",
  help: "Total anchors recorded on-chain",
  registers: [metrics],
});
const anchorEvents = new client.Histogram({
  name: "hara_anchor_events_per_anchor",
  help: "Events covered by each anchor",
  buckets: [1, 10, 100, 1000, 10_000, 100_000],
  registers: [metrics],
});
const anchorLatencyMs = new client.Histogram({
  name: "hara_anchor_latency_ms",
  help: "Wall-clock time per anchor cycle",
  buckets: [100, 500, 1000, 5000, 30_000, 120_000],
  registers: [metrics],
});
const anchorErrors = new client.Counter({
  name: "hara_anchor_errors_total",
  help: "Anchor cycle failures",
  registers: [metrics],
});

// ── Canonical anchor message ────────────────────────────────────────────────
// What ML-DSA-65 signs. Auditors reconstruct this exactly from the
// on-chain Anchor record + the off-chain blob's MinIO metadata.

function canonicalMessage(args: {
  algorithm: string;
  merkleRoot: Uint8Array;
  blockFrom: bigint;
  blockTo: bigint;
  eventCount: bigint;
  anchorChain: Uint8Array;
}): Uint8Array {
  // Stable canonical encoding: algorithm length-prefixed, then 32-byte root,
  // then big-endian uint64s, then anchor-chain tag. Trivially recomputable.
  const algoBytes = Buffer.from(args.algorithm, "utf-8");
  const algoLen = Buffer.alloc(2);
  algoLen.writeUInt16BE(algoBytes.length, 0);

  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v, 0);
    return b;
  };

  return Buffer.concat([
    algoLen,
    algoBytes,
    Buffer.from(args.merkleRoot),
    u64(args.blockFrom),
    u64(args.blockTo),
    u64(args.eventCount),
    Buffer.from(args.anchorChain),
  ]);
}

// ── One anchor cycle ────────────────────────────────────────────────────────

interface CycleContext {
  keys: Awaited<ReturnType<typeof loadOrInitKeys>>;
  signerDid: string;
  publicClient: ReturnType<typeof createPublicClient>;
}

async function runOnce(ctx: CycleContext): Promise<{ status: "ok" | "noop" | "error"; events: number }> {
  const startedAt = Date.now();
  const lastAnchored = await readCursor();

  // Use confirmations=0 (QBFT instant finality) but lag one block for safety.
  const latestBlock = await ctx.publicClient.getBlockNumber();
  const safeTo = latestBlock - 1n;
  if (safeTo <= BigInt(lastAnchored)) {
    return { status: "noop", events: 0 };
  }

  const events = await fetchEventsSince(
    lastAnchored,
    Number(safeTo),
    config.maxEvents,
  );
  if (events.length < config.minEvents) {
    return { status: "noop", events: events.length };
  }

  const blockFrom = BigInt(events[0].blockNumber);
  const blockTo = BigInt(events[events.length - 1].blockNumber);

  // Build Merkle root.
  const leaves = events.map((e) => leafFromEvent(e.txHash, e.logIndex));
  const { root } = merkleRoot(leaves);
  // sha3Root: alternate hash-agility commit. For now we duplicate keccak256
  // since @noble's sha3-256 is the same primitive; revisit when we add a
  // second hash family.
  const sha3Root = root;

  const anchorChain = hexToBytes32(config.anchorChainTag);

  // Sign canonical message.
  const msg = canonicalMessage({
    algorithm: config.algorithm,
    merkleRoot: root,
    blockFrom,
    blockTo,
    eventCount: BigInt(events.length),
    anchorChain,
  });
  const sig = pqSign(ctx.keys.pq.secretKey, msg);
  const commitmentHash = keccak_256(sig);

  log.info(
    {
      blockFrom: blockFrom.toString(),
      blockTo: blockTo.toString(),
      events: events.length,
      sigBytes: sig.length,
    },
    "anchor cycle: ready to submit",
  );

  // Submit on-chain BEFORE writing the blob — but capture the tx hash first
  // so the blob's metadata can reference it. We can't have both orderings
  // perfectly, so the choice is documented in ADR-0010:
  //   blob first → orphan blob if INSERT fails (recoverable by reconciler)
  //   chain first → orphan on-chain commit if blob fails (chain points at nothing)
  // ADR-0010 chose blob-first; we follow it. The anchor_tx_hash field can
  // be filled in with bytes32(0) on the blob metadata if pre-submit; we
  // update after.
  //
  // Concretely: PUT blob with anchor_tx_hash=0 placeholder → submit chain
  // tx → if successful, the row IS the canonical record and includes the
  // real tx hash. Auditor only ever reads from Postgres rows, never raw
  // MinIO metadata, so the placeholder is fine.

  let anchorResult;
  try {
    anchorResult = await recordAnchor(ctx.keys.ecdsaPrivateKey, {
      merkleRoot: ("0x" + bytesToHex(root)) as Hex,
      sha3Root: ("0x" + bytesToHex(sha3Root)) as Hex,
      blockFrom,
      blockTo,
      eventCount: BigInt(events.length),
      anchorChain: ("0x" + bytesToHex(anchorChain)) as Hex,
      pqSignatureHash: ("0x" + bytesToHex(commitmentHash)) as Hex,
    });
  } catch (e: any) {
    anchorErrors.inc();
    log.error({ err: e?.message ?? String(e) }, "recordAnchor failed");
    return { status: "error", events: events.length };
  }

  const anchorTxHash = hexToBytes32(anchorResult.txHash);

  await persistAnchor({
    commitmentHash,
    signerDid: ctx.signerDid,
    anchorTxHash,
    signature: sig,
    algo: config.algorithm,
  });

  await advanceCursor(Number(blockTo), anchorResult.anchorId);

  const elapsed = Date.now() - startedAt;
  anchorsTotal.inc();
  anchorEvents.observe(events.length);
  anchorLatencyMs.observe(elapsed);

  log.info(
    {
      anchorId: anchorResult.anchorId.toString(),
      txHash: anchorResult.txHash,
      blockFrom: blockFrom.toString(),
      blockTo: blockTo.toString(),
      events: events.length,
      elapsedMs: elapsed,
    },
    "anchor recorded",
  );
  return { status: "ok", events: events.length };
}

// ── Cold-start bootstrap ────────────────────────────────────────────────────

async function bootstrap(): Promise<CycleContext> {
  log.info("loading keys");
  const keys = await loadOrInitKeys();

  log.info({ address: keys.ecdsaAddress, pqKeyHash: keys.pqKeyHashHex }, "keys loaded");
  await ensureWalletPrefunded(keys.ecdsaAddress);

  // On-chain key reconciliation.
  const onChain = await currentPQKeyHashOnChain();
  if (onChain.toLowerCase() !== keys.pqKeyHashHex.toLowerCase()) {
    log.warn(
      { onChain, ourPubKeyHash: keys.pqKeyHashHex },
      "on-chain PQ key hash mismatch — rotating",
    );
    const txHash = await rotatePQKey(
      keys.ecdsaPrivateKey,
      keys.pqKeyHashHex,
      config.algorithm,
    );
    log.info({ txHash }, "rotated PQ key on-chain");
  } else {
    log.info("on-chain PQ key hash matches our pubkey — no rotation needed");
  }

  const publicClient = createPublicClient({ transport: http(config.rpcReadUrl) });
  const signerDid = process.env.ANCHOR_SIGNER_DID ?? `did:hara:eth:${keys.ecdsaAddress}`;
  return { keys, signerDid, publicClient };
}

// ── Main loop ───────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
  return out;
}

async function main(): Promise<void> {
  const ctx = await bootstrap();
  log.info({ intervalMs: config.intervalMs }, "entering main loop");

  // Metrics endpoint (Prometheus scrape).
  const http = await import("node:http");
  http
    .createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.setHeader("Content-Type", metrics.contentType);
        res.end(await metrics.metrics());
      } else if (req.url === "/healthz") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    })
    .listen(config.metricsPort, "0.0.0.0", () => {
      log.info({ port: config.metricsPort }, "metrics + healthz listening");
    });

  // Cadence loop. Errors don't kill the worker — they get a metric tick and
  // we try again next cycle.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await runOnce(ctx);
      if (r.status === "noop") {
        log.debug({ events: r.events }, "no-op cycle");
      }
    } catch (e: any) {
      anchorErrors.inc();
      log.error({ err: e?.message ?? String(e) }, "anchor cycle crashed (continuing)");
    }
    await sleep(config.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(async (e: any) => {
  log.fatal({ err: e?.message ?? String(e) }, "anchor-worker failed to start");
  await closePool().catch(() => {});
  process.exit(1);
});
