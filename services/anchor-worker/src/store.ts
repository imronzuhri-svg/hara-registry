import { Client as MinioClient } from "minio";
import pg from "pg";
import { config } from "./config.js";

/**
 * Persistence side-effects:
 *
 *   1. PUT signature blob to MinIO (bucket=hara-pq-anchors, content-addressed
 *      by keccak256(sig)).
 *   2. INSERT row into pq_anchor_signatures (migration 004).
 *
 * Write order matches ADR-0010 §"Write path": blob first, then index row.
 * Worst case is an orphan blob in MinIO — recoverable by a reconciler.
 * Reverse drift (row pointing at missing blob) would fail audits closed
 * and is the failure mode we avoid.
 *
 * Idempotent on the commitment_hash PK: re-running with the same hash is
 * a no-op (ON CONFLICT DO NOTHING) — content-addressing makes any conflict
 * either a legitimate replay or a keccak256 collision (not our problem).
 */

const minio = new MinioClient({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

const pool = new pg.Pool({ connectionString: config.databaseUrl });

let bucketReady = false;

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const exists = await minio.bucketExists(config.minio.bucket).catch(() => false);
  if (!exists) {
    await minio.makeBucket(config.minio.bucket, "").catch((e: any) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e))) throw e;
    });
  }
  bucketReady = true;
}

export interface AnchorRecord {
  commitmentHash: Uint8Array; // 32 B; matches on-chain commit
  signerDid: string;
  anchorTxHash: Uint8Array; // 32 B
  signature: Uint8Array; // 3309 B for ML-DSA-65
  algo: string;
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export async function persistAnchor(rec: AnchorRecord): Promise<void> {
  await ensureBucket();
  const objectKey = `${rec.algo.toLowerCase()}/${toHex(rec.commitmentHash)}.sig`;
  const blob = Buffer.from(rec.signature);

  // 1) PUT blob.
  await minio.putObject(config.minio.bucket, objectKey, blob, blob.length, {
    "Content-Type": "application/octet-stream",
    "x-amz-meta-algo": rec.algo.toLowerCase(),
    "x-amz-meta-anchor-tx": "0x" + toHex(rec.anchorTxHash),
    "x-amz-meta-signer-did": rec.signerDid,
    "x-amz-meta-created-at": new Date().toISOString(),
  });

  // 2) INSERT index row.
  await pool.query(
    `INSERT INTO pq_anchor_signatures
       (commitment_hash, algo, signer_did, anchor_tx_hash, bucket, object_key, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (commitment_hash) DO NOTHING`,
    [
      Buffer.from(rec.commitmentHash),
      rec.algo.toLowerCase(),
      rec.signerDid,
      Buffer.from(rec.anchorTxHash),
      config.minio.bucket,
      objectKey,
      blob.length,
    ],
  );
}

// ── Worker-state cursor ─────────────────────────────────────────────────────

/** Lazily initialise the single-row state table. Migration 005 owns the
 *  schema; this is a safety net for dev environments where migrations were
 *  reset out of band. */
async function ensureStateTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pq_anchor_worker_state (
      id                  SMALLINT PRIMARY KEY DEFAULT 1,
      last_anchored_block BIGINT NOT NULL DEFAULT -1,
      last_anchor_id      BIGINT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (id = 1)
    );
    INSERT INTO pq_anchor_worker_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
}

export async function readCursor(): Promise<number> {
  await ensureStateTable();
  const r = await pool.query<{ last_anchored_block: string }>(
    "SELECT last_anchored_block FROM pq_anchor_worker_state WHERE id = 1",
  );
  return Number(r.rows[0]?.last_anchored_block ?? -1);
}

export async function advanceCursor(toBlock: number, anchorId: bigint): Promise<void> {
  await pool.query(
    `UPDATE pq_anchor_worker_state
        SET last_anchored_block = $1, last_anchor_id = $2, updated_at = now()
      WHERE id = 1`,
    [toBlock, anchorId.toString()],
  );
}

// ── Source of leaves ─────────────────────────────────────────────────────────

export interface EventRow {
  blockNumber: number;
  txHash: Uint8Array; // 32 B
  logIndex: number;
}

export async function fetchEventsSince(
  fromBlockExclusive: number,
  toBlockInclusive: number,
  cap: number,
): Promise<EventRow[]> {
  const r = await pool.query<{ block_number: string; tx_hash: string; log_index: number }>(
    `SELECT block_number, tx_hash, log_index
       FROM indexed_events
      WHERE block_number > $1 AND block_number <= $2
      ORDER BY block_number, log_index
      LIMIT $3`,
    [fromBlockExclusive, toBlockInclusive, cap],
  );
  return r.rows.map((row) => ({
    blockNumber: Number(row.block_number),
    txHash: hexToBytes(row.tx_hash),
    logIndex: row.log_index,
  }));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
