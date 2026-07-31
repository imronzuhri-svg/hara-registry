/**
 * Ledger service — orchestration core wiring the transparency log, the store, and
 * the on-chain anchor service into the operations the routes expose.
 *
 * REAL. Owns an in-memory registry of RFC 6962 TransparencyLog instances (one per
 * log_id), each lazily rebuilt from the store's durable leaf table. Every
 * append produces an anchored (or, in dev, locally-signed) Signed Tree Head and an
 * offline-verifiable inclusion proof.
 *
 * Log-id convention:
 *   • attestation / status / evidence leaves for a tenant → `tenant:<slug>`
 *     (slug = the tail of did:hara:tenant:<slug>), matching the guide's example
 *     log_id "tenant:surveyor-psi".
 *   • event-chain checkpoints use the client-supplied log_id (e.g.
 *     "tenant:surveyor-psi:events").
 */

import { randomBytes } from "node:crypto";
import pino from "pino";

import { ProblemError } from "../errors.js";
import { TransparencyLog, fromHex, toHex } from "../transparency-log.js";
import type { Store } from "../store/index.js";
import type { AnchorService } from "./anchor.js";
import type {
  Attestation,
  AttestationRequest,
  Checkpoint,
  ConsistencyResponse,
  Evidence,
  EvidenceRequest,
  InclusionResponse,
  RecordStatus,
  Retention,
  STH,
  StatusRecord,
  VerifyBundle,
} from "../types.js";

const log = pino({ name: "registry-ledger-core" });

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf-8"));
}

function randId(prefix: string, bytes = 8): string {
  return prefix + randomBytes(bytes).toString("hex");
}

/** did:hara:tenant:surveyor-psi → tenant:surveyor-psi (the guide's log_id form). */
function tenantLogId(tenantDid: string): string {
  const slug = tenantDid.replace(/^did:hara:tenant:/, "");
  return `tenant:${slug}`;
}

// ── canonical leaf encodings (deterministic; auditors can recompute) ──────────

function attestationLeaf(a: {
  registryId: string;
  contentHash: string;
  subject: string;
  issuer: string;
  recordType: string;
}): Uint8Array {
  return utf8(
    ["att", a.registryId, a.contentHash.toLowerCase(), a.subject, a.issuer, a.recordType].join("\n"),
  );
}

function statusLeaf(s: {
  registryId: string;
  status: RecordStatus;
  since: string;
  actor: string;
  supersededBy?: string | null;
}): Uint8Array {
  return utf8(
    ["status", s.registryId, s.status, s.since, s.actor, s.supersededBy ?? ""].join("\n"),
  );
}

function evidenceLeaf(e: {
  evidenceId: string;
  contentHash: string;
  until: string;
  basis: string;
  legalHold: boolean;
}): Uint8Array {
  return utf8(
    ["evidence", e.evidenceId, e.contentHash.toLowerCase(), e.until, e.basis, String(e.legalHold)].join("\n"),
  );
}

function deleteAttemptLeaf(e: { evidenceId: string; at: string; actor: string }): Uint8Array {
  return utf8(["evidence-delete-refused", e.evidenceId, e.at, e.actor].join("\n"));
}

export class LedgerService {
  private logs = new Map<string, TransparencyLog>();

  constructor(
    private readonly store: Store,
    private readonly anchors: AnchorService,
  ) {}

  /** Lazily build/return the TransparencyLog for a log_id, seeded from the store. */
  private async getLog(logId: string): Promise<TransparencyLog> {
    let tl = this.logs.get(logId);
    if (!tl) {
      const leaves = await this.store.getLeaves(logId);
      tl = new TransparencyLog(logId, leaves.map(fromHex));
      this.logs.set(logId, tl);
    }
    return tl;
  }

  /** Append a raw leaf to a log + persist it; returns {leafIndex, leafHash, sth, tl}. */
  private async appendAndAnchor(
    logId: string,
    leaf: Uint8Array,
  ): Promise<{ leafIndex: number; leafHash: string; treeSize: number; root: string; sth: STH; tl: TransparencyLog }> {
    const tl = await this.getLog(logId);
    const leafIndex = tl.append(leaf);
    await this.store.appendLeaf(logId, toHex(leaf));
    const leafHash = tl.leafHashHex(leafIndex);
    const treeSize = tl.treeSize();
    const root = tl.currentRootHex();
    const sth = await this.anchors.anchorSTH(logId, root, treeSize);
    return { leafIndex, leafHash, treeSize, root, sth, tl };
  }

