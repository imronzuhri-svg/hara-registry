import type { AuthProvider, FetchLike } from './auth.js';
import { ProblemError } from './errors.js';
import type {
  Anchor,
  AnchorRequest,
  AnchorStatus,
  Binding,
  DidResolution,
  HashAlg,
  IdentityRegistration,
  IdentityRequest,
  Operation,
  Problem,
  Quotas,
  Scope,
  Usage,
  VerifyResult,
} from './types.js';

/** Options to construct a {@link GapuraClient}. */
export interface GapuraClientOptions {
  /** Gateway base URL including version, e.g. `https://gapura.ledger.haratrust.io/v1`. */
  baseUrl: string;
  /** Auth provider (e.g. `ClientCredentialsAuth`) supplying the `Bearer` header. */
  auth: AuthProvider;
  /** Custom fetch (defaults to the global `fetch`; Node 18+). */
  fetch?: FetchLike;
  /** Scopes to pass to the auth provider on every request unless overridden. */
  defaultScopes?: Scope[];
  /** Max retry attempts for `429`/`503` responses. Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in ms for exponential retry. Defaults to 250. */
  retryBaseMs?: number;
}

/** Per-request options. */
export interface RequestOptions {
  /** Scopes required for this request (overrides `defaultScopes`). */
  scopes?: Scope[];
  /** `Idempotency-Key` header value (used by `anchors.create`). */
  idempotencyKey?: string;
}

interface InternalRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  scopes?: Scope[];
  idempotencyKey?: string;
  /** Treat a `304 Not Modified` as `undefined` rather than an error. */
  allowNotModified?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Options for `anchors.verify`. */
export interface VerifyParams {
  digest: string;
  hashAlg?: HashAlg;
}

/** Options for `identity.createBinding`. */
export interface CreateBindingBody {
  authentikSub: string;
  tenant: string;
}

/** Query for `metering.usage`. */
export interface UsageQuery {
  tenant: string;
  from: string;
  to: string;
  granularity?: 'total' | 'day' | 'month';
  metric?: string;
}

/**
 * Typed client for the HARA Gapura Gateway.
 *
 * Targets the Gateway (a HARA-operated facade), not the chain — the Gateway
 * holds the anchor + PQ keys. Callers send hashes and DIDs only.
 */
export class GapuraClient {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly fetchImpl: FetchLike;
  private readonly defaultScopes: Scope[] | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  /** Anchoring operations (scope `anchor:read` / `anchor:write`). */
  readonly anchors: AnchorsResource;
  /** Identity / DID operations (scope `identity:read` / `identity:write`). */
  readonly identity: IdentityResource;
  /** Usage metering (scope `metering:read`). */
  readonly metering: MeteringResource;

  constructor(options: GapuraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new Error(
        'No fetch implementation available. Use Node 18+ or pass a `fetch` option.',
      );
    }
    this.fetchImpl = resolvedFetch;
    this.defaultScopes = options.defaultScopes;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;

