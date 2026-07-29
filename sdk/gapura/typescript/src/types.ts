/**
 * Type definitions for the HARA Gapura Gateway API.
 *
 * Mirrors `doc/api/openapi-gapura.yaml` and `gapura-integration-guide.md`.
 * The Gateway is a HARA-operated facade over PQAnchorRegistry (chain 131216):
 * callers send hashes and DIDs only — never geometry, never PII.
 *
 * Every anchor is inherently dual-signed (hybrid ECDSA + ML-DSA-65). There is
 * no external second chain and no flag to set.
 */

/** How a `digest` was computed. */
export type HashAlg = 'sha256' | 'keccak256';

/** Anchor / anchor-tx lifecycle state. QBFT instant finality → usually `confirmed`. */
export type AnchorStatusEnum = 'pending' | 'confirmed' | 'failed';

/** OAuth2 scopes that gate each Gateway domain (Authentik client-credentials). */
export type Scope =
  | 'anchor:write'
  | 'anchor:read'
  | 'identity:read'
  | 'identity:write'
  | 'metering:read';

/**
 * 32-byte hex hash, `0x`-prefixed (pattern `^0x[0-9a-fA-F]{64}$`).
 * Hashes only — never geometry or PII.
 */
export type Digest = string;

/** A `did:hara` identifier, e.g. `did:hara:obj:mp:8f3a...`. */
export type Did = string;

/** The dual (hybrid) signature — always both present on a real anchor. */
export interface Signatures {
  ecdsa: boolean;
  mlDsa65: boolean;
}

/** On-chain transaction reference for an anchor / DID registration. */
export interface TxRef {
  chainId?: number;
  contract?: string;
  txHash?: string;
  /** PQAnchorRegistry uint256 anchor id, string-encoded. */
  onChainId?: string;
  blockNumber?: number;
  logIndex?: number;
}

/** Request body for `POST /anchors`. */
export interface AnchorRequest {
  /** REQUIRED. 32-byte hex hash, hashes only. */
  digest: Digest;
  /** How `digest` was computed. Defaults to `sha256` server-side. */
  hashAlg?: HashAlg;
  /** REQUIRED. The Map Passport / credential subject DID. */
  objectDid: Did;
  /** REQUIRED. Enum-ish tag, e.g. `map-passport | eudr-dds | credential`. */
  purpose: string;
  /** OPTIONAL. Who initiated (provenance / "by whom"). */
  actorDid?: Did;
  /** OPTIONAL. Small, NO PII, NO geometry. */
  metadata?: Record<string, unknown>;
}

/** An anchor record — response of `POST /anchors`, `GET /anchors/{anchorId}`. */
export interface Anchor {
  /** Gateway id (stable, url-safe), e.g. `gap_anc_01HZX...`. */
  anchorId: string;
  /** PQAnchorRegistry anchor id (uint256, string-encoded). */
  onChainId?: string;
  digest?: Digest;
  objectDid?: Did;
  purpose?: string;
  status?: AnchorStatusEnum;
  txRef?: TxRef;
  /** ML-DSA-65 pubkey hash this anchor is frozen against. */
  pqKeyHash?: string;
  signatures?: Signatures;
  anchoredAt?: string;
}

/** Who anchored a digest, as reported in a verification result. */
export interface AnchoredBy {
  tenant?: string;
  actorDid?: Did;
}

/** Per-anchor verification detail. ECDSA-on-chain + PQ-verified together = the dual/hybrid proof. */
export interface AnchorVerification {
  /** The `recordAnchor` tx is on-chain (existence + timestamp). */
  ecdsaOnChain?: boolean;
  /** Gateway re-checked the ML-DSA-65 sig off-chain against `pqKeyHash`. */
  pqVerified?: boolean;
  pqKeyHash?: string;
}

/** One anchor entry inside a `VerifyResult`. */
export interface VerifyResultAnchor {
  anchorId?: string;
  objectDid?: Did;
  purpose?: string;
  anchoredBy?: AnchoredBy;
  anchoredAt?: string;
  txRef?: TxRef;
  verification?: AnchorVerification;
  status?: AnchorStatusEnum;
}

/** Result of a verify call (`GET /anchors?digest=` or `POST /verify`). */
export interface VerifyResult {
  digest?: Digest;
  anchored: boolean;
  anchors: VerifyResultAnchor[];
  asOf?: string;
}

/** Cost of an anchor tx. Permissioned chain, gasPrice 0 — no fee. */
export interface AnchorCost {
  gas?: string;
  unit?: string;
  note?: string;
}

/** Response of `GET /anchors/{anchorId}/status`. */
export interface AnchorStatus {
  anchorId: string;
  status: AnchorStatusEnum;
  confirmations?: number;
  blockNumber?: number | null;
  cost?: AnchorCost;
  signatures?: Signatures;
  failureReason?: string | null;
}

/** Metadata on a resolved DID document. */
export interface DidDocumentMetadata {
  anchored?: boolean;
  created?: string;
  updated?: string;
  deactivated?: boolean;
  backing?: 'on-chain-issuer' | 'sidetree';
}

/** W3C DID Resolution result (`GET /did/{did}`). */
export interface DidResolution {
  didDocument?: Record<string, unknown>;
  didResolutionMetadata?: Record<string, unknown>;
  didDocumentMetadata?: DidDocumentMetadata;
}

/** Request body for `POST /identities`. */
export interface IdentityRequest {
  subjectType: 'authority' | 'tenant-org' | 'actor';
  displayName: string;
  /** Caller-supplied public key; the Gateway never sees private keys. */
  controllerJwk?: Record<string, unknown>;
  /** Maps to a `did:hara` sub-namespace, e.g. `authority`. */
  namespaceHint?: string;
}

/** Registration detail returned inside `IdentityRegistration`. */
export interface Registration {
  backing?: 'on-chain-issuer' | 'sidetree';
  txRef?: TxRef;
  state?: 'confirmed' | 'batching';
}

/** Response of `POST /identities` (`201`). */
export interface IdentityRegistration {
  did?: Did;
  didDocument?: Record<string, unknown>;
  registration?: Registration;
}

/** Async operation state (Sidetree batching; `202` + poll). */
export interface Operation {
  operationId?: string;
  state?: 'batching' | 'confirmed' | 'failed';
  did?: Did;
}

/** DID ↔ Authentik subject binding. */
export interface Binding {
  authentikSub?: string;
  did?: Did;
  tenant?: string;
  boundAt?: string;
}

/** Geometry-blind usage counters. */
export interface UsageMetrics {
  numiraIdResolutions?: number;
  atlasDidMints?: number;
  passportVerifications?: number;
  anchorTxCount?: number;
  anchorCostUnits?: number;
}

/** Query period echoed back in a usage response. */
export interface UsagePeriod {
  from?: string;
  to?: string;
  granularity?: string;
}

/** Response of `GET /metering/usage`. */
export interface Usage {
  tenant?: string;
  period?: UsagePeriod;
  metrics?: UsageMetrics;
  /** Present when `granularity=day` (or `month`). */
  series?: Array<Record<string, unknown>>;
  quotas?: Record<string, unknown>;
  generatedAt?: string;
}

/** A single quota bucket. */
export interface Quota {
  limit?: number;
  used?: number;
  resetsAt?: string;
}

/** Response of `GET /metering/quotas`. */
export interface Quotas {
  tenant?: string;
  quotas?: Record<string, Quota>;
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
