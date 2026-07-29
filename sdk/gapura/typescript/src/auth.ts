import type { Scope } from './types.js';

/** Minimal fetch signature the SDK depends on (global fetch, Node 18+). */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Supplies the `Authorization` header for each Gateway request.
 * Implementations own token acquisition, caching, and refresh.
 */
export interface AuthProvider {
  /**
   * Returns HTTP headers to attach to a request (typically `Authorization`).
   * @param scopes Optional scopes the request needs; providers may use these
   *   to select or narrow a token.
   */
  getAuthHeaders(scopes?: Scope[]): Promise<Record<string, string>>;
}

/** Shape of Authentik's client-credentials token response. */
interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Options for {@link ClientCredentialsAuth}. */
export interface ClientCredentialsAuthOptions {
  /** Authentik token endpoint, e.g. `https://auth.haratrust.io/application/o/token/`. */
  tokenUrl: string;
  /** Authentik client id, e.g. `gapura-backend`. */
  clientId: string;
  /** Authentik client secret. */
  clientSecret: string;
  /** Scopes to request; joined space-separated into the token request. */
  scopes?: Scope[];
  /** Custom fetch (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /**
   * Seconds before expiry at which the cached token is considered stale and
   * refreshed proactively. Defaults to 30.
   */
  refreshSkewSeconds?: number;
}

/**
 * OAuth2 client-credentials `AuthProvider` for Authentik (ADR-0018).
 *
 * Exchanges a client id/secret for a short-lived JWT, caches it, and refreshes
 * ~30s before expiry. Returns a `Bearer` `Authorization` header.
 */
export class ClientCredentialsAuth implements AuthProvider {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: Scope[];
  private readonly fetchImpl: FetchLike;
  private readonly refreshSkewMs: number;

  private cachedToken: string | undefined;
  private expiresAtMs = 0;
  private inflight: Promise<string> | undefined;

  constructor(options: ClientCredentialsAuthOptions) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes ?? [];
    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new Error(
        'No fetch implementation available. Use Node 18+ or pass a `fetch` option.',
      );
    }
    this.fetchImpl = resolvedFetch;
    this.refreshSkewMs = (options.refreshSkewSeconds ?? 30) * 1000;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  /** Returns a valid access token, refreshing if the cache is stale/empty. */
  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.expiresAtMs - this.refreshSkewMs) {
      return this.cachedToken;
    }
    // Coalesce concurrent refreshes into a single request.
    if (!this.inflight) {
      this.inflight = this.requestToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (this.scopes.length > 0) {
      body.set('scope', this.scopes.join(' '));
    }

    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Authentik token request failed: ${res.status} ${res.statusText}${
          text ? ` — ${text}` : ''
        }`,
      );
    }

    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error('Authentik token response missing access_token');
    }

    this.cachedToken = json.access_token;
    const expiresInMs = (json.expires_in ?? 300) * 1000;
    this.expiresAtMs = Date.now() + expiresInMs;
    return this.cachedToken;
  }
}