  // ── Attestations ─────────────────────────────────────────────────────────────

  /**
   * Anchor an attestation. Idempotent on (tenant, contentHash): a re-submit of a
   * known hash returns the existing record (route answers 200).
   */
  async anchorAttestation(
    req: AttestationRequest,
    tenant: string,
  ): Promise<{ attestation: Attestation; alreadyAnchored: boolean }> {
    const contentHash = req.contentHash.toLowerCase();

    const existing = await this.store.getAttestationByContentHash(tenant, contentHash);
    if (existing) {
      return { attestation: await this.buildAttestationDto(existing), alreadyAnchored: true };
    }

    const logId = tenantLogId(tenant);
    const registryId = randId("reg:att:");
    const leaf = attestationLeaf({
      registryId,
      contentHash,
      subject: req.subject,
      issuer: req.issuer,
      recordType: req.recordType,
    });
    const { leafIndex, leafHash, sth } = await this.appendAndAnchor(logId, leaf);
    const anchoredAt = new Date().toISOString();

    const passport =
      req.links && typeof req.links["passport"] === "string"
        ? (req.links["passport"] as string)
        : undefined;

    await this.store.putAttestation({
      registryId,
      subject: req.subject,
      issuer: req.issuer,
      recordType: req.recordType,
      contentHash,
      hashAlg: req.hashAlg ?? "sha256",
      status: "active",
      tenant,
      logId,
      leafIndex,
      leafHash,
      passport,
      links: req.links,
      issuedAt: req.issuedAt,
      anchoredAt,
    });
    // The initial "active" status references the attestation leaf itself.
    await this.store.appendStatus({
      registryId,
      status: "active",
      since: anchoredAt,
      actor: req.issuer,
      logId,
      leafIndex,
      leafHash,
    });

    const tl = await this.getLog(logId);
    const inclusion = tl.inclusionProof(leafIndex, tl.treeSize());

    log.info({ registryId, logId, leafIndex }, "attestation anchored");
    return {
      attestation: {
        registry_id: registryId,
        subject: req.subject,
        issuer: req.issuer,
        recordType: req.recordType,
        status: "active",
        anchored_at: anchoredAt,
        log: { log_id: logId, leaf_index: leafIndex, leaf_hash: leafHash },
        inclusion_proof: inclusion,
        sth,
      },
      alreadyAnchored: false,
    };
  }

  async getAttestation(registryId: string): Promise<Attestation> {
    const rec = await this.store.getAttestationById(registryId);
    if (!rec) throw new ProblemError("not_found", registryId);
    return this.buildAttestationDto(rec);
  }

  private async buildAttestationDto(rec: {
    registryId: string;
    subject: string;
    issuer: string;
    recordType: string;
    status: RecordStatus;
    logId: string;
    leafIndex: number;
    leafHash: string;
    anchoredAt: string;
  }): Promise<Attestation> {
    const tl = await this.getLog(rec.logId);
    const treeSize = tl.treeSize();
    const inclusion = tl.inclusionProof(rec.leafIndex, treeSize);
    const sth = await this.anchors.anchorSTH(rec.logId, tl.currentRootHex(), treeSize);
    return {
      registry_id: rec.registryId,
      subject: rec.subject,
      issuer: rec.issuer,
      recordType: rec.recordType,
      status: rec.status,
      anchored_at: rec.anchoredAt,
      log: { log_id: rec.logId, leaf_index: rec.leafIndex, leaf_hash: rec.leafHash },
      inclusion_proof: inclusion,
      sth,
    };
  }

  /** Inclusion proof against the latest STH (or an explicit tree_size). */
  async getInclusion(registryId: string, treeSize?: number): Promise<InclusionResponse> {
    const rec = await this.store.getAttestationById(registryId);
    if (!rec) throw new ProblemError("not_found", registryId);
    const tl = await this.getLog(rec.logId);
    const size = treeSize ?? tl.treeSize();
    if (size < 1 || size > tl.treeSize() || rec.leafIndex >= size) {
      throw new ProblemError(
        "proof_unavailable",
        `no inclusion proof for leaf ${rec.leafIndex} at tree_size ${size}`,
      );
    }
    const inclusion = tl.inclusionProof(rec.leafIndex, size);
    const sth = await this.anchors.anchorSTH(rec.logId, tl.rootAtHex(size), size);
    return { registry_id: registryId, inclusion_proof: inclusion, sth };
  }

