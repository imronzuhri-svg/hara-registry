import type { AuthProvider, FetchLike, TokenSource } from './auth.js';
import { TokenAuth } from './auth.js';
import { ProblemError } from './errors.js';
import type {
  Attestation,
  AttestationRequest,
  Checkpoint,
  CheckpointRequest,
  ConsistencyResponse,
  Evidence,
  EvidenceRequest,
  InclusionResponse,
  Problem,
  RetentionUpdate,
  RevokeRequest,
  StatusAction,
  StatusRecord,
  VerifyBundle,
} from './types.js';

/** Options to construct a {@link RegistryLedger} client. */
export interface RegistryLedgerOptions {
  /** Ledger base URL including version, e.g. `https://attest.ledger.haratrust.io/v1`. */
  baseUrl: string;
  /**
   * Numira JWT used for writes. Either a static token string, a
   * `() => Promise<string>` getter, or a pre-built {@link AuthProvider}.
   * Reads (proofs/status) are public and need no token.
   */
  token?: TokenSource | AuthProvider;
  /** Custom fetch (defaults to the global `fetch`; Node 18+). */
  fetch?: FetchLike;
  /** Max retry attempts for `429`/`503` responses. Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in ms for exponential retry. Defaults to 250. */
  retryBaseMs?: number;
}

interface InternalRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Attach the bearer token (writes). Reads leave this false. */
  auth?: boolean;
  idempotencyKey?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isAuthProvider(value: unknown): value is AuthProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AuthProvider).getAuthHeaders === 'function'
  );
}

/**
 * Typed client for the HARA Registry Ledger.
 *
 * Writes are tenant-scoped from a Numira bearer token; proof/status reads are
 * public. Only hashes and DIDs cross the seam — never tenant payloads.
 *
 * For offline verification of what this client returns, use the standalone
 * `verifyInclusion` / `verifyConsistency` functions (no network, no client).
 */
