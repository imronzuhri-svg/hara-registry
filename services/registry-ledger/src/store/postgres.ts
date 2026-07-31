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
 *   CREATE TABLE ledger_attestation (
 *     registry_id  text PRIMARY KEY,             -- reg:att:...
 *     subject      text NOT NULL,
 *     issuer       text NOT NULL,
 *     record_type  text NOT NULL,
 *     content_hash text NOT NULL,                 -- 0x + 64 hex (lowercased)
 *     hash_alg     text NOT NULL,
 *     status       text NOT NULL,                 -- active | superseded | revoked
 *     tenant       text NOT NULL,                 -- token tenant DID that anchored it
 *     log_id       text NOT NULL,
 *     leaf_index   bigint NOT NULL,
 *     leaf_hash    text NOT NULL,
 *     passport     text,                          -- links.passport (verify lookup)
 *     links        jsonb,
 *     issued_at    timestamptz,
 *     anchored_at  timestamptz NOT NULL DEFAULT now(),
 *     UNIQUE (tenant, content_hash)               -- natural idempotency
 *   );
 *   CREATE INDEX ledger_attestation_subject_idx  ON ledger_attestation (subject);
 *   CREATE INDEX ledger_attestation_passport_idx ON ledger_attestation (passport);
 *
 *   CREATE TABLE ledger_status (
 *     id            bigserial PRIMARY KEY,
 *     registry_id   text NOT NULL REFERENCES ledger_attestation(registry_id),
 *     status        text NOT NULL,
 *     since         timestamptz NOT NULL DEFAULT now(),
 *     reason        text,
 *     superseded_by text,
 *     actor         text NOT NULL,               -- actor DID
 *     log_id        text NOT NULL,
 *     leaf_index    bigint NOT NULL,
 *     leaf_hash     text NOT NULL
 *   );
 *   CREATE INDEX ledger_status_registry_idx ON ledger_status (registry_id, id);
 *
 *   CREATE TABLE ledger_evidence (
 *     evidence_id  text PRIMARY KEY,             -- ev:...
 *     content_hash text NOT NULL,
 *     hash_alg     text NOT NULL,
 *     retention_until date NOT NULL,             -- no-delete-before-expiry
 *     basis        text NOT NULL,
 *     legal_hold   boolean NOT NULL DEFAULT false,
 *     tenant       text NOT NULL,
 *     log_id       text NOT NULL,
 *     leaf_index   bigint NOT NULL,
 *     links        jsonb,
 *     anchored_at  timestamptz NOT NULL DEFAULT now(),
 *     deleted      boolean NOT NULL DEFAULT false,
 *     UNIQUE (tenant, content_hash)
 *   );
 *
 *   CREATE TABLE ledger_checkpoint (
 *     checkpoint_id text PRIMARY KEY,            -- ckpt:...
 *     log_id       text NOT NULL,
 *     tree_size    bigint NOT NULL,
 *     root_hash    text NOT NULL,
 *     timestamp    timestamptz NOT NULL DEFAULT now(),
 *     tx_hash      text,
 *     on_chain_id  text
 *   );
 *   CREATE INDEX ledger_checkpoint_log_idx ON ledger_checkpoint (log_id, tree_size);
 *
 *   -- Durable per-log leaf bytes so each RFC 6962 tree rebuilds on boot.
 *   CREATE TABLE ledger_leaf (
 *     log_id     text NOT NULL,
 *     leaf_index bigint NOT NULL,
 *     leaf_bytes text NOT NULL,                  -- 0x-hex of the raw leaf input
 *     PRIMARY KEY (log_id, leaf_index)
 *   );
 */

import { Pool } from "pg";
import type {
  AttestationRecord,
  CheckpointRecord,
  EvidenceRecord,
  StatusEntry,
  Store,
} from "./index.js";
import type { RecordStatus } from "../types.js";

export class PostgresStore implements Store {
  private constructor(private readonly pool: Pool) {}

