/** Minimal fetch signature the SDK depends on (global fetch, Node 18+). */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Supplies the `Authorization` header for each Ledger write request.
 * Reads of proofs and status are public and need no auth.
 */
export interface AuthProvider {
  /** Returns HTTP headers to attach to a request (typically `Authorization`). */
  getAuthHeaders(): Promise<Record<string, string>>;
}

/**
 * A Numira JWT string, or an async getter that returns one. The getter form
 * lets callers refresh/rotate the token without reconstructing the client.
 */
export type TokenSource = string | (() => string | Promise<string>);

/**
 * Bearer-token `AuthProvider` for Numira-issued JWTs (pass-through).
 *
 * Numira issues the token elsewhere (carrying the tenant DID `did:hara:tenant:*`);
 * this provider simply attaches `Authorization: Bearer <numira-jwt>`. There is no
 * OAuth flow here. Accepts a static token or a `() => Promise<string>` getter.
 */
export class TokenAuth implements AuthProvider {
  private readonly source: TokenSource;

  constructor(token: TokenSource) {
    this.source = token;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = typeof this.source === 'function' ? await this.source() : this.source;
    if (!token) {
      throw new Error('TokenAuth: empty Numira token');
    }
    return { Authorization: `Bearer ${token}` };
  }
}
