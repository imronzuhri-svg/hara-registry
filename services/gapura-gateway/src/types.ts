/**
 * DTOs for the Gapura Gateway API. Mirrors doc/api/openapi-gapura.yaml and the
 * public @hara/gapura-sdk type surface so the Gateway and SDK never drift.
 */

export type HashAlg = "sha256" | "keccak256";
export type AnchorStatusEnum = "pending" | "confirmed" | "failed";
export type Scope =
  | "anchor:write"
  | "anchor:read"
  | "identity:read"
  | "identity:write"
  | "metering:read";

/** 32-byte hex hash, 0x-prefixed. Hashes only — never geometry or PII. */
export type Digest = string;
export type Did = string;

export interface Signatures {
  ecdsa: boolean;
  mlDsa65: boolean;
}

export interface TxRef {
  chainId?: number;
  contract?: string;
  txHash?: string;
  onChainId?: string;
  blockNumber?: number;
  logIndex?: number;
}

export interface AnchorRequest {
  digest: Digest;
  hashAlg?: HashAlg;
  objectDid: Did;
  purpose: string;
  actorDid?: Did;
  metadata?: Record<string, unknown>;
}

export interface Anchor {
  anchorId: string;
  onChainId?: string;
  digest?: Digest;
  objectDid?: Did;
  purpose?: string;
  status?: AnchorStatusEnum;
  txRef?: TxRef;
  pqKeyHash?: string;
  signatures?: Signatures;
  anchoredAt?: string;
}

export interface AnchoredBy {
  tenant?: string;
  actorDid?: Did;
}

export interface AnchorVerification {
  ecdsaOnChain?: boolean;
  pqVerified?: boolean;
  pqKeyHash?: string;
}

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

export interface VerifyResult {
  digest?: Digest;
  anchored: boolean;
  anchors: VerifyResultAnchor[];
  asOf?: string;
}

export interface AnchorCost {
  gas?: string;
  unit?: string;
  note?: string;
}

export interface AnchorStatus {
  anchorId: string;
  status: AnchorStatusEnum;
  confirmations?: number;
  blockNumber?: number | null;
  cost?: AnchorCost;
  signatures?: Signatures;
  failureReason?: string | null;
}

export interface DidDocumentMetadata {
  anchored?: boolean;
  created?: string;
  updated?: string;
  deactivated?: boolean;
  backing?: "on-chain-issuer" | "sidetree";
}

export interface DidResolution {
  didDocument?: Record<string, unknown>;
  didResolutionMetadata?: Record<string, unknown>;
  didDocumentMetadata?: DidDocumentMetadata;
}

export interface IdentityRequest {
  subjectType: "authority" | "tenant-org" | "actor";
  displayName: string;
  controllerJwk?: Record<string, unknown>;
  namespaceHint?: string;
}

export interface Registration {
  backing?: "on-chain-issuer" | "sidetree";
  txRef?: TxRef;
  state?: "confirmed" | "batching";
}

export interface IdentityRegistration {
  did?: Did;
  didDocument?: Record<string, unknown>;
  registration?: Registration;
}

export interface Operation {
  operationId?: string;
  state?: "batching" | "confirmed" | "failed";
  did?: Did;
}

export interface Binding {
  authentikSub?: string;
  did?: Did;
  tenant?: string;
  boundAt?: string;
}

export interface UsageMetrics {
  numiraIdResolutions?: number;
  atlasDidMints?: number;
  passportVerifications?: number;
  anchorTxCount?: number;
  anchorCostUnits?: number;
}

export interface UsagePeriod {
  from?: string;
  to?: string;
  granularity?: string;
}

export interface Usage {
  tenant?: string;
  period?: UsagePeriod;
  metrics?: UsageMetrics;
  series?: Array<Record<string, unknown>>;
  quotas?: Record<string, unknown>;
  generatedAt?: string;
}

export interface Quota {
  limit?: number;
  used?: number;
  resetsAt?: string;
}

export interface Quotas {
  tenant?: string;
  quotas?: Record<string, Quota>;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  traceId?: string;
}