  /** Status of record (public). Each change is an anchored leaf. */
  async getStatusRecord(registryId: string): Promise<StatusRecord> {
    const rec = await this.store.getAttestationById(registryId);
    if (!rec) throw new ProblemError("not_found", registryId);
    const latest = await this.store.getLatestStatus(registryId);
    const tl = await this.getLog(rec.logId);
    const treeSize = tl.treeSize();
    const leafIndex = latest?.leafIndex ?? rec.leafIndex;
    const proof = tl.inclusionProof(leafIndex, treeSize);
    const sth = await this.anchors.anchorSTH(rec.logId, tl.currentRootHex(), treeSize);
    return {
      registry_id: registryId,
      status: rec.status,
      since: latest?.since ?? rec.anchoredAt,
      reason: latest?.reason ?? null,
      supersededBy: latest?.supersededBy ?? null,
      actor: latest?.actor ?? rec.issuer,
      proof,
      sth,
    };
  }

  /**
   * Revoke / supersede (tenant-scoped, attributed, anchored). Appends a status
   * leaf, anchors the new STH, updates the record, returns the new status record.
   */
  async setStatus(
    registryId: string,
    action: "revoke" | "supersede",
    reason: string,
    supersededBy: string | null | undefined,
    actorTenant: string,
  ): Promise<StatusRecord> {
    const rec = await this.store.getAttestationById(registryId);
    if (!rec) throw new ProblemError("not_found", registryId);

    // Tenant-scoping: only the anchoring tenant may change status.
    if (rec.tenant !== actorTenant) {
      throw new ProblemError("forbidden_tenant", "attestation belongs to another tenant");
    }
    if (rec.status === "revoked") {
      throw new ProblemError("status_conflict", "attestation is already revoked");
    }

    const newStatus: RecordStatus = action === "revoke" ? "revoked" : "superseded";
    const since = new Date().toISOString();
    const leaf = statusLeaf({ registryId, status: newStatus, since, actor: actorTenant, supersededBy });
    const { leafIndex, leafHash, sth } = await this.appendAndAnchor(rec.logId, leaf);

    await this.store.appendStatus({
      registryId,
      status: newStatus,
      since,
      reason,
      supersededBy: supersededBy ?? null,
      actor: actorTenant,
      logId: rec.logId,
      leafIndex,
      leafHash,
    });
    await this.store.setAttestationStatus(registryId, newStatus);

    const tl = await this.getLog(rec.logId);
    const proof = tl.inclusionProof(leafIndex, tl.treeSize());
    log.info({ registryId, newStatus }, "status changed");
    return {
      registry_id: registryId,
      status: newStatus,
      since,
      reason,
      supersededBy: supersededBy ?? null,
      actor: actorTenant,
      proof,
      sth,
    };
  }

  // ── Checkpoints ───────────────────────────────────────────────────────────────

  /** Submit an event-chain checkpoint (root + size) → anchored STH. */
  async submitCheckpoint(logId: string, treeSize: number, rootHash: string): Promise<Checkpoint> {
    const checkpointId = randId("ckpt:");
    // Anchor the client-supplied head on-chain (or locally-sign it in dev).
    const sth = await this.anchors.anchorSTH(logId, rootHash.toLowerCase(), treeSize);
    await this.store.putCheckpoint({
      checkpointId,
      logId,
      treeSize,
      rootHash: rootHash.toLowerCase(),
      timestamp: sth.timestamp,
      txHash: sth.anchor?.txHash,
      onChainId: sth.anchor?.onChainId,
    });
    log.info({ checkpointId, logId, treeSize }, "checkpoint anchored");
    return { checkpoint_id: checkpointId, sth };
  }