    this.anchors = new AnchorsResource(this);
    this.identity = new IdentityResource(this);
    this.metering = new MeteringResource(this);
  }

  /** @internal Performs an authenticated, retrying request and parses JSON/problem+json. */
  async request<T>(req: InternalRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const scopes = req.scopes ?? this.defaultScopes;

    let attempt = 0;
    // Loop bounded by maxRetries; only 429/503 are retried.
    for (;;) {
      const authHeaders = await this.auth.getAuthHeaders(scopes);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...authHeaders,
      };
      const init: RequestInit = { method: req.method, headers };
      if (req.idempotencyKey) {
        headers['Idempotency-Key'] = req.idempotencyKey;
      }
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body);
      }

      const res = await this.fetchImpl(url, init);

      if (
        (res.status === 429 || res.status === 503) &&
        attempt < this.maxRetries
      ) {
        const delay = this.retryDelayMs(res, attempt);
        attempt += 1;
        await sleep(delay);
        continue;
      }

      if (res.status === 304 && req.allowNotModified) {
        return undefined as T;
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

/** Anchoring sub-resource. */
export class AnchorsResource {
  constructor(private readonly client: GapuraClient) {}

  /**
   * Anchor a digest (`POST /anchors`, scope `anchor:write`).
   * If no `idempotencyKey` is supplied, one is generated via `crypto.randomUUID()`.
   * Returns the existing anchor (`200`) if this digest was already anchored.
   */
  async create(body: AnchorRequest, options?: { idempotencyKey?: string }): Promise<Anchor> {
    const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
    return this.client.request<Anchor>({
      method: 'POST',
      path: '/anchors',
      body,
      idempotencyKey,
      scopes: ['anchor:write'],
    });
  }

  /** Fetch an anchor record (`GET /anchors/{anchorId}`, scope `anchor:read`). */
  async get(anchorId: string): Promise<Anchor> {
    return this.client.request<Anchor>({
      method: 'GET',
      path: `/anchors/${encodeURIComponent(anchorId)}`,
      scopes: ['anchor:read'],
    });
  }

  /** Verify a digest (`POST /verify`, scope `anchor:read`). */
  async verify(params: VerifyParams): Promise<VerifyResult> {
    return this.client.request<VerifyResult>({
      method: 'POST',
      path: '/verify',
      body: { digest: params.digest, hashAlg: params.hashAlg },
      scopes: ['anchor:read'],
    });
  }

  /** Anchor tx lifecycle (`GET /anchors/{anchorId}/status`, scope `anchor:read`). */
  async status(anchorId: string): Promise<AnchorStatus> {
    return this.client.request<AnchorStatus>({
      method: 'GET',
      path: `/anchors/${encodeURIComponent(anchorId)}/status`,
      scopes: ['anchor:read'],
    });
  }
}

/** Identity / DID sub-resource. */
export class IdentityResource {
  constructor(private readonly client: GapuraClient) {}

  /** Resolve a `did:hara` DID (`GET /did/{did}`, scope `identity:read`). */
  async resolve(did: string): Promise<DidResolution> {
    return this.client.request<DidResolution>({
      method: 'GET',
      path: `/did/${encodeURIComponent(did)}`,
      scopes: ['identity:read'],
    });
  }

  /** Issue/register a tenant or authority DID (`POST /identities`, scope `identity:write`). */
  async register(body: IdentityRequest): Promise<IdentityRegistration | Operation> {
    return this.client.request<IdentityRegistration | Operation>({
      method: 'POST',
      path: '/identities',
      body,
      scopes: ['identity:write'],
    });
  }

  /** Poll an async (Sidetree) registration (`GET /identities/operations/{id}`, scope `identity:read`). */
  async operation(operationId: string): Promise<Operation> {
    return this.client.request<Operation>({
      method: 'GET',
      path: `/identities/operations/${encodeURIComponent(operationId)}`,
      scopes: ['identity:read'],
    });
  }

  /** Look up the DID bound to an Authentik subject (`GET /identities/by-subject/{sub}`, scope `identity:read`). */
  async bindingBySubject(authentikSub: string): Promise<Binding> {
    return this.client.request<Binding>({
      method: 'GET',
      path: `/identities/by-subject/${encodeURIComponent(authentikSub)}`,
      scopes: ['identity:read'],
    });
  }

  /** Bind a DID to an Authentik subject (`POST /identities/{did}/bindings`, scope `identity:write`). */
  async createBinding(did: string, body: CreateBindingBody): Promise<Binding> {
    return this.client.request<Binding>({
      method: 'POST',
      path: `/identities/${encodeURIComponent(did)}/bindings`,
      body,
      scopes: ['identity:write'],
    });
  }
}

/** Usage metering sub-resource. */
export class MeteringResource {
  constructor(private readonly client: GapuraClient) {}

  /** Query geometry-blind usage counters (`GET /metering/usage`, scope `metering:read`). */
  async usage(query: UsageQuery): Promise<Usage> {
    return this.client.request<Usage>({
      method: 'GET',
      path: '/metering/usage',
      query: {
        tenant: query.tenant,
        from: query.from,
        to: query.to,
        granularity: query.granularity,
        metric: query.metric,
      },
      scopes: ['metering:read'],
    });
  }

  /** Current limits + consumption (`GET /metering/quotas`, scope `metering:read`). */
  async quotas(tenant: string): Promise<Quotas> {
    return this.client.request<Quotas>({
      method: 'GET',
      path: '/metering/quotas',
      query: { tenant },
      scopes: ['metering:read'],
    });
  }
}
