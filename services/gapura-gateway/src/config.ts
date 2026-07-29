/**
 * Environment loading + validation for the Gapura Gateway.
 *
 * REAL: all values are read from the process environment (see .env.example).
 * Nothing here holds real key material — secrets arrive as env vars from Vault.
 */

import type { Hex } from "viem";

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`env ${name} is required`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** A private key that is a real 0x-prefixed 32-byte hex value (not a placeholder). */
export function isRealPrivateKey(v: string | undefined): v is Hex {
  return !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** A seed that is a real 0x-prefixed 32-byte hex value (not a placeholder). */
export function isRealSeed(v: string | undefined): v is Hex {
  return !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
}

export const config = {
  port: Number(str("GATEWAY_PORT", "8930")),

  // Auth (Authentik). All three unset => dev-bypass auth (src/auth.ts).
  authentik: {
    jwksUrl: optional("AUTHENTIK_JWKS_URL"),
    issuer: optional("AUTHENTIK_ISSUER"),
    audience: optional("AUTHENTIK_AUDIENCE"),
  },

  // Chain
  rpcWriteUrl: str("RPC_WRITE_URL", "https://rpc.ledger.haratrust.io/write/"),
  rpcReadUrl: str("RPC_READ_URL", "https://rpc.ledger.haratrust.io/read/"),
  chainId: Number(str("CHAIN_ID", "131216")),
  pqAnchorRegistry: str(
    "PQ_ANCHOR_REGISTRY",
    "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  ) as Hex,
  anchorGasLimit: BigInt(str("ANCHOR_GAS_LIMIT", "500000")),
  pqAlgorithm: str("PQ_ALGORITHM", "ML-DSA-65"),

  // Secrets (placeholders until Vault-wired).
  anchorEcdsaKey: optional("ANCHOR_ECDSA_KEY"),
  pqMldsaSeed: optional("PQ_MLDSA_SEED"),

  // Store: empty PG_URL => in-memory.
  pgUrl: optional("PG_URL"),

  // Identity
  haradidResolverUrl: optional("HARADID_RESOLVER_URL"),
};

export type Config = typeof config;