  /**
   * Consistency proof that tree `to` extends tree `from`. Requires that the Ledger
   * holds the leaves for `logId` (i.e. leaves were appended via this service);
   * for a checkpoint-only log where only roots were submitted, we cannot derive an
   * RFC 6962 path → proof_unavailable.
   */
  async getConsistency(logId: string, from: number, to: number): Promise<ConsistencyResponse> {
    const leaves = await this.store.getLeaves(logId);
    if (leaves.length === 0) {
      throw new ProblemError(
        "proof_unavailable",
        `log ${logId} has no leaves on this Ledger (checkpoint-only) — cannot derive a consistency path`,
      );
    }
    const tl = await this.getLog(logId);
    if (from < 1 || to > tl.treeSize() || from > to) {
      throw new ProblemError("proof_unavailable", `invalid range from=${from} to=${to} size=${tl.treeSize()}`);
    }
    const cp = tl.consistencyProof(from, to);
    const first = await this.anchors.anchorSTH(logId, tl.rootAtHex(from), from);
    const second = await this.anchors.anchorSTH(logId, tl.rootAtHex(to), to);
    return { log_id: logId, first, second, consistency_path: cp.consistency_path };
  }

  // ── Evidence + retention ────────────────────────────────────────────────────────

  private toRetention(e: { until: string; basis: string; legalHold: boolean }): Retention {
    const now = new Date();
    const untilDate = new Date(e.until + "T00:00:00Z");
    const inFuture = untilDate.getTime() > now.getTime();
    return {
      until: e.until,
      basis: e.basis,
      legalHold: e.legalHold,
      deletable: !inFuture && !e.legalHold,
    };
  }

  /** Register a content hash under retention (idempotent on (tenant, contentHash)). */
  async registerEvidence(
    req: EvidenceRequest,
    tenant: string,
  ): Promise<{ evidence: Evidence; alreadyRegistered: boolean }> {
    const contentHash = req.contentHash.toLowerCase();
    const existing = await this.store.getEvidenceByContentHash(tenant, contentHash);
    if (existing) {
      return { evidence: await this.buildEvidenceDto(existing), alreadyRegistered: true };
    }

    const logId = tenantLogId(tenant);
    const evidenceId = randId("ev:");
    const legalHold = req.retention.legalHold ?? false;
    const leaf = evidenceLeaf({
      evidenceId,
      contentHash,
      until: req.retention.until,
      basis: req.retention.basis,
      legalHold,
    });
    const { leafIndex, sth } = await this.appendAndAnchor(logId, leaf);
    const anchoredAt = new Date().toISOString();

    const rec = {
      evidenceId,
      contentHash,
      hashAlg: req.hashAlg ?? "sha256",
      until: req.retention.until,
      basis: req.retention.basis,
      legalHold,
      tenant,
      logId,
      leafIndex,
      links: req.links,
      anchoredAt,
      deleted: false,
    };
    await this.store.putEvidence(rec);
    log.info({ evidenceId, until: rec.until, legalHold }, "evidence registered");
    return {
      evidence: {
        evidence_id: evidenceId,
        contentHash,
        anchored: sth.anchor !== undefined,
        retention: this.toRetention(rec),
        sth,
      },
      alreadyRegistered: false,
    };
  }

  async getEvidence(evidenceId: string): Promise<Evidence> {
    const rec = await this.store.getEvidenceById(evidenceId);
    if (!rec || rec.deleted) throw new ProblemError("not_found", evidenceId);
    return this.buildEvidenceDto(rec);
  }

  private async buildEvidenceDto(rec: {
    evidenceId: string;
    contentHash: string;
    until: string;
    basis: string;
    legalHold: boolean;
    logId: string;
    leafIndex: number;
  }): Promise<Evidence> {
    const tl = await this.getLog(rec.logId);
    const sth = await this.anchors.anchorSTH(rec.logId, tl.currentRootHex(), tl.treeSize());
    return {
      evidence_id: rec.evidenceId,
      contentHash: rec.contentHash,
      anchored: sth.anchor !== undefined,
      retention: this.toRetention(rec),
      sth,
    };
  }

