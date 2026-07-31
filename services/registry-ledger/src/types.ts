/**
 * DTOs for the Registry Ledger API. Mirrors doc/api/openapi-aurum-ledger.yaml and
 * the public @hara/registry-ledger-sdk type surface so the Ledger and SDK never drift.
 *
 * Hashes + DIDs only — never tenant payloads.
 */

/** 32-byte hex hash, 0x-prefixed. */
export type Hash = string;
export type Did = string;

export type RecordType =
  | "surveyor-report"
  | "assay"
  | "gate-decision"
  | "custody-event"
  | "other";

export type RecordStatus = "active" | "superseded" | "revoked";

// ── on-chain anchor + STH ─────────────────────────────────────────────────────

export interface Anchor {
  chainId: number;
  txHash?: string;
  onChainId?: string;
  contract?: string;
}

/** Signed Tree Head — the anchored root a proof resolves against. */
export interface STH {
  log_id: string;
  tree_size: number;
  root_hash: Hash;
  timestamp: string;
  /** Present once the STH root is committed on-chain; absent for a local
   *  (unanchored) STH when anchor writes are disabled — see services/anchor.ts. */
  anchor?: Anchor;
}

export interface InclusionProofDTO {
  leaf_index: number;
  tree_size: number;
  audit_path: Hash[];
}

export interface ConsistencyProofDTO {
  first_size: number;
  second_size: number;
  consistency_path: Hash[];
}

// ── attestations ──────────────────────────────────────────────────────────────

export interface AttestationRequest {
  subject: Did;
  issuer: Did;
  recordType: RecordType;
  contentHash: Hash;
  hashAlg?: "sha256";
  issuedAt?: string;
  vcProof?: Record<string, unknown>;
  links?: Record<string, unknown>;
}

export interface Attestation {
  registry_id: string;
  subject: Did;
  issuer: Did;
  recordType: string;
  status: RecordStatus;
  anchored_at: string;
  log: {
    log_id: string;
    leaf_index: number;
    leaf_hash: Hash;
  };
  inclusion_proof: InclusionProofDTO;
  sth: STH;
}

export interface InclusionResponse {
  registry_id: string;
  inclusion_proof: InclusionProofDTO;
  sth: STH;
}

export interface StatusRecord {
  registry_id: string;
  status: RecordStatus;
  since: string;
  reason?: string | null;
  supersededBy?: string | null;
  actor: Did;
  proof: InclusionProofDTO;
  sth: STH;
}

export interface RevokeRequest {
  action: "revoke" | "supersede";
  reason: string;
  supersededBy?: string | null;
}

// ── checkpoints ───────────────────────────────────────────────────────────────

export interface CheckpointRequest {
  log_id: string;
  tree_size: number;
  root_hash: Hash;
}

export interface Checkpoint {
  checkpoint_id: string;
  sth: STH;
}

export interface ConsistencyResponse {
  log_id: string;
  first: STH;
  second: STH;
  consistency_path: Hash[];
}

// ── evidence / retention ──────────────────────────────────────────────────────

export interface Retention {
  until: string; // date
  basis: string;
  legalHold: boolean;
  /** false while under retention/hold. */
  deletable: boolean;
}

export interface EvidenceRequest {
  contentHash: Hash;
  hashAlg?: "sha256";
  retention: {
    until: string;
    basis: string;
    legalHold?: boolean;
  };
  links?: Record<string, unknown>;
}

export interface Evidence {
  evidence_id: string;
  contentHash: Hash;
  anchored: boolean;
  retention: Retention;
  sth: STH;
}

// ── verify bundle ─────────────────────────────────────────────────────────────

export interface VerifyBundleAttestation {
  registry_id: string;
  recordType: string;
  status: RecordStatus;
  subject: Did;
  issuer: Did;
  inclusion_proof: InclusionProofDTO;
  sth: STH;
}

export interface VerifyBundleCheckpoint {
  log_id: string;
  sth: STH;
}

export interface VerifyBundle {
  subject: Did;
  generated_at: string;
  attestations: VerifyBundleAttestation[];
  checkpoints: VerifyBundleCheckpoint[];
  evidence: Evidence[];
}

// ── problem+json ──────────────────────────────────────────────────────────────

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  traceId?: string;
}
