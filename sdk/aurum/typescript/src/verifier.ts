/**
 * Standalone, dependency-free RFC 6962 / RFC 9162 Merkle proof verifier.
 *
 * Usable by auditors OFFLINE: `verifyInclusion` and `verifyConsistency` do no
 * network I/O and depend only on `node:crypto` for SHA-256. `verifySthAnchored`
 * is the one read-only network call — it confirms an STH root is the value
 * anchored on-chain in the Ledger-scoped `PQAnchorRegistry`.
 *
 * RFC 6962 §2.1 hashing rules:
 *   • leaf hash  = SHA256( 0x00 || leaf_data )
 *   • node hash  = SHA256( 0x01 || left || right )
 */

import { createHash } from 'node:crypto';
import type { InclusionProof, STH } from './types.js';

/** A hash accepted anywhere in the verifier: `0x`-hex string or raw bytes. */
export type HashInput = Uint8Array | string;

/* -------------------------------------------------------------------------- */
/* hex <-> bytes helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Convert a `0x`-prefixed (or bare) hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Convert bytes to a lowercase `0x`-prefixed hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

/** Normalize a {@link HashInput} to bytes. */
export function toBytes(input: HashInput): Uint8Array {
  return typeof input === 'string' ? hexToBytes(input) : input;
}

/** Constant-time-ish equality for two byte arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* RFC 6962 hashing primitives                                                */
/* -------------------------------------------------------------------------- */

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** RFC 6962 leaf hash: `SHA256(0x00 || leaf_data)`. */
export function leafHash(leafData: HashInput): Uint8Array {
  const data = toBytes(leafData);
  const buf = new Uint8Array(1 + data.length);
  buf[0] = 0x00;
  buf.set(data, 1);
  return sha256(buf);
}

/** RFC 6962 interior node hash: `SHA256(0x01 || left || right)`. */
export function nodeHash(left: HashInput, right: HashInput): Uint8Array {
  const l = toBytes(left);
  const r = toBytes(right);
  const buf = new Uint8Array(1 + l.length + r.length);
  buf[0] = 0x01;
  buf.set(l, 1);
  buf.set(r, 1 + l.length);
  return sha256(buf);
}

/* -------------------------------------------------------------------------- */
/* Inclusion proof — RFC 9162 §2.1.3.2                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verify an RFC 6962 inclusion proof by reconstructing the tree root from
 * `leafHashInput`, `proof.leaf_index`, `proof.tree_size`, and `proof.audit_path`,
 * then comparing it to `root`.
 *
 * @param leafHashInput The leaf's hash (`SHA256(0x00 || data)`), hex or bytes.
 *                      This is the already-hashed leaf, e.g. `attestation.log.leaf_hash`.
 * @param proof         The inclusion proof (`leaf_index`, `tree_size`, `audit_path`).
 * @param root          The STH root hash to prove against, hex or bytes.
 * @returns true iff the reconstructed root matches `root`.
 */
