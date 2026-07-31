/**
 * In-memory store — the DEFAULT (used when PG_URL is unset). Works out of the
 * box for dev; non-persistent, single-process only.
 *
 * REAL implementation of the Store interface (just not durable).
 */

import type {
  AttestationRecord,
  CheckpointRecord,
  EvidenceRecord,
  StatusEntry,
  Store,
} from "./index.js";
import type { RecordStatus } from "../types.js";

export class MemoryStore implements Store {
  private attById = new Map<string, AttestationRecord>();
  private attByContent = new Map<string, AttestationRecord>(); // key: `${tenant}|${hash}`
  private statusByRegistry = new Map<string, StatusEntry[]>();
  private evById = new Map<string, EvidenceRecord>();
  private evByContent = new Map<string, EvidenceRecord>(); // key: `${tenant}|${hash}`
  private checkpointsById = new Map<string, CheckpointRecord>();
  private checkpointsByLog = new Map<string, CheckpointRecord[]>();
  private leavesByLog = new Map<string, string[]>();

  private static contentKey(tenant: string, hash: string): string {
    return `${tenant}|${hash.toLowerCase()}`;
  }

  // ── Attestations ─────────────────────────────────────────────────────────────
  async getAttestationById(registryId: string): Promise<AttestationRecord | undefined> {
    return this.attById.get(registryId);
  }

  async getAttestationByContentHash(
    tenant: string,
    contentHash: string,
  ): Promise<AttestationRecord | undefined> {
    return this.attByContent.get(MemoryStore.contentKey(tenant, contentHash));
  }

  async putAttestation(rec: AttestationRecord): Promise<void> {
    this.attById.set(rec.registryId, rec);
    this.attByContent.set(MemoryStore.contentKey(rec.tenant, rec.contentHash), rec);
  }

  async setAttestationStatus(registryId: string, status: RecordStatus): Promise<void> {
    const rec = this.attById.get(registryId);
    if (rec) rec.status = status;
  }

  async listAttestationsBySubject(subjectOrPassport: string): Promise<AttestationRecord[]> {
    const out: AttestationRecord[] = [];
    for (const rec of this.attById.values()) {
      if (rec.subject === subjectOrPassport || rec.passport === subjectOrPassport) {
        out.push(rec);
      }
    }
    return out;
  }

  // ── Status history ───────────────────────────────────────────────────────────
  async appendStatus(entry: StatusEntry): Promise<void> {
    const list = this.statusByRegistry.get(entry.registryId) ?? [];
    list.push(entry);
    this.statusByRegistry.set(entry.registryId, list);
  }

  async getLatestStatus(registryId: string): Promise<StatusEntry | undefined> {
    const list = this.statusByRegistry.get(registryId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  // ── Evidence + retention ──────────────────────────────────────────────────────
  async getEvidenceById(evidenceId: string): Promise<EvidenceRecord | undefined> {
    return this.evById.get(evidenceId);
  }

  async getEvidenceByContentHash(
    tenant: string,
    contentHash: string,
  ): Promise<EvidenceRecord | undefined> {
    return this.evByContent.get(MemoryStore.contentKey(tenant, contentHash));
  }

  async putEvidence(rec: EvidenceRecord): Promise<void> {
    this.evById.set(rec.evidenceId, rec);
    this.evByContent.set(MemoryStore.contentKey(rec.tenant, rec.contentHash), rec);
  }

  async updateEvidence(rec: EvidenceRecord): Promise<void> {
    this.evById.set(rec.evidenceId, rec);
    this.evByContent.set(MemoryStore.contentKey(rec.tenant, rec.contentHash), rec);
  }

  async listEvidenceBySubject(subjectOrPassport: string): Promise<EvidenceRecord[]> {
    const out: EvidenceRecord[] = [];
    for (const rec of this.evById.values()) {
      if (rec.deleted) continue;
      const links = rec.links ?? {};
      if (links["subject"] === subjectOrPassport || links["passport"] === subjectOrPassport) {
        out.push(rec);
      }
    }
    return out;
  }

  // ── Checkpoints ───────────────────────────────────────────────────────────────
  async putCheckpoint(rec: CheckpointRecord): Promise<void> {
    this.checkpointsById.set(rec.checkpointId, rec);
    const list = this.checkpointsByLog.get(rec.logId) ?? [];
    list.push(rec);
    this.checkpointsByLog.set(rec.logId, list);
  }

  async getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined> {
    return this.checkpointsById.get(checkpointId);
  }

  async latestCheckpoint(logId: string): Promise<CheckpointRecord | undefined> {
    const list = this.checkpointsByLog.get(logId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  // ── Per-log raw leaves ─────────────────────────────────────────────────────────
  async appendLeaf(logId: string, leafHex: string): Promise<number> {
    const list = this.leavesByLog.get(logId) ?? [];
    list.push(leafHex);
    this.leavesByLog.set(logId, list);
    return list.length - 1;
  }

  async getLeaves(logId: string): Promise<string[]> {
    return this.leavesByLog.get(logId) ?? [];
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
