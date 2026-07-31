/**
 * Type definitions for the HARA Registry Ledger API.
 *
 * Mirrors `doc/api/openapi-aurum-ledger.yaml` and `aurum-ledger-integration-guide.md`.
 * The Registry Ledger is a per-tenant RFC 6962/9162 Merkle transparency log whose
 * tree heads are anchored on-chain via a Ledger-scoped `PQAnchorRegistry`
 * (chain 131216, hybrid ECDSA + ML-DSA-65).
 *
 * Only hashes and DIDs cross the seam — never tenant payloads.
 */

/** 32-byte hex hash, `0x`-prefixed (pattern `^0x[0-9a-fA-F]{64}$`). Hashes only — never tenant payload. */
export type Hash = string;

/** A `did:hara` identifier, e.g. `did:hara:report:7f3a9c21-4e88`. */
export type Did = string;

/** Supported hash algorithm for content hashes. */
export type HashAlg = 'sha256';

/** Kind of record being attested. */
export type RecordType =
  | 'surveyor-report'
  | 'assay'
  | 'gate-decision'
  | 'custody-event'
  | 'other';

/** Status-of-record for an attestation. */
export type AttestationStatus = 'active' | 'superseded' | 'revoked';

/** Status-change action for `POST /attestations/{id}/revoke`. */
export type StatusAction = 'revoke' | 'supersede';

/** Request body for `POST /attestations`. */
export interface AttestationRequest {
  /** REQUIRED. The record DID being attested. */
  subject: Did;
  /** REQUIRED. Issuer DID; must match the token's tenant scope. */
  issuer: Did;
  /** REQUIRED. Kind of record. */
  recordType: RecordType;
  /** REQUIRED. sha256 of the canonical signed record (hashes only). */
  contentHash: Hash;
  /** How `contentHash` was computed. Defaults to `sha256` server-side. */
  hashAlg?: HashAlg;
  /** When the record was issued (RFC 3339). */
  issuedAt?: string;
  /** The VC's own signature (verifiable offline). */
  vcProof?: Record<string, unknown>;
  /** Optional links, e.g. `{ passport: "did:hara:passport:…" }`. */
  links?: Record<string, unknown>;
}

/** On-chain commitment of the STH root + size. */
export interface Anchor {
  /** EVM chain id (131216 for the HARA chain). */
  chainId?: number;
  /** `recordAnchor` transaction hash. */
  txHash?: string;
  /** PQAnchorRegistry anchor id (uint256, string-encoded). */
  onChainId?: string;
  /** Address of the Ledger-scoped PQAnchorRegistry instance. */
  contract?: string;
}

/** Signed Tree Head — the anchored root a proof resolves against. */
export interface STH {
  log_id?: string;
  tree_size: number;
  root_hash: Hash;
  timestamp?: string;
  anchor?: Anchor;
}

/** RFC 6962 inclusion proof for a single leaf. */
export interface InclusionProof {
  leaf_index: number;
  tree_size: number;
  /** Audit path, bottom-up, as `0x`-prefixed hashes. */
  audit_path: Hash[];
}

/** RFC 6962 consistency proof between two tree sizes. */
export interface ConsistencyProof {
  first_size: number;
  second_size: number;
  consistency_path: Hash[];
}

/** Reference to the leaf inside the transparency log. */
export interface AttestationLog {
  log_id?: string;
  leaf_index?: number;
  leaf_hash?: Hash;
}

/** Response of `POST /attestations` and `GET /attestations/{id}`. */
export interface Attestation {
  registry_id: string;
  subject?: Did;
  issuer?: Did;
  recordType?: string;
  status?: AttestationStatus;
  anchored_at?: string;
  log?: AttestationLog;
  inclusion_proof?: InclusionProof;
  sth?: STH;
}

/** Response of `GET /attestations/{id}/proof`. */
export interface InclusionResponse {
  registry_id?: string;
  inclusion_proof: InclusionProof;
  sth: STH;
}

/** Response of `GET /attestations/{id}/status` and `POST /attestations/{id}/revoke`. */
export interface StatusRecord {
  registry_id?: string;
  status: AttestationStatus;
  since?: string;
  reason?: string | null;
  supersededBy?: string | null;
  actor?: Did;
  proof?: InclusionProof;
  sth?: STH;
}

/** Request body for `POST /attestations/{id}/revoke`. */
export interface RevokeRequest {
  action: StatusAction;
  reason: string;
  supersededBy?: string | null;
}

/** Request body for `POST /anchors`. */
export interface CheckpointRequest {
  log_id: string;
  tree_size: number;
  root_hash: Hash;
}

/** Response of `POST /anchors`. */
export interface Checkpoint {
  checkpoint_id?: string;
  sth: STH;
}

/** Response of `GET /anchors/consistency`. */
export interface ConsistencyResponse {
  log_id?: string;
  first: STH;
  second: STH;
  consistency_path: Hash[];
}

/** Retention-of-record state for a piece of evidence. */
export interface Retention {
  until?: string;
  basis?: string;
  legalHold?: boolean;
  /** false while under retention/hold. */
  deletable?: boolean;
}

/** Retention block inside an `EvidenceRequest`. */
export interface EvidenceRetentionRequest {
  /** RECORD-OF-AUTHORITY expiry date (YYYY-MM-DD). */
  until: string;
  /** Legal basis, e.g. `EUDR-Art38-5yr`. */
  basis: string;
  /** Defaults to false. */
  legalHold?: boolean;
}

/** Request body for `POST /evidence`. */
export interface EvidenceRequest {
  contentHash: Hash;
  hashAlg?: HashAlg;
  retention: EvidenceRetentionRequest;
  links?: Record<string, unknown>;
}

/** Response of `POST /evidence` and `GET /evidence/{id}`. */
export interface Evidence {
  evidence_id: string;
  contentHash?: Hash;
  anchored?: boolean;
  retention?: Retention;
  sth?: STH;
}

/** Request body for `PATCH /evidence/{id}`. */
export interface RetentionUpdate {
  legalHold?: boolean;
  /** Extend retention (never shorten below the recorded basis). YYYY-MM-DD. */
  extendUntil?: string;
}

/** One attestation entry inside a {@link VerifyBundle}. */
export interface VerifyBundleAttestation {
  registry_id?: string;
  recordType?: string;
  status?: AttestationStatus;
  subject?: Did;
  issuer?: Did;
  inclusion_proof?: InclusionProof;
  sth?: STH;
}

/** One checkpoint entry inside a {@link VerifyBundle}. */
export interface VerifyBundleCheckpoint {
  log_id?: string;
  sth?: STH;
}

/** Response of `GET /verify` — an offline-verifiable bundle for a passport. */
export interface VerifyBundle {
  subject?: Did;
  generated_at?: string;
  attestations?: VerifyBundleAttestation[];
  checkpoints?: VerifyBundleCheckpoint[];
  evidence?: Evidence[];
}

/** RFC 9457 `application/problem+json` body. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  /** Stable machine code (SDK maps to `ProblemError.code`). */
  code?: string;
  detail?: string;
  instance?: string;
  traceId?: string;
}
