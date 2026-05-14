import type { DbPool } from "@hara/shared";
import { createPublicClient, http, type Address } from "viem";
import { config } from "./config.js";
import { logger } from "@hara/shared";

const rpcClient = createPublicClient({
  transport: http(config.rpcReadUrl),
});

/**
 * Reserve a fresh nonce for the given wallet. Uses SELECT ... FOR UPDATE inside
 * a transaction so concurrent signer requests serialize cleanly.
 *
 * Logic:
 *   chain_nonce = eth_getTransactionCount(address, "pending")
 *   reserved    = max(last_reserved + 1, chain_nonce)
 *   persist last_reserved = reserved
 *   return reserved
 *
 * This reconciles the local ledger with chain truth on every reservation, so
 * out-of-band txs (e.g. forge script deploys hitting /rpc/write directly) don't
 * cause us to issue conflicting nonces.
 */
export async function reserveNonce(pool: DbPool, address: Address): Promise<number> {
  const addr = address.toLowerCase();

  // Read chain nonce outside the DB transaction so we don't hold the row lock
  // during a network round-trip.
  const chainNonce = await rpcClient.getTransactionCount({
    address: addr as Address,
    blockTag: "pending",
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ last_reserved: string }>(
      "SELECT last_reserved FROM wallet_nonces WHERE address = $1 FOR UPDATE",
      [addr],
    );
    if (cur.rowCount === 0) {
      throw new Error(`No wallet_nonces row for ${addr}`);
    }
    const lastReserved = BigInt(cur.rows[0].last_reserved);
    const next = lastReserved + 1n > BigInt(chainNonce) ? lastReserved + 1n : BigInt(chainNonce);

    await client.query(
      "UPDATE wallet_nonces SET last_reserved = $1, updated_at = now() WHERE address = $2",
      [next.toString(), addr],
    );
    await client.query("COMMIT");

    logger.debug({ addr, reserved: next.toString(), chainNonce }, "nonce reserved");
    return Number(next);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
