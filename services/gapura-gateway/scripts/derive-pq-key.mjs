#!/usr/bin/env node
// derive-pq-key.mjs — derive INITIAL_PQ_KEY_HASH for the Gapura-scoped PQAnchorRegistry.
//
// Generates (or accepts) a 32-byte ML-DSA-65 seed, derives the public key, and prints
// keccak256(pubkey) — the value the instance stores as `currentPQKeyHash`. Mirrors
// services/anchor-worker/src/pq.ts (same primitive + same publicKeyHash convention).
//
// Usage (run from services/gapura-gateway after `npm install`):
//   node scripts/derive-pq-key.mjs                          # generate a fresh seed + hash
//   PQ_MLDSA_SEED=0x<64hex> node scripts/derive-pq-key.mjs  # derive from an existing seed
//
// Piping: the hash goes to STDOUT, everything else (incl. a generated seed) to STDERR:
//   INITIAL_PQ_KEY_HASH=$(node scripts/derive-pq-key.mjs 2>/dev/null | cut -d= -f2)
//
// SECURITY: the SEED is Gapura's PQ private-key material. Store it in Vault as
// PQ_MLDSA_SEED; NEVER commit it or paste it into chat. Only the derived hash (stdout)
// goes on-chain / into the deploy env. Also publish the ML-DSA-65 *public* key bytes to
// CAS/MinIO keyed by the printed hash so auditors can verify anchors off-chain.
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { keccak_256 } from "@noble/hashes/sha3";
import { webcrypto } from "node:crypto";

const toHex = (b) => "0x" + Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

let seed;
if (process.env.PQ_MLDSA_SEED) {
  seed = fromHex(process.env.PQ_MLDSA_SEED);
  if (seed.length !== 32) {
    console.error("ERROR: PQ_MLDSA_SEED must be exactly 32 bytes (64 hex chars).");
    process.exit(1);
  }
} else {
  seed = new Uint8Array(32);
  webcrypto.getRandomValues(seed);
  console.error("# Generated a fresh seed. STORE this in Vault as PQ_MLDSA_SEED, do NOT commit:");
  console.error("PQ_MLDSA_SEED=" + toHex(seed));
  console.error("");
}

const { publicKey } = ml_dsa65.keygen(seed);
if (publicKey.length !== 1952) {
  console.error(`ERROR: expected a 1952-byte ML-DSA-65 public key, got ${publicKey.length}.`);
  process.exit(1);
}
console.error(`# ML-DSA-65 public key: ${publicKey.length} bytes — publish to CAS/MinIO at the hash below.`);
console.log("INITIAL_PQ_KEY_HASH=" + toHex(keccak_256(publicKey)));
