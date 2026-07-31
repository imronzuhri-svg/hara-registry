/**
 * `@hara/registry-ledger-sdk` — TypeScript client + standalone verifier for the
 * HARA Registry Ledger.
 *
 * The Registry Ledger is a per-tenant RFC 6962/9162 Merkle transparency log
 * whose tree heads are anchored on-chain via a Ledger-scoped `PQAnchorRegistry`
 * (chain 131216, hybrid ECDSA + ML-DSA-65). Writes are tenant-scoped from a
 * Numira token; proofs and status are public. Only hashes and DIDs cross the
 * seam — never tenant payloads.
 *
 * The verifier (`verifyInclusion`, `verifyConsistency`) is standalone and
 * dependency-free: auditors can check proofs OFFLINE with no call to the Ledger.
 */

export { RegistryLedger } from './client.js';
export type { RegistryLedgerOptions } from './client.js';

export { TokenAuth } from './auth.js';
export type { AuthProvider, FetchLike, TokenSource } from './auth.js';

export { ProblemError, isProblem } from './errors.js';

export {
  verifyInclusion,
  verifyConsistency,
  verifySthAnchored,
  leafHash,
  nodeHash,
  hexToBytes,
  bytesToHex,
  toBytes,
} from './verifier.js';
export type { HashInput, SthAnchoredOptions } from './verifier.js';

export type {
  Hash,
  Did,
  HashAlg,
  RecordType,
  AttestationStatus,
  StatusAction,
  AttestationRequest,
  Anchor,
  STH,
  InclusionProof,
  ConsistencyProof,
  AttestationLog,
  Attestation,
  InclusionResponse,
  StatusRecord,
  RevokeRequest,
  CheckpointRequest,
  Checkpoint,
  ConsistencyResponse,
  Retention,
  EvidenceRetentionRequest,
  EvidenceRequest,
  Evidence,
  RetentionUpdate,
  VerifyBundleAttestation,
  VerifyBundleCheckpoint,
  VerifyBundle,
  Problem,
} from './types.js';
