/**
 * Store interface + factory.
 *
 * The store holds the ledger's metadata — everything the transparency-log tree
 * and the chain do NOT: the registry_id ↔ contentHash link (natural idempotency),
 * subject/issuer/tenant, per-attestation status history, evidence + retention
 * commitments, submitted checkpoints, and the raw per-log leaf bytes (so a
 * persistent deployment can rebuild each RFC 6962 tree on boot). Hashes + DIDs
 * only — never tenant payloads.
 *
 * Mirrors services/gapura-gateway/src/store/index.ts.
 */

import { config } from "../config.js";
import type { RecordStatus, RecordType } from "../types.js";

/** One anchored attestation. */
export interface AttestationRecord {
  registryId: string;
  subject: string;
  issuer: string;
  recordType: RecordType | string;
  contentHash: string; // lowercased; natural idempotency key (per tenant)
  hashAlg: string;
  status: RecordStatus;
  tenant: string; // the token's tenant DID that anchored it
  logId: string;
  leafIndex: number;
  leafHash: string;
  /** Optional passport DID this record backs (from links.passport) — verify lookup. */
  passport?: string;
  links?: Record<string, unknown>;
  issuedAt?: string;
  anchoredAt: string;
}

/** One status change (each is itself an anchored leaf). */
export interface StatusEntry {
  registryId: string;
  status: RecordStatus;
  since: string;
  reason?: string | null;
  supersededBy?: string | null;
  actor: string; // actor DID (token tenant)
  logId: string;
  leafIndex: number;
  leafHash: string;
}

/** One evidence hash under retention-of-authority. */
export interface EvidenceRecord {
  evidenceId: string;
  contentHash: string; // lowercased; idempotency key (per tenant)
  hashAlg: string;
  until: string; // date (retention expiry)
  basis: string;
  legalHold: boolean;
  tenant: string;
  logId: string;
  leafIndex: number;
  links?: Record<string, unknown>;
  anchoredAt: string;
  deleted: boolean;
}

/** One submitted event-chain checkpoint. */
export interface CheckpointRecord {
  checkpointId: string;
  logId: string;
  treeSize: number;
  rootHash: string;
  timestamp: string;
  txHash?: string;
  onChainId?: string;
}

export interface Store {
  // Attestations
  getAttestationById(registryId: string): Promise<AttestationRecord | undefined>;
  getAttestationByContentHash(tenant: string, contentHash: string): Promise<AttestationRecord | undefined>;
  putAttestation(rec: AttestationRecord): Promise<void>;
  setAttestationStatus(registryId: string, status: RecordStatus): Promise<void>;
  listAttestationsBySubject(subjectOrPassport: string): Promise<AttestationRecord[]>;

  // Status history
  appendStatus(entry: StatusEntry): Promise<void>;
  getLatestStatus(registryId: string): Promise<StatusEntry | undefined>;

  // Evidence + retention
  getEvidenceById(evidenceId: string): Promise<EvidenceRecord | undefined>;
  getEvidenceByContentHash(tenant: string, contentHash: string): Promise<EvidenceRecord | undefined>;
  putEvidence(rec: EvidenceRecord): Promise<void>;
  updateEvidence(rec: EvidenceRecord): Promise<void>;
  listEvidenceBySubject(subjectOrPassport: string): Promise<EvidenceRecord[]>;

  // Checkpoints
  putCheckpoint(rec: CheckpointRecord): Promise<void>;
  getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined>;
  latestCheckpoint(logId: string): Promise<CheckpointRecord | undefined>;

  // Per-log raw leaf bytes (hex) — the durable source for rebuilding a tree.
  appendLeaf(logId: string, leafHex: string): Promise<number>;
  getLeaves(logId: string): Promise<string[]>;

  close(): Promise<void>;
}

/**
 * Build the store from config: empty PG_URL => in-memory (DEFAULT, works out of
 * the box); otherwise the pg-backed store (skeleton — see postgres.ts).
 */
export async function createStore(): Promise<Store> {
  if (config.pgUrl) {
    const { PostgresStore } = await import("./postgres.js");
    return PostgresStore.create(config.pgUrl);
  }
  const { MemoryStore } = await import("./memory.js");
  return new MemoryStore();
}
