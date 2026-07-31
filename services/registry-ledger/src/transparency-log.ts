/**
 * THE CORE — an append-only RFC 6962 SHA-256 Merkle transparency log.
 *
 * REAL and MUST BE CORRECT: this is the exact tree the separately-built SDK
 * verifier checks against. It implements RFC 6962 to the letter:
 *
 *   • leaf hash   = SHA256(0x00 || leaf)
 *   • node hash   = SHA256(0x01 || left || right)
 *   • Merkle Tree Hash (MTH), inclusion PATH, and consistency PROOF exactly as
 *     specified in RFC 6962 §2.1.
 *
 * One `TransparencyLog` instance = one `log_id`. Leaves live in memory (this is a
 * skeleton — a persistent deployment rebuilds the tree from the store's leaf table
 * on boot, see store/postgres.ts). The tree is computed on demand from the leaf
 * list; a production log would cache the "Merkle mountain range" of complete
 * subtrees, but a straight recursive MTH is unambiguous and easy to audit, which
 * matters far more here than throughput.
 *
 * Run the internal self-test with:  npx tsx src/transparency-log.ts --selftest
 */

import { createHash } from "node:crypto";

// ── low-level hashing ─────────────────────────────────────────────────────────

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** RFC 6962 leaf hash: SHA256(0x00 || leaf). */
export function hashLeaf(leaf: Uint8Array): Uint8Array {
  return sha256(LEAF_PREFIX, leaf);
}

