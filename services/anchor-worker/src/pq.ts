import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { keccak_256 } from "@noble/hashes/sha3";

/**
 * ML-DSA-65 keypair wrapper.
 *
 * Per FIPS 204:
 *   public key  = 1952 bytes
 *   secret key  = 4032 bytes
 *   signature   = 3309 bytes
 *
 * @noble/post-quantum handles the full primitive. We add only:
 *   • keypair generation from a 32-byte seed (so we can derive from a Vault
 *     entry rather than fresh entropy on every restart)
 *   • a stable identifier — keccak256(public_key) — used as the on-chain
 *     `currentPQKeyHash` value committed by PQAnchorRegistry.
 */

export interface PqKeypair {
  publicKey: Uint8Array; // 1952 bytes
  secretKey: Uint8Array; // 4032 bytes
}

export const PQ_SIGNATURE_BYTES = 3309;
export const PQ_PUBLIC_KEY_BYTES = 1952;
export const PQ_SECRET_KEY_BYTES = 4032;

export function generateKeypair(seed?: Uint8Array): PqKeypair {
  const s = seed ?? cryptoRandom(32);
  if (s.length !== 32) throw new Error("seed must be 32 bytes");
  const kp = ml_dsa65.keygen(s);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function publicKeyHash(pk: Uint8Array): Uint8Array {
  if (pk.length !== PQ_PUBLIC_KEY_BYTES) {
    throw new Error(`public key must be ${PQ_PUBLIC_KEY_BYTES} bytes`);
  }
  return keccak_256(pk);
}

export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretKey.length !== PQ_SECRET_KEY_BYTES) {
    throw new Error(`secret key must be ${PQ_SECRET_KEY_BYTES} bytes`);
  }
  const sig = ml_dsa65.sign(secretKey, message);
  if (sig.length !== PQ_SIGNATURE_BYTES) {
    throw new Error(`expected ${PQ_SIGNATURE_BYTES}-byte signature, got ${sig.length}`);
  }
  return sig;
}

export function verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  return ml_dsa65.verify(publicKey, message, signature);
}

// ── seed helpers ─────────────────────────────────────────────────────────────

function cryptoRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Node 22 globals.crypto is WebCrypto-compatible.
  crypto.getRandomValues(out);
  return out;
}

/** Hex → bytes (no 0x prefix tolerance — caller normalises). */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}
