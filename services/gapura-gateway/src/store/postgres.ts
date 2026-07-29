/**
 * Postgres-backed store — SKELETON / TODO.
 *
 * Used only when PG_URL is set. The queries below are wired against the schema
 * in the CREATE TABLE comment; treat this as a starting point — it has NOT been
 * exercised against a live database. The in-memory store (memory.ts) is the
 * default and the tested path.
 *
 * ── Schema (run as a migration) ──────────────────────────────────────────────
 *
 *   CREATE TABLE gapura_anchor (
 *     anchor_id     text PRIMARY KEY,           -- gap_anc_...
 *     digest        text NOT NULL UNIQUE,       -- 0x + 64 hex (lowercased); natural idempotency key
 *     hash_alg      text NOT NULL,
 *     on_chain_id   text,                        -- PQAnchorRegistry uint256, string-encoded
 *     object_did    text NOT NULL,
 *     purpose       text NOT NULL,
 *     actor_did     text,
 *     tenant        text NOT NULL,
 *     tx_hash       text,
 *     block_number  bigint,
 *     log_index     integer,
 *     pq_key_hash   text NOT NULL,               -- keccak256(ML-DSA-65 pubkey)
 *     pq_verified   boolean NOT NULL DEFAULT false,
 *     status        text NOT NULL,               -- pending | confirmed | failed
 *     failure_reason text,
 *     anchored_at   timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE TABLE gapura_idempotency (
 *     key        text PRIMARY KEY,               -- Idempotency-Key (uuid)
 *     body_hash  text NOT NULL,                  -- sha256 of the canonical request body
 *     anchor_id  text NOT NULL REFERENCES gapura_anchor(anchor_id),
 *     stored_at  timestamptz NOT NULL DEFAULT now()
 *   );
 *   -- TTL sweep: DELETE FROM gapura_idempotency WHERE stored_at < now() - interval '24 hours';
 *
 *   CREATE TABLE gapura_binding (
 *     authentik_sub text PRIMARY KEY,            -- §4.3 join key
 *     did           text NOT NULL,
 *     tenant        text NOT NULL,
 *     bound_at      timestamptz NOT NULL DEFAULT now()
 *   );
 *
 * TODO: also persist the raw ML-DSA-65 signature blob to MinIO bucket
 *       `hara-pq-anchors` (see anchor-service.ts) and store the object key here.
 */

import { Pool } from "pg";
import type { AnchorRecord, IdempotencyEntry, Store } from "./index.js";
import type { Binding } from "../types.js";

export class PostgresStore implements Store {
  private constructor(private readonly pool: Pool) {}

  static async create(pgUrl: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString: pgUrl });
    // TODO: run migrations / verify tables exist here.
    return new PostgresStore(pool);
  }

  async getAnchorByDigest(digest: string): Promise<AnchorRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM gapura_anchor WHERE digest = $1",
      [digest.toLowerCase()],
    );
    return r.rows[0] ? rowToAnchor(r.rows[0]) : undefined;
  }

  async getAnchorById(anchorId: string): Promise<AnchorRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM gapura_anchor WHERE anchor_id = $1",
      [anchorId],
    );
    return r.rows[0] ? rowToAnchor(r.rows[0]) : undefined;
  }

  async putAnchor(a: AnchorRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO gapura_anchor
         (anchor_id, digest, hash_alg, on_chain_id, object_did, purpose, actor_did,
          tenant, tx_hash, block_number, log_index, pq_key_hash, pq_verified,
          status, failure_reason, anchored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (digest) DO NOTHING`,
      [
        a.anchorId, a.digest.toLowerCase(), a.hashAlg, a.onChainId ?? null,
        a.objectDid, a.purpose, a.actorDid ?? null, a.tenant, a.txHash ?? null,
        a.blockNumber ?? null, a.logIndex ?? null, a.pqKeyHash, a.pqVerified,
        a.status, a.failureReason ?? null, a.anchoredAt,
      ],
    );
  }

  async getIdempotency(key: string): Promise<IdempotencyEntry | undefined> {
    const r = await this.pool.query(
      "SELECT body_hash, anchor_id, stored_at FROM gapura_idempotency WHERE key = $1",
      [key],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      bodyHash: row.body_hash,
      anchorId: row.anchor_id,
      storedAt: new Date(row.stored_at).getTime(),
    };
  }

  async putIdempotency(entry: IdempotencyEntry & { key: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO gapura_idempotency (key, body_hash, anchor_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (key) DO NOTHING`,
      [entry.key, entry.bodyHash, entry.anchorId],
    );
  }

  async getBindingBySubject(authentikSub: string): Promise<Binding | undefined> {
    const r = await this.pool.query(
      "SELECT authentik_sub, did, tenant, bound_at FROM gapura_binding WHERE authentik_sub = $1",
      [authentikSub],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      authentikSub: row.authentik_sub,
      did: row.did,
      tenant: row.tenant,
      boundAt: new Date(row.bound_at).toISOString(),
    };
  }

  async putBinding(
    binding: Required<Pick<Binding, "authentikSub" | "did" | "tenant">> & Binding,
  ): Promise<Binding> {
    const r = await this.pool.query(
      `INSERT INTO gapura_binding (authentik_sub, did, tenant)
       VALUES ($1,$2,$3)
       ON CONFLICT (authentik_sub) DO UPDATE SET did = EXCLUDED.did, tenant = EXCLUDED.tenant
       RETURNING authentik_sub, did, tenant, bound_at`,
      [binding.authentikSub, binding.did, binding.tenant],
    );
    const row = r.rows[0];
    return {
      authentikSub: row.authentik_sub,
      did: row.did,
      tenant: row.tenant,
      boundAt: new Date(row.bound_at).toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToAnchor(row: Record<string, unknown>): AnchorRecord {
  return {
    anchorId: row.anchor_id as string,
    onChainId: (row.on_chain_id as string | null) ?? undefined,
    digest: row.digest as string,
    hashAlg: row.hash_alg as string,
    objectDid: row.object_did as string,
    purpose: row.purpose as string,
    actorDid: (row.actor_did as string | null) ?? undefined,
    tenant: row.tenant as string,
    txHash: (row.tx_hash as string | null) ?? undefined,
    blockNumber: (row.block_number as number | null) ?? undefined,
    logIndex: (row.log_index as number | null) ?? undefined,
    pqKeyHash: row.pq_key_hash as string,
    pqVerified: row.pq_verified as boolean,
    status: row.status as AnchorRecord["status"],
    failureReason: (row.failure_reason as string | null) ?? undefined,
    anchoredAt: new Date(row.anchored_at as string).toISOString(),
  };
}