  /**
   * Set/lift legal hold or EXTEND retention (never shorten below the recorded
   * basis). A shortening attempt → 409 status_conflict.
   */
  async updateRetention(
    evidenceId: string,
    patch: { legalHold?: boolean; extendUntil?: string },
    tenant: string,
  ): Promise<Evidence> {
    const rec = await this.store.getEvidenceById(evidenceId);
    if (!rec || rec.deleted) throw new ProblemError("not_found", evidenceId);
    if (rec.tenant !== tenant) {
      throw new ProblemError("forbidden_tenant", "evidence belongs to another tenant");
    }

    if (patch.extendUntil !== undefined) {
      const current = new Date(rec.until + "T00:00:00Z").getTime();
      const next = new Date(patch.extendUntil + "T00:00:00Z").getTime();
      if (Number.isNaN(next)) throw new ProblemError("invalid_request", "extendUntil must be YYYY-MM-DD");
      if (next < current) {
        throw new ProblemError("status_conflict", "retention can only be extended, never shortened");
      }
      rec.until = patch.extendUntil;
    }
    if (patch.legalHold !== undefined) {
      rec.legalHold = patch.legalHold;
    }
    await this.store.updateEvidence(rec);
    log.info({ evidenceId, until: rec.until, legalHold: rec.legalHold }, "retention updated");
    return this.buildEvidenceDto(rec);
  }

  /**
   * Attempt hard-delete. Refused (409 retention_locked) while `until` is in the
   * future OR legalHold is set — and the refused attempt is appended as a leaf +
   * anchored (auditable). After expiry with no hold, deletion is allowed + recorded.
   */
  async deleteEvidence(evidenceId: string, tenant: string): Promise<void> {
    const rec = await this.store.getEvidenceById(evidenceId);
    if (!rec || rec.deleted) throw new ProblemError("not_found", evidenceId);
    if (rec.tenant !== tenant) {
      throw new ProblemError("forbidden_tenant", "evidence belongs to another tenant");
    }

    const now = Date.now();
    const untilMs = new Date(rec.until + "T00:00:00Z").getTime();
    const locked = untilMs > now || rec.legalHold;

    if (locked) {
      // Refused — the attempt is itself anchored as an audit leaf.
      const at = new Date().toISOString();
      await this.appendAndAnchor(rec.logId, deleteAttemptLeaf({ evidenceId, at, actor: tenant }));
      log.warn({ evidenceId, until: rec.until, legalHold: rec.legalHold }, "delete refused (retention locked) — attempt anchored");
      throw new ProblemError(
        "retention_locked",
        `refused: retention until ${rec.until}${rec.legalHold ? " + legal hold" : ""}; the attempt has been anchored`,
      );
    }

    rec.deleted = true;
    await this.store.updateEvidence(rec);
    log.info({ evidenceId }, "evidence deleted (retention expired, no hold)");
  }

  // ── Verify bundle ────────────────────────────────────────────────────────────

  /** Public verification bundle for a passport DID (offline-verifiable). */
  async verifyBundle(subject: string): Promise<VerifyBundle> {
    const atts = await this.store.listAttestationsBySubject(subject);
    const evs = await this.store.listEvidenceBySubject(subject);

    const attestations = [];
    const checkpointLogs = new Set<string>();
    for (const rec of atts) {
      const tl = await this.getLog(rec.logId);
      const treeSize = tl.treeSize();
      const inclusion = tl.inclusionProof(rec.leafIndex, treeSize);
      const sth = await this.anchors.anchorSTH(rec.logId, tl.currentRootHex(), treeSize);
      attestations.push({
        registry_id: rec.registryId,
        recordType: rec.recordType,
        status: rec.status,
        subject: rec.subject,
        issuer: rec.issuer,
        inclusion_proof: inclusion,
        sth,
      });
      checkpointLogs.add(rec.logId);
    }

    const checkpoints = [];
    for (const logId of checkpointLogs) {
      const latest = await this.store.latestCheckpoint(logId);
      if (latest) {
        checkpoints.push({
          log_id: logId,
          sth: {
            log_id: logId,
            tree_size: latest.treeSize,
            root_hash: latest.rootHash,
            timestamp: latest.timestamp,
            anchor: latest.txHash
              ? { chainId: 0, txHash: latest.txHash, onChainId: latest.onChainId }
              : undefined,
          } as STH,
        });
      }
    }

    const evidence = [];
    for (const rec of evs) {
      evidence.push(await this.buildEvidenceDto(rec));
    }

    return {
      subject,
      generated_at: new Date().toISOString(),
      attestations,
      checkpoints,
      evidence,
    };
  }
}
