import { createPublicClient, http, type Hex } from "viem";
import {
  createDbPool,
  createRedis,
  logger,
  QUEUE_KEY_OUTBOUND,
  QUEUE_GROUP_BROADCASTER,
} from "@hara/shared";

const RPC_WRITE_URL = process.env.RPC_WRITE_URL ?? "http://lb:8545/rpc/write";
const RPC_READ_URL = process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read";
const MAX_RETRIES = Number(process.env.BROADCAST_MAX_RETRIES ?? 3);
const RECEIPT_POLL_INTERVAL_MS = Number(process.env.RECEIPT_POLL_INTERVAL_MS ?? 2000);
const RECEIPT_TIMEOUT_MS = Number(process.env.RECEIPT_TIMEOUT_MS ?? 60_000);
const CONSUMER_NAME = process.env.HOSTNAME ?? `broadcaster-${process.pid}`;

const db = createDbPool();
const redis = createRedis();

// Two HTTP clients — one for tx submission (write), one for receipt polling (read).
// Both go through the LB at L1.
const writeClient = createPublicClient({ transport: http(RPC_WRITE_URL) });
const readClient = createPublicClient({ transport: http(RPC_READ_URL) });

async function ensureGroupExists() {
  try {
    await redis.xgroup("CREATE", QUEUE_KEY_OUTBOUND, QUEUE_GROUP_BROADCASTER, "0", "MKSTREAM");
    logger.info({ stream: QUEUE_KEY_OUTBOUND, group: QUEUE_GROUP_BROADCASTER }, "consumer group created");
  } catch (err: any) {
    if (err.message?.includes("BUSYGROUP")) {
      logger.debug("consumer group already exists");
    } else {
      throw err;
    }
  }
}

async function processTx(txId: string): Promise<void> {
  // Fetch tx record
  const { rows } = await db.query(
    `SELECT raw_tx, tx_hash, retry_count, from_address, nonce
       FROM transactions WHERE tx_id = $1`,
    [txId],
  );
  if (rows.length === 0) {
    logger.warn({ txId }, "tx not found in DB, skipping");
    return;
  }
  const { raw_tx, retry_count } = rows[0];
  let txHash = rows[0].tx_hash as Hex;
  const attempt = retry_count + 1;

  if (!raw_tx) {
    await markFailed(txId, "raw_tx is null");
    return;
  }

  // Broadcast
  try {
    const submitted = await writeClient.sendRawTransaction({ serializedTransaction: raw_tx as Hex });
    if (submitted.toLowerCase() !== txHash.toLowerCase()) {
      logger.warn({ txId, expected: txHash, got: submitted }, "RPC returned different hash");
      txHash = submitted;
    }
    await db.query(
      `UPDATE transactions SET status = 'BROADCASTED', tx_hash = $1, updated_at = now()
         WHERE tx_id = $2`,
      [txHash, txId],
    );
    await db.query(
      `INSERT INTO tx_attempts (tx_id, attempt_number, tx_hash) VALUES ($1, $2, $3)`,
      [txId, attempt, txHash],
    );
    logger.info({ txId, txHash, attempt }, "broadcasted");
  } catch (err: any) {
    const msg = err.shortMessage ?? err.message ?? String(err);
    logger.warn({ txId, err: msg, attempt }, "broadcast failed");
    await db.query(
      `INSERT INTO tx_attempts (tx_id, attempt_number, error_message) VALUES ($1, $2, $3)`,
      [txId, attempt, msg],
    );

    if (retry_count + 1 >= MAX_RETRIES) {
      await markFailed(txId, msg);
      return;
    }
    await db.query(
      `UPDATE transactions SET status = 'RETRYING', retry_count = retry_count + 1,
              error_message = $1, updated_at = now()
         WHERE tx_id = $2`,
      [msg, txId],
    );
    // Re-enqueue with delay (simple: sleep then xadd)
    setTimeout(() => {
      redis.xadd(QUEUE_KEY_OUTBOUND, "*", "txId", txId).catch((e) => {
        logger.error({ txId, err: e.message }, "re-enqueue failed");
      });
    }, 2000 * Math.pow(2, retry_count));
    return;
  }

  // Poll for receipt
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const receipt = await readClient.getTransactionReceipt({ hash: txHash });
      const success = receipt.status === "success" || (receipt.status as unknown as number) === 1;
      await db.query(
        `UPDATE transactions
            SET status = $1,
                receipt_status = $2,
                block_number = $3,
                gas_used = $4,
                confirmed_at = now(),
                updated_at = now()
          WHERE tx_id = $5`,
        [
          success ? "CONFIRMED" : "REVERTED",
          success ? 1 : 0,
          Number(receipt.blockNumber),
          Number(receipt.gasUsed),
          txId,
        ],
      );
      // Update nonce ledger
      await db.query(
        `UPDATE wallet_nonces
            SET last_confirmed = GREATEST(last_confirmed, $1), updated_at = now()
          WHERE address = $2`,
        [rows[0].nonce, rows[0].from_address],
      );
      logger.info({ txId, txHash, block: Number(receipt.blockNumber), success }, "confirmed");
      return;
    } catch {
      // Receipt not yet available
      await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
    }
  }

  await markFailed(txId, `receipt not seen within ${RECEIPT_TIMEOUT_MS}ms`);
}

