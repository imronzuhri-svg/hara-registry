// OTel init MUST be the first import — auto-instrumentations patch
// fastify/pg/redis/http at load time. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set in env. See services/shared/src/otel.ts.
import "@hara/shared/otel";

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { createDbPool, createRedis, logger, QUEUE_KEY_OUTBOUND } from "@hara/shared";
import type { Address, Hex } from "viem";
import { config } from "./config.js";
import { reserveNonce } from "./nonce.js";
import { signTx } from "./sign.js";

const db = createDbPool();
const redis = createRedis();

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true,
  bodyLimit: 1024 * 256, // 256 KB
});

app.get("/healthz", async () => ({ ok: true }));

app.get("/v1/tx/:txId", async (req, reply) => {
  const { txId } = req.params as { txId: string };
  const { rows } = await db.query(
    `SELECT tx_id, from_address, to_address, data, value, gas_limit, nonce, chain_id,
            tx_hash, status, receipt_status, block_number, gas_used, error_message,
            retry_count, created_at, updated_at, confirmed_at
       FROM transactions WHERE tx_id = $1`,
    [txId],
  );
  if (rows.length === 0) {
    return reply.code(404).send({ error: "tx not found" });
  }
  return rows[0];
});

interface SubmitBody {
  from: string;
  to?: string;
  data?: string;
  value?: string;
  gasLimit?: number;
}

app.post("/v1/tx", async (req, reply) => {
  const body = req.body as SubmitBody;
  if (!body?.from || typeof body.from !== "string") {
    return reply.code(400).send({ error: "from is required" });
  }
  const from = body.from.toLowerCase() as Address;
  const to = body.to ? (body.to.toLowerCase() as Address) : null;
  const data = (body.data ?? "0x") as Hex;
  const value = BigInt(body.value ?? "0");
  const gasLimit = BigInt(body.gasLimit ?? config.defaultGasLimit);

  // Look up wallet → Vault path
  const wallet = await db.query<{ vault_path: string }>(
    "SELECT vault_path FROM wallets WHERE address = $1",
    [from],
  );
  if (wallet.rowCount === 0) {
    return reply.code(400).send({ error: `unknown wallet ${from}` });
  }
  const vaultPath = wallet.rows[0].vault_path;

  const txId = randomUUID();
  await db.query(
    `INSERT INTO transactions
       (tx_id, from_address, to_address, data, value, gas_limit, chain_id, status, submitted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8)`,
    [
      txId,
      from,
      to,
      data,
      value.toString(),
      Number(gasLimit),
      config.chainId,
      (req.headers["x-client-id"] as string) ?? "anonymous",
    ],
  );

  let nonce: number;
  let signed;
  try {
    nonce = await reserveNonce(db, from);
    signed = await signTx(vaultPath, {
      from,
      to,
      data,
      value,
      gasLimit,
      nonce,
    });
  } catch (err: any) {
    await db.query(
      "UPDATE transactions SET status = 'FAILED', error_message = $1, updated_at = now() WHERE tx_id = $2",
      [err.message ?? String(err), txId],
    );
    logger.error({ err, txId }, "sign failed");
    return reply.code(500).send({ error: "sign failed", message: err.message });
  }

  await db.query(
    `UPDATE transactions
       SET nonce = $1, raw_tx = $2, tx_hash = $3, status = 'QUEUED', updated_at = now()
     WHERE tx_id = $4`,
    [nonce, signed.rawTx, signed.txHash, txId],
  );

  // Enqueue for broadcaster
  await redis.xadd(QUEUE_KEY_OUTBOUND, "*", "txId", txId);

  logger.info({ txId, from, nonce, txHash: signed.txHash }, "tx queued");
  return { txId, status: "QUEUED" };
});

const start = async () => {
  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port }, "signer listening");
  } catch (err) {
    logger.error({ err }, "failed to start");
    process.exit(1);
  }
};

start();
