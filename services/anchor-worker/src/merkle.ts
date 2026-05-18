import { keccak_256 } from "@noble/hashes/sha3";

/**
 * Keccak-256 binary Merkle tree, Bitcoin-style odd-leaf handling
 * (duplicate the last leaf when the count is odd at any level).
 *
 * Inputs are arbitrary byte arrays — typically the keccak256 of each event's
 * (tx_hash || log_index) so the tree commits to a unique identifier per log.
 *
 * Returns:
 *   • root: 32 bytes
 *   • leafCount: input length (informational; auditors can sanity-check)
 *
 * Empty input is a domain error — anchoring zero events makes no audit sense.
 */

export interface MerkleResult {
  root: Uint8Array;
  leafCount: number;
}

const concatHash = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const buf = new Uint8Array(a.length + b.length);
  buf.set(a, 0);
  buf.set(b, a.length);
  return keccak_256(buf);
};

export function merkleRoot(leaves: Uint8Array[]): MerkleResult {
  if (leaves.length === 0) {
    throw new Error("merkleRoot: empty leaf set");
  }
  let level: Uint8Array[] = leaves.map((l) =>
    l.length === 32 ? l : keccak_256(l),
  );
  while (level.length > 1) {
    if (level.length % 2 === 1) {
      // duplicate the last leaf so every level has an even count
      level.push(level[level.length - 1]);
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(concatHash(level[i], level[i + 1]));
    }
    level = next;
  }
  return { root: level[0], leafCount: leaves.length };
}

/** Convenience: build a leaf from (tx_hash, log_index). */
export function leafFromEvent(txHash: Uint8Array, logIndex: number): Uint8Array {
  const idxBuf = new Uint8Array(4);
  new DataView(idxBuf.buffer).setUint32(0, logIndex, false); // big-endian
  const buf = new Uint8Array(txHash.length + idxBuf.length);
  buf.set(txHash, 0);
  buf.set(idxBuf, txHash.length);
  return keccak_256(buf);
}