async function markFailed(txId: string, message: string) {
  await db.query(
    `UPDATE transactions SET status = 'FAILED', error_message = $1, updated_at = now()
       WHERE tx_id = $2`,
    [message, txId],
  );
  logger.error({ txId, message }, "tx marked FAILED");
}

async function consume() {
  while (true) {
    try {
      const res = (await redis.xreadgroup(
        "GROUP",
        QUEUE_GROUP_BROADCASTER,
        CONSUMER_NAME,
        "BLOCK",
        5000,
        "COUNT",
        10,
        "STREAMS",
        QUEUE_KEY_OUTBOUND,
        ">",
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!res) continue;

      for (const [, messages] of res) {
        for (const [id, fields] of messages) {
          const txIdIdx = fields.indexOf("txId");
          if (txIdIdx === -1) {
            logger.warn({ id, fields }, "queue message missing txId");
            await redis.xack(QUEUE_KEY_OUTBOUND, QUEUE_GROUP_BROADCASTER, id);
            continue;
          }
          const txId = fields[txIdIdx + 1];
          try {
            await processTx(txId);
          } catch (err: any) {
            logger.error({ txId, err: err.message }, "processTx threw");
          } finally {
            await redis.xack(QUEUE_KEY_OUTBOUND, QUEUE_GROUP_BROADCASTER, id);
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "consume loop error");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * On startup, find any txs left in BROADCASTED state (we crashed mid-poll) and
 * try to resolve them by re-checking the chain. Stops them from being orphaned.
 */
async function recoverOrphanedTxs() {
  const { rows } = await db.query<{ tx_id: string; tx_hash: string; from_address: string; nonce: number }>(
    `SELECT tx_id, tx_hash, from_address, nonce
       FROM transactions
      WHERE status = 'BROADCASTED'
        AND tx_hash IS NOT NULL
        AND created_at > now() - interval '1 hour'`,
  );
  if (rows.length === 0) return;
  logger.info({ count: rows.length }, "recovering orphaned BROADCASTED txs");
  for (const row of rows) {
    try {
      const receipt = await readClient.getTransactionReceipt({ hash: row.tx_hash as Hex });
      const success = receipt.status === "success" || (receipt.status as unknown as number) === 1;
      await db.query(
        `UPDATE transactions SET status = $1, receipt_status = $2, block_number = $3,
                gas_used = $4, confirmed_at = now(), updated_at = now()
           WHERE tx_id = $5`,
        [
          success ? "CONFIRMED" : "REVERTED",
          success ? 1 : 0,
          Number(receipt.blockNumber),
          Number(receipt.gasUsed),
          row.tx_id,
        ],
      );
      await db.query(
        `UPDATE wallet_nonces SET last_confirmed = GREATEST(last_confirmed, $1), updated_at = now()
           WHERE address = $2`,
        [row.nonce, row.from_address],
      );
      logger.info({ txId: row.tx_id, block: Number(receipt.blockNumber), success }, "recovered");
    } catch {
      // Receipt not yet available — leave in BROADCASTED, will retry on next startup
      // or via a periodic sweep (not implemented in L2; landing in L3).
      logger.debug({ txId: row.tx_id }, "no receipt yet; leaving BROADCASTED");
    }
  }
}

async function main() {
  await ensureGroupExists();
  await recoverOrphanedTxs();
  logger.info({ consumer: CONSUMER_NAME, rpcWrite: RPC_WRITE_URL }, "broadcaster started");
  await consume();
}

main().catch((err) => {
  logger.error({ err }, "broadcaster crashed");
  process.exit(1);
});