export function verifyInclusion(
  leafHashInput: HashInput,
  proof: InclusionProof,
  root: HashInput,
): boolean {
  const treeSize = proof.tree_size;
  const leafIndex = proof.leaf_index;
  if (
    !Number.isInteger(treeSize) ||
    !Number.isInteger(leafIndex) ||
    treeSize <= 0 ||
    leafIndex < 0 ||
    leafIndex >= treeSize
  ) {
    return false;
  }

  const path = proof.audit_path;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r: Uint8Array;
  try {
    r = toBytes(leafHashInput);
    for (const p of path) {
      const pb = toBytes(p);
      if (sn === 0) {
        // Audit path longer than the tree allows.
        return false;
      }
      if ((fn & 1) === 1 || fn === sn) {
        r = nodeHash(pb, r);
        if ((fn & 1) === 0) {
          // Right-shift until LSB(fn) is set or fn is 0.
          do {
            fn >>>= 1;
            sn >>>= 1;
          } while ((fn & 1) === 0 && fn !== 0);
        }
      } else {
        r = nodeHash(r, pb);
      }
      fn >>>= 1;
      sn >>>= 1;
    }
    return sn === 0 && bytesEqual(r, toBytes(root));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Consistency proof — RFC 9162 §2.1.4.2                                      */
/* -------------------------------------------------------------------------- */

/** Is `n` an exact power of two (including 2^0 = 1)? */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Verify an RFC 6962 consistency proof that the tree `second` extends `first`
 * (no rewrite/removal). A rewritten chain fails this check.
 *
 * @param first  The earlier tree `{ tree_size, root_hash }`.
 * @param second The later tree `{ tree_size, root_hash }`.
 * @param path   The consistency path as hex (or byte) hashes.
 * @returns true iff `second` is a consistent extension of `first`.
 */
export function verifyConsistency(
  first: { tree_size: number; root_hash: HashInput },
  second: { tree_size: number; root_hash: HashInput },
  path: HashInput[],
): boolean {
  const firstSize = first.tree_size;
  const secondSize = second.tree_size;

  if (
    !Number.isInteger(firstSize) ||
    !Number.isInteger(secondSize) ||
    firstSize < 0 ||
    firstSize > secondSize
  ) {
    return false;
  }

  let firstHash: Uint8Array;
  let secondHash: Uint8Array;
  try {
    firstHash = toBytes(first.root_hash);
    secondHash = toBytes(second.root_hash);
  } catch {
    return false;
  }

  // Equal trees: proof must be empty and roots must match.
  if (firstSize === secondSize) {
    return path.length === 0 && bytesEqual(firstHash, secondHash);
  }
  // A proof from the empty tree carries no information; reject.
  if (firstSize === 0) {
    return false;
  }

  let nodes: Uint8Array[];
  try {
    nodes = path.map(toBytes);
  } catch {
    return false;
  }

  // Step 1: if `first` is an exact power of 2, prepend `firstHash`.
  if (isPowerOfTwo(firstSize)) {
    nodes = [firstHash, ...nodes];
  }

  if (nodes.length === 0) {
    return false;
  }

  // Step 2-3.
  let fn = firstSize - 1;
  let sn = secondSize - 1;
  while ((fn & 1) === 1) {
    fn >>>= 1;
    sn >>>= 1;
  }

  // Step 4.
  let fr = nodes[0]!;
  let sr = nodes[0]!;

  // Step 5.
  for (let i = 1; i < nodes.length; i++) {
    const c = nodes[i]!;
    if (sn === 0) {
      return false;
    }
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1) === 0) {
        do {
          fn >>>= 1;
          sn >>>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>>= 1;
    sn >>>= 1;
  }

  // Step 6.
  return sn === 0 && bytesEqual(fr, firstHash) && bytesEqual(sr, secondHash);
}

/* -------------------------------------------------------------------------- */
/* On-chain anchor check — read-only eth_call to PQAnchorRegistry             */
/* -------------------------------------------------------------------------- */

/**
 * Selector for `anchors(uint256)` — the auto-generated getter of
 * `mapping(uint256 => Anchor) public anchors`.
 *
 * keccak256("anchors(uint256)")[0:4] = 0x368b733e.
 * (Ethereum keccak256, not NIST SHA3 — precomputed so the SDK stays
 * zero-dependency; node:crypto has no keccak256.)
 */
const ANCHORS_SELECTOR = '0x368b733e';

/**
 * PQAnchorRegistry.Anchor struct field order (each a 32-byte ABI word in the
 * `anchors(uint256)` return tuple). Confirmed against
 * `contracts/src/PQAnchorRegistry.sol`:
 *
 *   word 0  merkleRoot       (bytes32)  <- the anchored STH root
 *   word 1  sha3Root         (bytes32)
 *   word 2  blockFrom        (uint64)
 *   word 3  blockTo          (uint64)
 *   word 4  eventCount       (uint64)   <- the anchored tree_size
 *   word 5  timestamp        (uint64)
 *   word 6  anchorChain      (bytes32)
 *   word 7  anchorTxHash     (bytes32)
 *   word 8  pqSignatureHash  (bytes32)
 *   word 9  pqKeyHash        (bytes32)
 */
const WORD_MERKLE_ROOT = 0;
const WORD_EVENT_COUNT = 4;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: string;
  error?: { code?: number; message?: string };
}

/** Options for {@link verifySthAnchored}. */
export interface SthAnchoredOptions {
  /** JSON-RPC read endpoint of the HARA chain (eth_call). */
  rpcReadUrl: string;
  /** Custom fetch (defaults to global `fetch`, Node 18+). */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** Left-pad a bigint to a 32-byte (64 hex char) word, no `0x`. */
function toWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** Extract 32-byte word `index` from a `0x`-prefixed return blob (no bounds error → ''). */
function wordAt(hexResult: string, index: number): string {
  const body = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  const start = index * 64;
  return body.slice(start, start + 64);
}

/**
 * Read-only: confirm the STH root is anchored on-chain.
 *
 * Performs a single JSON-RPC `eth_call` of `anchors(onChainId)` on the STH's
 * `anchor.contract` (the Ledger-scoped PQAnchorRegistry instance), decodes the
 * returned struct tuple, and checks that:
 *   • on-chain `merkleRoot`  === `sth.root_hash`, and
 *   • on-chain `eventCount`  === `sth.tree_size`.
 *
 * @returns true iff both match. Returns false (never throws) on RPC error,
 *          missing anchor, or a mismatch.
 */
export async function verifySthAnchored(
  sth: STH,
  opts: SthAnchoredOptions,
): Promise<boolean> {
  const contract = sth.anchor?.contract;
  const onChainId = sth.anchor?.onChainId;
  if (!contract || onChainId === undefined || onChainId === null) {
    return false;
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('verifySthAnchored: no fetch available (Node 18+ or pass opts.fetch)');
  }

  let anchorId: bigint;
  try {
    anchorId = BigInt(onChainId);
  } catch {
    return false;
  }

  const data = ANCHORS_SELECTOR + toWord(anchorId);
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contract, data }, 'latest'],
  };

  let json: JsonRpcResponse;
  try {
    const res = await fetchImpl(opts.rpcReadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return false;
    }
    json = (await res.json()) as JsonRpcResponse;
  } catch {
    return false;
  }

  if (json.error || typeof json.result !== 'string') {
    return false;
  }

  const merkleRootWord = wordAt(json.result, WORD_MERKLE_ROOT);
  const eventCountWord = wordAt(json.result, WORD_EVENT_COUNT);
  if (merkleRootWord.length !== 64 || eventCountWord.length !== 64) {
    return false;
  }

  // A zeroed merkleRoot means the anchor id does not exist.
  if (/^0+$/.test(merkleRootWord)) {
    return false;
  }

  let onChainRoot: Uint8Array;
  let expectedRoot: Uint8Array;
  try {
    onChainRoot = hexToBytes(merkleRootWord);
    expectedRoot = toBytes(sth.root_hash);
  } catch {
    return false;
  }
  if (!bytesEqual(onChainRoot, expectedRoot)) {
    return false;
  }

  let onChainEventCount: bigint;
  try {
    onChainEventCount = BigInt('0x' + eventCountWord);
  } catch {
    return false;
  }
  return onChainEventCount === BigInt(sth.tree_size);
}
