import { fetchSignerKey } from "@hara/shared";
import { generateKeypair, fromHex, toHex, publicKeyHash, type PqKeypair } from "./pq.js";

/**
 * Anchor-worker key bundle.
 *
 * One Vault secret at `secret/haraledger/signer-keys/anchor-worker` holds:
 *   address           — ECDSA Ethereum address (lowercase 0x)
 *   private_key       — ECDSA 32-byte secret (0x-prefixed hex)
 *   pq_public_key     — ML-DSA-65 public key (1952 bytes, 0x-prefixed hex)
 *   pq_secret_key     — ML-DSA-65 secret key (4032 bytes, 0x-prefixed hex)
 *
 * The vault.ts shared client only reads address + private_key today; we read
 * the extra two fields directly here. Keeping all four in one secret is a
 * deliberate choice — one Vault path, one AppRole policy, one rotation
 * operation.
 *
 * If the secret is missing entirely OR the PQ fields are absent (legacy
 * key created before ADR-0010 lands), the caller can generate a fresh PQ
 * keypair and seed Vault via writePQFields(). That's a one-shot operator
 * action; the worker itself never writes Vault during normal operation.
 */

const VAULT_PATH = process.env.ANCHOR_VAULT_PATH ??
  "secret/haraledger/signer-keys/anchor-worker";

export interface AnchorKeys {
  ecdsaAddress: `0x${string}`;
  ecdsaPrivateKey: `0x${string}`;
  pq: PqKeypair;
  pqKeyHashHex: `0x${string}`;
}

interface VaultPqRead {
  address: string;
  private_key: string;
  pq_public_key?: string;
  pq_secret_key?: string;
}

/** Raw Vault read with the extra PQ fields. fetchSignerKey only handles
 *  the ECDSA pair so we can't reuse it as-is — duplicate the minimal HTTP
 *  call here. */
async function readAnchorSecret(): Promise<VaultPqRead | null> {
  const addr = process.env.VAULT_ADDR ?? "http://vault:8200";
  const token = await getVaultToken();
  const apiPath = VAULT_PATH.replace(/^secret\//, "secret/data/");
  const res = await fetch(`${addr}/v1/${apiPath}`, {
    headers: { "X-Vault-Token": token },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Vault read failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { data?: VaultPqRead } };
  return body.data?.data ?? null;
}

/** Same auth priority as @hara/shared/vault.ts (AppRole preferred, direct
 *  VAULT_TOKEN fallback for dev). Tiny inlined copy to avoid leaking the
 *  token cache across modules. */
async function getVaultToken(): Promise<string> {
  const direct = process.env.VAULT_TOKEN;
  if (direct) return direct;
  const roleId = process.env.VAULT_APPROLE_ID;
  const secretId = process.env.VAULT_APPROLE_SECRET;
  if (!roleId || !secretId) {
    throw new Error(
      "Need VAULT_APPROLE_ID + VAULT_APPROLE_SECRET (prod) or VAULT_TOKEN (dev)",
    );
  }
  const addr = process.env.VAULT_ADDR ?? "http://vault:8200";
  const res = await fetch(`${addr}/v1/auth/approle/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  });
  if (!res.ok) {
    throw new Error(`AppRole login failed: ${res.status}`);
  }
  const body = (await res.json()) as { auth?: { client_token?: string } };
  const tok = body.auth?.client_token;
  if (!tok) throw new Error("AppRole login: no client_token");
  return tok;
}

/** Write PQ fields back to the existing Vault secret. Idempotent — overwrites
 *  the version, KV-v2 keeps the prior one in history if you ever need to
 *  audit a rotation. Called from main() only on cold-start when PQ fields
 *  are absent. */
export async function writePQFields(pq: PqKeypair): Promise<void> {
  const addr = process.env.VAULT_ADDR ?? "http://vault:8200";
  const token = await getVaultToken();
  const apiPath = VAULT_PATH.replace(/^secret\//, "secret/data/");

  // Read existing first so we don't drop ECDSA fields.
  const existing = await readAnchorSecret();
  if (!existing) {
    throw new Error(
      `Vault secret missing at ${VAULT_PATH}; create it first with ` +
        `vault-store-signer-key.sh (then anchor-worker can add PQ fields).`,
    );
  }

  const payload = {
    data: {
      address: existing.address,
      private_key: existing.private_key,
      pq_public_key: toHex(pq.publicKey),
      pq_secret_key: toHex(pq.secretKey),
    },
  };

  const res = await fetch(`${addr}/v1/${apiPath}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Vault write failed: ${res.status} ${await res.text()}`);
  }
}

export async function loadOrInitKeys(): Promise<AnchorKeys> {
  // Reuse shared fetchSignerKey for the ECDSA half (gives us address + privkey
  // with full validation + 403 retry).
  const ecdsa = await fetchSignerKey(VAULT_PATH);

  let secret = await readAnchorSecret();
  if (!secret) {
    throw new Error(`Vault secret missing at ${VAULT_PATH}`);
  }

  let pq: PqKeypair;
  if (secret.pq_public_key && secret.pq_secret_key) {
    pq = {
      publicKey: fromHex(secret.pq_public_key),
      secretKey: fromHex(secret.pq_secret_key),
    };
  } else {
    // Cold-start path: generate a fresh PQ keypair and seed Vault.
    console.warn(
      `[anchor-worker] PQ keypair absent at ${VAULT_PATH} — generating and writing`,
    );
    pq = generateKeypair();
    await writePQFields(pq);
  }

  return {
    ecdsaAddress: ecdsa.address,
    ecdsaPrivateKey: ecdsa.privateKey,
    pq,
    pqKeyHashHex: toHex(publicKeyHash(pq.publicKey)) as `0x${string}`,
  };
}
