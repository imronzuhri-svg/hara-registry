/**
 * ML-DSA-65 (NIST FIPS 204) helpers + the canonical Signed-Tree-Head message.
 *
 * REAL. Copied from services/anchor-worker/src/pq.ts (keygen-from-seed, sign,
 * verify, publicKeyHash = keccak256(pubkey)) so a Ledger STH is verifiable by the
 * same off-chain procedure as a platform anchor. The one addition here is
 * `canonicalSTH()`: the byte layout the Ledger ML-DSA-65-signs when it publishes a
 * Signed Tree Head, so an auditor can recompute the signed message from the
 * public STH fields.
 *
 * Per FIPS 204: public 1952 B, secret 4032 B, signature 3309 B.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { keccak_256 } from "@noble/hashes/sha3";

export interface PqKeypair {
  publicKey: Uint8Array; // 1952 bytes
  secretKey: Uint8Array; // 4032 bytes
}

export const PQ_SIGNATURE_BYTES = 3309;
export const PQ_PUBLIC_KEY_BYTES = 1952;
export const PQ_SECRET_KEY_BYTES = 4032;

/** Deterministically derive the keypair from a 32-byte seed (Vault-backed). */
export function keygenFromSeed(seed: Uint8Array): PqKeypair {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const kp = ml_dsa65.keygen(seed);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** keccak256(public_key) — the on-chain `currentPQKeyHash` value. */
export function publicKeyHash(pub: Uint8Array): Uint8Array {
  if (pub.length !== PQ_PUBLIC_KEY_BYTES) {
    throw new Error(`public key must be ${PQ_PUBLIC_KEY_BYTES} bytes`);
  }
  return keccak_256(pub);
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

/**
 * The canonical Signed Tree Head message ML-DSA-65 signs. Deterministic byte
 * layout so auditors can recompute it from the public STH fields:
 *   2-byte BE algo length, algo utf-8,
 *   2-byte BE log_id length, log_id utf-8,
 *   8-byte BE tree_size,
 *   32-byte root_hash,
 *   8-byte BE timestamp (ms since epoch).
 */
export function canonicalSTH(args: {
  algorithm: string;
  logId: string;
  treeSize: bigint;
  rootHash: Uint8Array; // 32 bytes
  timestampMs: bigint;
}): Uint8Array {
  const algoBytes = Buffer.from(args.algorithm, "utf-8");
  const algoLen = Buffer.alloc(2);
  algoLen.writeUInt16BE(algoBytes.length, 0);

  const logBytes = Buffer.from(args.logId, "utf-8");
  const logLen = Buffer.alloc(2);
  logLen.writeUInt16BE(logBytes.length, 0);

  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v, 0);
    return b;
  };

  if (args.rootHash.length !== 32) throw new Error("rootHash must be 32 bytes");

  return Buffer.concat([
    algoLen,
    algoBytes,
    logLen,
    logBytes,
    u64(args.treeSize),
    Buffer.from(args.rootHash),
    u64(args.timestampMs),
  ]);
}

// ── hex helpers ──────────────────────────────────────────────────────────────

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
