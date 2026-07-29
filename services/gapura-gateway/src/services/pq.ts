/**
 * ML-DSA-65 (NIST FIPS 204) helpers + the canonical anchor message.
 *
 * REAL. This mirrors services/anchor-worker/src/pq.ts (keygen-from-seed, sign,
 * publicKeyHash = keccak256(pubkey)) and the canonicalMessage() byte layout the
 * anchor-worker signs, so a Gapura anchor is verifiable by the same off-chain
 * procedure as a platform anchor.
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
 * The canonical message ML-DSA-65 signs. Byte-identical to the anchor-worker's
 * canonicalMessage(): 2-byte BE algo length, algo utf-8, 32-byte merkleRoot,
 * three big-endian uint64s (blockFrom, blockTo, eventCount), then the 32-byte
 * anchorChain tag. Trivially recomputable by auditors.
 */
export function canonicalMessage(args: {
  algorithm: string;
  merkleRoot: Uint8Array;
  blockFrom: bigint;
  blockTo: bigint;
  eventCount: bigint;
  anchorChain: Uint8Array;
}): Uint8Array {
  const algoBytes = Buffer.from(args.algorithm, "utf-8");
  const algoLen = Buffer.alloc(2);
  algoLen.writeUInt16BE(algoBytes.length, 0);

  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v, 0);
    return b;
  };

  return Buffer.concat([
    algoLen,
    algoBytes,
    Buffer.from(args.merkleRoot),
    u64(args.blockFrom),
    u64(args.blockTo),
    u64(args.eventCount),
    Buffer.from(args.anchorChain),
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