/** RFC 6962 interior node hash: SHA256(0x01 || left || right). */
export function hashChildren(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two STRICTLY smaller than n (n > 1). RFC 6962 "k". */
function largestPowerOfTwoSmallerThan(n: number): number {
  if (n < 2) throw new Error("k is only defined for n > 1");
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

// ── hex helpers ───────────────────────────────────────────────────────────────

export function toHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

// ── proof shapes (hex, wire-ready) ────────────────────────────────────────────

export interface InclusionProof {
  leaf_index: number;
  tree_size: number;
  audit_path: string[]; // 0x-prefixed 32-byte hashes
}

export interface ConsistencyProof {
  first_size: number;
  second_size: number;
  consistency_path: string[];
}

// ── the log ───────────────────────────────────────────────────────────────────

export class TransparencyLog {
  private readonly leaves: Uint8Array[] = [];

  constructor(public readonly logId: string, initialLeaves: Uint8Array[] = []) {
    for (const l of initialLeaves) this.leaves.push(Uint8Array.from(l));
  }

  /** Append a leaf. Returns its 0-based leaf_index. */
  append(leaf: Uint8Array): number {
    this.leaves.push(Uint8Array.from(leaf));
    return this.leaves.length - 1;
  }

  treeSize(): number {
    return this.leaves.length;
  }

  /** The leaf hash at an index (SHA256(0x00 || leaf)), hex. */
  leafHashHex(index: number): string {
    if (index < 0 || index >= this.leaves.length) {
      throw new RangeError(`leaf_index ${index} out of range [0, ${this.leaves.length})`);
    }
    return toHex(hashLeaf(this.leaves[index]!));
  }

  /** Current Merkle Tree Hash (root), hex. Empty tree → SHA256() per RFC 6962. */
  currentRootHex(): string {
    return toHex(this.mth(0, this.leaves.length));
  }

  /** Root of the tree at an earlier size (for STHs / checkpoints), hex. */
  rootAtHex(treeSize: number): string {
    if (treeSize < 0 || treeSize > this.leaves.length) {
      throw new RangeError(`tree_size ${treeSize} out of range [0, ${this.leaves.length}]`);
    }
    return toHex(this.mth(0, treeSize));
  }

  // ── RFC 6962 Merkle Tree Hash over the half-open leaf range [start, end) ──────
  private mth(start: number, end: number): Uint8Array {
    const n = end - start;
    if (n === 0) return sha256(); // MTH({}) = SHA256() of the empty string
    if (n === 1) return hashLeaf(this.leaves[start]!);
    const k = largestPowerOfTwoSmallerThan(n);
    return hashChildren(this.mth(start, start + k), this.mth(start + k, end));
  }

  /**
   * Inclusion proof (audit path) for `leafIndex` against the tree of size
   * `treeSize`. RFC 6962 §2.1.1 PATH(m, D[n]).
   */
  inclusionProof(leafIndex: number, treeSize: number): InclusionProof {
    if (treeSize < 0 || treeSize > this.leaves.length) {
      throw new RangeError(`tree_size ${treeSize} out of range [0, ${this.leaves.length}]`);
    }
    if (leafIndex < 0 || leafIndex >= treeSize) {
      throw new RangeError(`leaf_index ${leafIndex} not in tree of size ${treeSize}`);
    }
    const path = this.path(leafIndex, 0, treeSize).map(toHex);
    return { leaf_index: leafIndex, tree_size: treeSize, audit_path: path };
  }

  // PATH(m, D[start:end]) — m is the ABSOLUTE leaf index.
  private path(m: number, start: number, end: number): Uint8Array[] {
    const n = end - start;
    if (n === 1) return [];
    const k = largestPowerOfTwoSmallerThan(n);
    if (m - start < k) {
      // leaf in the left subtree; sibling is the right subtree's MTH
      return [...this.path(m, start, start + k), this.mth(start + k, end)];
    }
    // leaf in the right subtree; sibling is the left subtree's MTH
    return [...this.path(m, start + k, end), this.mth(start, start + k)];
  }

  /**
   * Consistency proof that the tree of size `secondSize` extends (is an
   * append-only superset of) the tree of size `firstSize`. RFC 6962 §2.1.2
   * PROOF(m, D[n]) with 0 < m <= n.
   */
  consistencyProof(firstSize: number, secondSize: number): ConsistencyProof {
    if (firstSize < 0 || secondSize > this.leaves.length || firstSize > secondSize) {
      throw new RangeError(
        `invalid consistency range first=${firstSize} second=${secondSize} size=${this.leaves.length}`,
      );
    }
    // Degenerate but well-defined: same size (or first=0) → empty path.
    if (firstSize === 0 || firstSize === secondSize) {
      return { first_size: firstSize, second_size: secondSize, consistency_path: [] };
    }
    const path = this.subproof(firstSize, 0, secondSize, true).map(toHex);
    return { first_size: firstSize, second_size: secondSize, consistency_path: path };
  }

  // SUBPROOF(m, D[start:end], b) per RFC 6962 §2.1.2.
  private subproof(m: number, start: number, end: number, b: boolean): Uint8Array[] {
    const n = end - start;
    if (m === n) {
      // The subtree is entirely within the first tree.
      return b ? [] : [this.mth(start, end)];
    }
    const k = largestPowerOfTwoSmallerThan(n);
    if (m <= k) {
      // First tree is contained in the left subtree; right subtree is new.
      return [...this.subproof(m, start, start + k, b), this.mth(start + k, end)];
    }
    // Left subtree is wholly in the first tree; recurse into the right.
    return [...this.subproof(m - k, start + k, end, false), this.mth(start, start + k)];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Standalone verifiers — the reference the SDK verifier must agree with.
//  These take ONLY the proof + roots (no tree access), exactly as an offline
//  auditor would run them (RFC 6962 §2.1.1 / §2.1.2 verification algorithms).
// ─────────────────────────────────────────────────────────────────────────────

/** Verify an inclusion proof. RFC 6962 §2.1.1. */
export function verifyInclusion(
  leafHashHex: string,
  proof: InclusionProof,
  rootHex: string,
): boolean {
  const { leaf_index: m, tree_size: n, audit_path } = proof;
  if (m >= n) return false;
  let fn = m;
  let sn = n - 1;
  let r = fromHex(leafHashHex);
  for (const pHex of audit_path) {
    if (sn === 0) return false;
    const p = fromHex(pHex);
    if ((fn & 1) === 1 || fn === sn) {
      r = hashChildren(p, r);
      if ((fn & 1) === 0) {
        // walk up while the current node is a left child
        while (fn !== 0 && (fn & 1) === 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = hashChildren(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && toHex(r) === lc(rootHex);
}

/** Verify a consistency proof. RFC 6962 §2.1.2. */
export function verifyConsistency(
  firstSize: number,
  firstRootHex: string,
  secondSize: number,
  secondRootHex: string,
  path: string[],
): boolean {
  if (firstSize === 0) return true; // any tree is consistent with the empty tree
  if (firstSize === secondSize) {
    return path.length === 0 && lc(firstRootHex) === lc(secondRootHex);
  }
  if (firstSize > secondSize) return false;

  let nodes = path.map(fromHex);
  // Step 2: if `first` is an exact power of two, prepend the first root.
  const firstIsPow2 = (firstSize & (firstSize - 1)) === 0;
  if (firstIsPow2) nodes = [fromHex(firstRootHex), ...nodes];
  if (nodes.length === 0) return false;

  let fn = firstSize - 1;
  let sn = secondSize - 1;
  // Step 4: right-shift until LSB(fn) is not set.
  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let fr = nodes[0]!;
  let sr = nodes[0]!;
  for (let i = 1; i < nodes.length; i++) {
    const c = nodes[i]!;
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = hashChildren(c, fr);
      sr = hashChildren(c, sr);
      if ((fn & 1) === 0) {
        while (fn !== 0 && (fn & 1) === 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = hashChildren(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return fn === 0 && toHex(fr) === lc(firstRootHex) && toHex(sr) === lc(secondRootHex);
}

function lc(hex: string): string {
  return hex.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal self-test — builds trees, then checks every inclusion + consistency
//  proof against the standalone verifiers. Also pins a few known RFC 6962 vectors.
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfTestResult {
  ok: boolean;
  checks: number;
  failures: string[];
}

export function selfTest(maxSize = 33): SelfTestResult {
  const failures: string[] = [];
  let checks = 0;

  const leaf = (i: number): Uint8Array => Uint8Array.from(Buffer.from(`leaf-${i}`, "utf-8"));

  // Known RFC 6962 vectors for the empty tree and a single leaf.
  const empty = new TransparencyLog("t").currentRootHex();
  if (empty !== toHex(sha256())) failures.push("empty-tree root mismatch");
  checks++;

  const single = new TransparencyLog("t", [leaf(0)]).currentRootHex();
  if (single !== toHex(hashLeaf(leaf(0)))) failures.push("single-leaf root mismatch");
  checks++;

  // Build a log up to maxSize; verify inclusion for every (index, size) pair and
  // consistency for every (first, second) pair.
  const log = new TransparencyLog("t");
  for (let size = 1; size <= maxSize; size++) {
    log.append(leaf(size - 1));
    const root = log.currentRootHex();

    for (let idx = 0; idx < size; idx++) {
      const proof = log.inclusionProof(idx, size);
      const ok = verifyInclusion(log.leafHashHex(idx), proof, root);
      checks++;
      if (!ok) failures.push(`inclusion FAIL idx=${idx} size=${size}`);
    }
  }

  for (let first = 1; first <= maxSize; first++) {
    for (let second = first; second <= maxSize; second++) {
      const fRoot = log.rootAtHex(first);
      const sRoot = log.rootAtHex(second);
      const cp = log.consistencyProof(first, second);
      const ok = verifyConsistency(first, fRoot, second, sRoot, cp.consistency_path);
      checks++;
      if (!ok) failures.push(`consistency FAIL first=${first} second=${second}`);
    }
  }

  // Negative controls: a tampered leaf hash must NOT verify.
  const badProof = log.inclusionProof(0, maxSize);
  const tampered = toHex(hashLeaf(Uint8Array.from(Buffer.from("not-a-real-leaf"))));
  if (verifyInclusion(tampered, badProof, log.rootAtHex(maxSize))) {
    failures.push("negative control FAIL: tampered leaf verified");
  }
  checks++;

  return { ok: failures.length === 0, checks, failures };
}

// Run when invoked directly: `tsx src/transparency-log.ts --selftest`
if (process.argv[1] && process.argv[1].endsWith("transparency-log.ts")) {
  const res = selfTest();
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      { selfTest: res.ok ? "PASS" : "FAIL", checks: res.checks, failures: res.failures },
      null,
      2,
    ),
  );
  process.exit(res.ok ? 0 : 1);
}
