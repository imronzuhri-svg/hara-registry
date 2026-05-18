import type { Hex } from "viem";

/**
 * Minimal Vault KV-v2 client with AppRole auth.
 *
 * Auth priority (production → dev fallback):
 *   1. If VAULT_APPROLE_ID + VAULT_APPROLE_SECRET are set, log in via
 *      auth/approle/login and use the returned client_token. Cached in
 *      memory; auto-refreshes before expiry.
 *   2. Else if VAULT_TOKEN is set, use it directly (local dev path —
 *      typically `haraledger-dev-root` against a dev-mode Vault).
 *   3. Else throw at first read.
 *
 * The AppRole path is what production deployments (deploy/topology.md §2)
 * use; each role (validator / signer / anchor-worker) has its own
 * VAULT_APPROLE_ID + VAULT_APPROLE_SECRET pair in its VPS .env. No root
 * tokens get distributed.
 */

const VAULT_ADDR = process.env.VAULT_ADDR ?? "http://vault:8200";
const VAULT_TOKEN_DIRECT = process.env.VAULT_TOKEN;
const VAULT_APPROLE_ID = process.env.VAULT_APPROLE_ID;
const VAULT_APPROLE_SECRET = process.env.VAULT_APPROLE_SECRET;

// Refresh the AppRole token this many seconds before its actual expiry,
// so a slow Vault read doesn't fall off the cliff.
const TOKEN_REFRESH_SLACK_SEC = 30;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let tokenCache: CachedToken | null = null;
let pendingLogin: Promise<CachedToken> | null = null;

export interface SignerKey {
  address: `0x${string}`;
  privateKey: Hex;
}

async function approleLogin(): Promise<CachedToken> {
  if (!VAULT_APPROLE_ID || !VAULT_APPROLE_SECRET) {
    throw new Error("approleLogin called but VAULT_APPROLE_ID/_SECRET not set");
  }
  const res = await fetch(`${VAULT_ADDR}/v1/auth/approle/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role_id: VAULT_APPROLE_ID,
      secret_id: VAULT_APPROLE_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Vault AppRole login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    auth?: { client_token?: string; lease_duration?: number };
  };
  const token = body.auth?.client_token;
  const leaseSec = body.auth?.lease_duration ?? 3600;
  if (!token) {
    throw new Error("Vault AppRole login: response missing client_token");
  }
  return {
    token,
    expiresAt: Date.now() + Math.max(60, leaseSec - TOKEN_REFRESH_SLACK_SEC) * 1000,
  };
}

async function currentToken(): Promise<string> {
  // Direct VAULT_TOKEN wins — dev mode, no AppRole login overhead.
  if (VAULT_TOKEN_DIRECT) return VAULT_TOKEN_DIRECT;

  if (!VAULT_APPROLE_ID || !VAULT_APPROLE_SECRET) {
    throw new Error(
      "Vault auth not configured. Set VAULT_APPROLE_ID + VAULT_APPROLE_SECRET (prod) " +
        "or VAULT_TOKEN (dev).",
    );
  }

  // Reuse cached token if still valid.
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  // Coalesce concurrent logins — a swarm of cold callers should not all hit
  // auth/approle/login simultaneously.
  if (!pendingLogin) {
    pendingLogin = approleLogin().finally(() => {
      pendingLogin = null;
    });
  }
  tokenCache = await pendingLogin;
  return tokenCache.token;
}

/**
 * Fetch a signer key from Vault.
 * The key never touches disk; callers should hold it in memory only.
 */
export async function fetchSignerKey(vaultPath: string): Promise<SignerKey> {
  // vaultPath looks like "secret/haraledger/signer-keys/deployer"
  // KV v2 read URL is "<addr>/v1/secret/data/haraledger/signer-keys/deployer"
  const apiPath = vaultPath.replace(/^secret\//, "secret/data/");
  const url = `${VAULT_ADDR}/v1/${apiPath}`;

  const token = await currentToken();
  const res = await fetch(url, {
    headers: { "X-Vault-Token": token },
  });

  // 403 with AppRole usually means the token expired between fetch and use
  // (clock skew, or the cache slack was too tight). Retry once with a fresh
  // login — but only if we're on the AppRole path, not direct VAULT_TOKEN.
  if (res.status === 403 && !VAULT_TOKEN_DIRECT) {
    tokenCache = null;
    const retryToken = await currentToken();
    const retryRes = await fetch(url, {
      headers: { "X-Vault-Token": retryToken },
    });
    if (!retryRes.ok) {
      throw new Error(
        `Vault fetch failed after token refresh: ${retryRes.status} ${await retryRes.text()}`,
      );
    }
    return parseSignerKey(await retryRes.json());
  }

  if (!res.ok) {
    throw new Error(`Vault fetch failed: ${res.status} ${await res.text()}`);
  }
  return parseSignerKey(await res.json());
}

function parseSignerKey(body: unknown): SignerKey {
  const parsed = body as { data?: { data?: { address?: string; private_key?: string } } };
  const inner = parsed.data?.data;
  if (!inner?.address || !inner?.private_key) {
    throw new Error("Vault response missing address or private_key");
  }
  return {
    address: inner.address.toLowerCase() as `0x${string}`,
    privateKey: inner.private_key.startsWith("0x")
      ? (inner.private_key as Hex)
      : (`0x${inner.private_key}` as Hex),
  };
}
