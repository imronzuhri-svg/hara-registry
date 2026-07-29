/**
 * `@hara/gapura-sdk` — TypeScript client for the HARA Gapura Gateway.
 *
 * Targets the Gateway (a HARA-operated facade over PQAnchorRegistry), not the
 * chain. Callers send hashes and DIDs only — never geometry, never PII.
 */

export { GapuraClient } from './client.js';
export type {
  GapuraClientOptions,
  RequestOptions,
  VerifyParams,
  CreateBindingBody,
  UsageQuery,
  AnchorsResource,
  IdentityResource,
  MeteringResource,
} from './client.js';

export { ClientCredentialsAuth } from './auth.js';
export type {
  AuthProvider,
  FetchLike,
  ClientCredentialsAuthOptions,
} from './auth.js';

export { ProblemError, isProblem } from './errors.js';

export type {
  HashAlg,
  AnchorStatusEnum,
  Scope,
  Digest,
  Did,
  Signatures,
  TxRef,
  AnchorRequest,
  Anchor,
  AnchoredBy,
  AnchorVerification,
  VerifyResultAnchor,
  VerifyResult,
  AnchorCost,
  AnchorStatus,
  DidDocumentMetadata,
  DidResolution,
  IdentityRequest,
  Registration,
  IdentityRegistration,
  Operation,
  Binding,
  UsageMetrics,
  UsagePeriod,
  Usage,
  Quota,
  Quotas,
  Problem,
} from './types.js';