export class RegistryLedger {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: RegistryLedgerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.token === undefined) {
      this.auth = undefined;
    } else if (isAuthProvider(options.token)) {
      this.auth = options.token;
    } else {
      this.auth = new TokenAuth(options.token);
    }
    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new Error(
        'No fetch implementation available. Use Node 18+ or pass a `fetch` option.',
      );
    }
    this.fetchImpl = resolvedFetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;
  }

  /* ---------------------------------------------------------------------- */
  /* attestations                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Anchor a signed VC/record hash (`POST /attestations`, tenant-scoped).
   * If no `idempotencyKey` is supplied, one is generated via `crypto.randomUUID()`.
   * Returns the existing record (`200`) if this `contentHash` was already anchored.
   */
  async anchor(
    req: AttestationRequest,
    options?: { idempotencyKey?: string },
  ): Promise<Attestation> {
    const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
    return this.request<Attestation>({
      method: 'POST',
      path: '/attestations',
      body: req,
      auth: true,
      idempotencyKey,
    });
  }

  /** Resolve anchored record metadata (`GET /attestations/{id}`, public). */
  async getAttestation(registryId: string): Promise<Attestation> {
    return this.request<Attestation>({
      method: 'GET',
      path: `/attestations/${encodeURIComponent(registryId)}`,
    });
  }

  /**
   * Inclusion proof for the attestation leaf
   * (`GET /attestations/{id}/proof`, public, offline-verifiable).
   * Omit `treeSize` to prove against the latest STH.
   */
  async getProof(registryId: string, treeSize?: number): Promise<InclusionResponse> {
    return this.request<InclusionResponse>({
      method: 'GET',
      path: `/attestations/${encodeURIComponent(registryId)}/proof`,
      query: { tree_size: treeSize },
    });
  }

  /** Status of record (`GET /attestations/{id}/status`, public). */
  async getStatus(registryId: string): Promise<StatusRecord> {
    return this.request<StatusRecord>({
      method: 'GET',
      path: `/attestations/${encodeURIComponent(registryId)}/status`,
    });
  }

  /**
   * Revoke or supersede an attestation
   * (`POST /attestations/{id}/revoke`, tenant-scoped, attributed, anchored).
   */
  async setStatus(
    registryId: string,
    action: StatusAction,
    opts: { reason: string; supersededBy?: string },
  ): Promise<StatusRecord> {
    const body: RevokeRequest = {
      action,
      reason: opts.reason,
      ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}),
    };
    return this.request<StatusRecord>({
      method: 'POST',
      path: `/attestations/${encodeURIComponent(registryId)}/revoke`,
      body,
      auth: true,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* checkpoints                                                            */
  /* ---------------------------------------------------------------------- */

  /** Submit an event-chain checkpoint (`POST /anchors`, tenant-scoped). */
  async submitCheckpoint(req: CheckpointRequest): Promise<Checkpoint> {
    return this.request<Checkpoint>({
      method: 'POST',
      path: '/anchors',
      body: req,
      auth: true,
    });
  }

  /**
   * Consistency proof that tree `to` extends tree `from`
   * (`GET /anchors/consistency`, public, offline-verifiable).
   */
  async getConsistency(logId: string, from: number, to: number): Promise<ConsistencyResponse> {
    return this.request<ConsistencyResponse>({
      method: 'GET',
      path: '/anchors/consistency',
      query: { log_id: logId, from, to },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* evidence                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a content hash under retention / legal hold
   * (`POST /evidence`, tenant-scoped). Idempotent on `contentHash` (`200`).
   */
  async registerEvidence(req: EvidenceRequest): Promise<Evidence> {
    return this.request<Evidence>({
      method: 'POST',
      path: '/evidence',
      body: req,
      auth: true,
    });
  }

  /** Retention state (`GET /evidence/{id}`, public). */
  async getEvidence(evidenceId: string): Promise<Evidence> {
    return this.request<Evidence>({
      method: 'GET',
      path: `/evidence/${encodeURIComponent(evidenceId)}`,
    });
  }

  /**
   * Set/lift legal hold or extend retention — never shorten
   * (`PATCH /evidence/{id}`, tenant-scoped).
   */
  async updateRetention(evidenceId: string, update: RetentionUpdate): Promise<Evidence> {
    return this.request<Evidence>({
      method: 'PATCH',
      path: `/evidence/${encodeURIComponent(evidenceId)}`,
      body: update,
      auth: true,
    });
  }

  /**
   * Attempt hard-delete (`DELETE /evidence/{id}`, tenant-scoped).
   * Refused with `409 retention_locked` (thrown as {@link ProblemError}) while
   * under retention/hold; the refused attempt is itself anchored.
   */
  async deleteEvidence(evidenceId: string): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      path: `/evidence/${encodeURIComponent(evidenceId)}`,
      auth: true,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* verify                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Backing-attestation verification bundle for a passport
   * (`GET /verify?subject=`, public, offline-verifiable).
   */
  async verifyBundle(subjectDid: string): Promise<VerifyBundle> {
    return this.request<VerifyBundle>({
      method: 'GET',
      path: '/verify',
      query: { subject: subjectDid },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* transport                                                              */
  /* ---------------------------------------------------------------------- */

  /** @internal Performs a (optionally authed) retrying request; parses JSON/problem+json. */
  private async request<T>(req: InternalRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);

    let attempt = 0;
    // Loop bounded by maxRetries; only 429/503 are retried.
    for (;;) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (req.auth) {
        if (!this.auth) {
          throw new Error(
            `${req.method} ${req.path} requires a Numira token — construct RegistryLedger with { token }.`,
          );
        }
        Object.assign(headers, await this.auth.getAuthHeaders());
      }
      if (req.idempotencyKey) {
        headers['Idempotency-Key'] = req.idempotencyKey;
      }
      const init: RequestInit = { method: req.method, headers };
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body);
      }

      const res = await this.fetchImpl(url, init);

      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        const delay = this.retryDelayMs(res, attempt);
        attempt += 1;
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        throw await this.toProblemError(res);
      }

      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }
  }

  private retryDelayMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
    return this.retryBaseMs * 2 ** attempt;
  }

  private async toProblemError(res: Response): Promise<ProblemError> {
    const contentType = res.headers.get('Content-Type') ?? '';
    let problem: Problem = { status: res.status };
    if (contentType.includes('application/problem+json') || contentType.includes('json')) {
      try {
        const parsed = (await res.json()) as Problem;
        problem = { status: res.status, ...parsed };
      } catch {
        // fall through to status-only problem
      }
    } else {
      const detail = await res.text().catch(() => '');
      problem = { status: res.status, title: res.statusText, detail: detail || undefined };
    }
    return new ProblemError(problem);
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}
