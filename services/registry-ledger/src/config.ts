/**
 * Environment loading + validation for the Registry Ledger.
 *
 * REAL: all values are read from the process environment (see .env.example).
 * Nothing here holds real key material — secrets arrive as env vars from Vault.
 *
 * Mirrors services/gapura-gateway/src/config.ts, including the deliberate refusal
 * to default PQ_ANCHOR_REGISTRY to the shared platform registry.
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

/** The platform anchor-worker's SHARED PQAnchorRegistry — the Ledger must NOT anchor
 *  here. The Registry Ledger runs its OWN Ledger-scoped instance (model c), keeping a
 *  separate anchor id-space from the platform / Gapura / Atlas. See §10 of
 *  doc/api/aurum-ledger-integration-guide.md. */
export const SHARED_PLATFORM_PQ_ANCHOR_REGISTRY =
  "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

/** True only for a real, Ledger-scoped registry (not unset/zero, not the shared platform one). */
export function isLedgerScopedRegistry(v: string): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/.test(v) &&
    v.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
    v.toLowerCase() !== SHARED_PLATFORM_PQ_ANCHOR_REGISTRY.toLowerCase()
  );
}

export const config = {
  port: Number(str("GATEWAY_PORT", "8940")),

  // Auth (Numira JWT, tenant-DID scoped). All three unset => dev-bypass (src/auth.ts).
  numira: {
    jwksUrl: optional("NUMIRA_JWKS_URL"),
    issuer: optional("NUMIRA_ISSUER"),
    // Guide §2: the Ledger validates the token audience `attest.ledger.haratrust.io`.
    audience: str("NUMIRA_AUDIENCE", "attest.ledger.haratrust.io"),
  },

  // Chain
  rpcWriteUrl: str("RPC_WRITE_URL", "https://rpc.ledger.haratrust.io/write/"),
  rpcReadUrl: str("RPC_READ_URL", "https://rpc.ledger.haratrust.io/read/"),
  chainId: Number(str("CHAIN_ID", "131216")),
  // Ledger-scoped instance (deploy model c) — NOT the shared platform registry.
  // Defaults to the zero address = unconfigured; anchor writes stay disabled until set.
  pqAnchorRegistry: str("PQ_ANCHOR_REGISTRY", ZERO_ADDRESS) as Hex,
  anchorGasLimit: BigInt(str("ANCHOR_GAS_LIMIT", "500000")),
  pqAlgorithm: str("PQ_ALGORITHM", "ML-DSA-65"),

  // Secrets (placeholders until Vault-wired).
  anchorEcdsaKey: optional("ANCHOR_ECDSA_KEY"),
  pqMldsaSeed: optional("PQ_MLDSA_SEED"),

  // Store: empty PG_URL => in-memory (default).
  pgUrl: optional("PG_URL"),
};

export type Config = typeof config;