  static async create(pgUrl: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString: pgUrl });
    // TODO: run migrations / verify tables exist here.
    return new PostgresStore(pool);
  }

  // ── Attestations ─────────────────────────────────────────────────────────────
  async getAttestationById(registryId: string): Promise<AttestationRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM ledger_attestation WHERE registry_id = $1", [
      registryId,
    ]);
    return r.rows[0] ? rowToAttestation(r.rows[0]) : undefined;
  }

  async getAttestationByContentHash(
    tenant: string,
    contentHash: string,
  ): Promise<AttestationRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM ledger_attestation WHERE tenant = $1 AND content_hash = $2",
      [tenant, contentHash.toLowerCase()],
    );
    return r.rows[0] ? rowToAttestation(r.rows[0]) : undefined;
  }

  async putAttestation(a: AttestationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_attestation
         (registry_id, subject, issuer, record_type, content_hash, hash_alg, status,
          tenant, log_id, leaf_index, leaf_hash, passport, links, issued_at, anchored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant, content_hash) DO NOTHING`,
      [
        a.registryId, a.subject, a.issuer, a.recordType, a.contentHash.toLowerCase(),
        a.hashAlg, a.status, a.tenant, a.logId, a.leafIndex, a.leafHash,
        a.passport ?? null, a.links ?? null, a.issuedAt ?? null, a.anchoredAt,
      ],
    );
  }

  async setAttestationStatus(registryId: string, status: RecordStatus): Promise<void> {
    await this.pool.query("UPDATE ledger_attestation SET status = $2 WHERE registry_id = $1", [
      registryId,
      status,
    ]);
  }

  async listAttestationsBySubject(subjectOrPassport: string): Promise<AttestationRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM ledger_attestation WHERE subject = $1 OR passport = $1",
      [subjectOrPassport],
    );
    return r.rows.map(rowToAttestation);
  }

  // ── Status history ───────────────────────────────────────────────────────────
  async appendStatus(e: StatusEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_status
         (registry_id, status, since, reason, superseded_by, actor, log_id, leaf_index, leaf_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.registryId, e.status, e.since, e.reason ?? null, e.supersededBy ?? null, e.actor, e.logId, e.leafIndex, e.leafHash],
    );
  }

  async getLatestStatus(registryId: string): Promise<StatusEntry | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM ledger_status WHERE registry_id = $1 ORDER BY id DESC LIMIT 1",
      [registryId],
    );
    return r.rows[0] ? rowToStatus(r.rows[0]) : undefined;
  }

  // ── Evidence ──────────────────────────────────────────────────────────────────
  async getEvidenceById(evidenceId: string): Promise<EvidenceRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM ledger_evidence WHERE evidence_id = $1", [
      evidenceId,
    ]);
    return r.rows[0] ? rowToEvidence(r.rows[0]) : undefined;
  }

  async getEvidenceByContentHash(
    tenant: string,
    contentHash: string,
  ): Promise<EvidenceRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM ledger_evidence WHERE tenant = $1 AND content_hash = $2",
      [tenant, contentHash.toLowerCase()],
    );
    return r.rows[0] ? rowToEvidence(r.rows[0]) : undefined;
  }

  async putEvidence(e: EvidenceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_evidence
         (evidence_id, content_hash, hash_alg, retention_until, basis, legal_hold,
          tenant, log_id, leaf_index, links, anchored_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant, content_hash) DO NOTHING`,
      [
        e.evidenceId, e.contentHash.toLowerCase(), e.hashAlg, e.until, e.basis, e.legalHold,
        e.tenant, e.logId, e.leafIndex, e.links ?? null, e.anchoredAt, e.deleted,
      ],
    );
  }

  async updateEvidence(e: EvidenceRecord): Promise<void> {
    await this.pool.query(
      `UPDATE ledger_evidence
         SET retention_until = $2, basis = $3, legal_hold = $4, deleted = $5
       WHERE evidence_id = $1`,
      [e.evidenceId, e.until, e.basis, e.legalHold, e.deleted],
    );
  }

  async listEvidenceBySubject(subjectOrPassport: string): Promise<EvidenceRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM ledger_evidence
         WHERE deleted = false
           AND (links->>'subject' = $1 OR links->>'passport' = $1)`,
      [subjectOrPassport],
    );
    return r.rows.map(rowToEvidence);
  }

  // ── Checkpoints ───────────────────────────────────────────────────────────────
  async putCheckpoint(c: CheckpointRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_checkpoint
         (checkpoint_id, log_id, tree_size, root_hash, timestamp, tx_hash, on_chain_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.checkpointId, c.logId, c.treeSize, c.rootHash, c.timestamp, c.txHash ?? null, c.onChainId ?? null],
    );
  }

  async getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM ledger_checkpoint WHERE checkpoint_id = $1", [
      checkpointId,
    ]);
    return r.rows[0] ? rowToCheckpoint(r.rows[0]) : undefined;
  }

  async latestCheckpoint(logId: string): Promise<CheckpointRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM ledger_checkpoint WHERE log_id = $1 ORDER BY tree_size DESC LIMIT 1",
      [logId],
    );
    return r.rows[0] ? rowToCheckpoint(r.rows[0]) : undefined;
  }

  // ── Per-log leaves ──────────────────────────────────────────────────────────────
  async appendLeaf(logId: string, leafHex: string): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO ledger_leaf (log_id, leaf_index, leaf_bytes)
       VALUES ($1, (SELECT COALESCE(MAX(leaf_index) + 1, 0) FROM ledger_leaf WHERE log_id = $1), $2)
       RETURNING leaf_index`,
      [logId, leafHex],
    );
    return Number(r.rows[0].leaf_index);
  }

  async getLeaves(logId: string): Promise<string[]> {
    const r = await this.pool.query(
      "SELECT leaf_bytes FROM ledger_leaf WHERE log_id = $1 ORDER BY leaf_index ASC",
      [logId],
    );
    return r.rows.map((row) => row.leaf_bytes as string);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── row mappers ────────────────────────────────────────────────────────────────

function rowToAttestation(row: Record<string, unknown>): AttestationRecord {
  return {
    registryId: row.registry_id as string,
    subject: row.subject as string,
    issuer: row.issuer as string,
    recordType: row.record_type as string,
    contentHash: row.content_hash as string,
    hashAlg: row.hash_alg as string,
    status: row.status as RecordStatus,
    tenant: row.tenant as string,
    logId: row.log_id as string,
    leafIndex: Number(row.leaf_index),
    leafHash: row.leaf_hash as string,
    passport: (row.passport as string | null) ?? undefined,
    links: (row.links as Record<string, unknown> | null) ?? undefined,
    issuedAt: row.issued_at ? new Date(row.issued_at as string).toISOString() : undefined,
    anchoredAt: new Date(row.anchored_at as string).toISOString(),
  };
}

function rowToStatus(row: Record<string, unknown>): StatusEntry {
  return {
    registryId: row.registry_id as string,
    status: row.status as RecordStatus,
    since: new Date(row.since as string).toISOString(),
    reason: (row.reason as string | null) ?? undefined,
    supersededBy: (row.superseded_by as string | null) ?? undefined,
    actor: row.actor as string,
    logId: row.log_id as string,
    leafIndex: Number(row.leaf_index),
    leafHash: row.leaf_hash as string,
  };
}

function rowToEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    evidenceId: row.evidence_id as string,
    contentHash: row.content_hash as string,
    hashAlg: row.hash_alg as string,
    until: typeof row.retention_until === "string"
      ? row.retention_until
      : new Date(row.retention_until as string).toISOString().slice(0, 10),
    basis: row.basis as string,
    legalHold: row.legal_hold as boolean,
    tenant: row.tenant as string,
    logId: row.log_id as string,
    leafIndex: Number(row.leaf_index),
    links: (row.links as Record<string, unknown> | null) ?? undefined,
    anchoredAt: new Date(row.anchored_at as string).toISOString(),
    deleted: row.deleted as boolean,
  };
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRecord {
  return {
    checkpointId: row.checkpoint_id as string,
    logId: row.log_id as string,
    treeSize: Number(row.tree_size),
    rootHash: row.root_hash as string,
    timestamp: new Date(row.timestamp as string).toISOString(),
    txHash: (row.tx_hash as string | null) ?? undefined,
    onChainId: (row.on_chain_id as string | null) ?? undefined,
  };
}
