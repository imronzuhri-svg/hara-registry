import {
  createPublicClient,
  http,
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
  type AbiEvent,
} from "viem";
import Fastify from "fastify";
import { createDbPool, logger } from "@hara/shared";
import { registerTraceRoutes } from "./trace-api.js";
import { getAbi } from "./abis.js";
import { config } from "./config.js";
import {
  registry,
  lastIndexedBlock,
  chainHeadBlock,
  indexLagBlocks,
  eventsIndexedTotal,
  eventsRawTotal,
  indexerErrorsTotal,
  batchDurationMs,
} from "./metrics.js";

const db = createDbPool();
const client = createPublicClient({ transport: http(config.rpcReadUrl) });

interface WatchedContract {
  address: Address;
  name: string;
  fromBlock: bigint;
}

async function loadWatchedContracts(): Promise<WatchedContract[]> {
  const { rows } = await db.query<{
    contract_address: string;
    name: string;
    from_block: string;
  }>("SELECT contract_address, name, from_block FROM watched_contracts WHERE enabled = true");
  return rows.map((r) => ({
    address: r.contract_address as Address,
    name: r.name,
    fromBlock: BigInt(r.from_block),
  }));
}

async function getCursor(): Promise<bigint> {
  const { rows } = await db.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM indexer_state WHERE id = 1",
  );
  return BigInt(rows[0]?.last_indexed_block ?? -1);
}

async function setCursor(block: bigint): Promise<void> {
  await db.query(
    "UPDATE indexer_state SET last_indexed_block = $1, last_indexed_at = now() WHERE id = 1",
    [block.toString()],
  );
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Decode a single log. Returns { name, args } on success, or null if the ABI
 * doesn't match (e.g. the contract emitted an event not in our registry).
 */
function tryDecode(log: Log, contractName: string): { name: string; args: unknown } | null {
  const abi = getAbi(contractName);
  if (!abi) return null;
  try {
    const decoded = decodeEventLog({
      abi: abi as AbiEvent[],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    return { name: decoded.eventName as string, args: decoded.args };
  } catch {
    return null;
  }
}

/**
 * Index a single block range [from, to] inclusive.
 * - Fetches all logs from watched addresses
 * - Decodes against the per-contract ABI registry
 * - Inserts indexed_blocks + indexed_events in a single DB transaction
 * - Advances the cursor atomically
 */
async function indexRange(
  contracts: WatchedContract[],
  from: bigint,
  to: bigint,
): Promise<void> {
  const start = performance.now();
  const addresses = contracts.map((c) => c.address);
  const addressToName = new Map(contracts.map((c) => [c.address.toLowerCase(), c.name]));

  if (addresses.length === 0) {
    logger.warn("No watched contracts; just advancing cursor");
    await setCursor(to);
    lastIndexedBlock.set(Number(to));
    return;
  }

  // Fetch all logs for the range. viem batches and handles JSON-RPC formatting.
  let logs: Log[];
  try {
    logs = (await client.getLogs({
      address: addresses,
      fromBlock: from,
      toBlock: to,
    })) as Log[];
  } catch (err: any) {
    indexerErrorsTotal.labels("getLogs").inc();
    throw err;
  }

  // For every unique block referenced, fetch metadata in parallel.
  const uniqueBlocks = new Set<bigint>();
  for (const log of logs) {
    if (log.blockNumber != null) uniqueBlocks.add(log.blockNumber);
  }
  // Always include the highest block in the range, so the cursor is honest
  // about "I've looked at blocks up to N", even if N had no events.
  uniqueBlocks.add(to);

  const blockMetadata = new Map<bigint, { hash: Hex; parentHash: Hex; timestamp: bigint; txCount: number }>();
  await Promise.all(
    Array.from(uniqueBlocks).map(async (n) => {
      const b = await client.getBlock({ blockNumber: n, includeTransactions: false });
      blockMetadata.set(n, {
        hash: b.hash!,
        parentHash: b.parentHash,
        timestamp: b.timestamp,
        txCount: b.transactions.length,
      });
    }),
  );

  // Persist in a single transaction
  const dbClient = await db.connect();
  try {
    await dbClient.query("BEGIN");

    // Blocks (upsert — re-indexing same range is idempotent)
    for (const [n, meta] of blockMetadata) {
      await dbClient.query(
        `INSERT INTO indexed_blocks (block_number, block_hash, parent_hash, timestamp_unix, tx_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (block_number) DO UPDATE
            SET block_hash = EXCLUDED.block_hash,
                parent_hash = EXCLUDED.parent_hash,
                timestamp_unix = EXCLUDED.timestamp_unix,
                tx_count = EXCLUDED.tx_count`,
        [Number(n), meta.hash, meta.parentHash, Number(meta.timestamp), meta.txCount],
      );
    }

    // Events
    for (const log of logs) {
      const addr = (log.address as string).toLowerCase();
      const contractName = addressToName.get(addr) ?? null;
      eventsRawTotal.labels(contractName ?? "unknown").inc();

      let eventName: string | null = null;
      let decoded: unknown = null;
      if (contractName) {
        const result = tryDecode(log, contractName);
        if (result) {
          eventName = result.name;
          decoded = result.args;
          eventsIndexedTotal.labels(contractName, eventName).inc();
        }
      }

      await dbClient.query(
        `INSERT INTO indexed_events
           (block_number, block_hash, tx_hash, log_index, contract_address,
            contract_name, event_name, topics, data, decoded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (block_hash, tx_hash, log_index) DO NOTHING`,
        [
          Number(log.blockNumber),
          log.blockHash,
          log.transactionHash,
          log.logIndex,
          addr,
          contractName,
          eventName,
          log.topics,
          log.data,
          decoded ? JSON.stringify(decoded, bigintReplacer) : null,
        ],
      );
    }

    // Advance cursor
    await dbClient.query(
      "UPDATE indexer_state SET last_indexed_block = $1, last_indexed_at = now() WHERE id = 1",
      [to.toString()],
    );

    await dbClient.query("COMMIT");
  } catch (err) {
    await dbClient.query("ROLLBACK");
    indexerErrorsTotal.labels("dbWrite").inc();
    throw err;
  } finally {
    dbClient.release();
  }

  const dur = performance.now() - start;
  batchDurationMs.set(dur);
  lastIndexedBlock.set(Number(to));

  if (logs.length > 0) {
    logger.info(
      { from: Number(from), to: Number(to), logs: logs.length, blocks: blockMetadata.size, dur_ms: Math.round(dur) },
      "range indexed",
    );
  } else {
    logger.debug(
      { from: Number(from), to: Number(to), dur_ms: Math.round(dur) },
      "range scanned (no events)",
    );
  }
}

async function tickOnce(contracts: WatchedContract[]): Promise<void> {
  const head = await client.getBlockNumber();
  chainHeadBlock.set(Number(head));
  const target = head - BigInt(config.confirmations);

  const cursor = await getCursor();
  indexLagBlocks.set(Number(head) - Number(cursor));

  if (target <= cursor) return;

  const from = cursor + 1n;
  const to = from + BigInt(config.batchSize) - 1n > target ? target : from + BigInt(config.batchSize) - 1n;
  await indexRange(contracts, from, to);
}

async function mainLoop() {
  const contracts = await loadWatchedContracts();
  logger.info({ count: contracts.length, contracts: contracts.map((c) => c.name) }, "loaded watched contracts");

  while (true) {
    try {
      await tickOnce(contracts);
    } catch (err: any) {
      logger.error({ err: err.message ?? String(err) }, "tick failed");
      indexerErrorsTotal.labels("tick").inc();
      await new Promise((r) => setTimeout(r, config.errorBackoffMs));
      continue;
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics + health HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const metricsServer = Fastify({ loggerInstance: logger });
metricsServer.get("/healthz", async () => ({ ok: true }));
metricsServer.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

// CORS for browser-based viewer accessing this from localhost:* origins
metricsServer.addHook("onSend", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
});

// Traceability REST endpoints
registerTraceRoutes(metricsServer, db);

async function main() {
  await metricsServer.listen({ host: "0.0.0.0", port: config.metricsPort });
  logger.info({ port: config.metricsPort, rpc: config.rpcReadUrl }, "indexer started");
  await mainLoop();
}

main().catch((err) => {
  logger.error({ err: err.message ?? err }, "indexer crashed");
  process.exit(1);
});
