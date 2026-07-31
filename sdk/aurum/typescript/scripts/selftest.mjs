/**
 * Verifier self-test — proves correctness, not just compilation.
 *
 * Builds reference RFC 6962 Merkle trees with an INDEPENDENT implementation
 * (defined here), generates real inclusion + consistency proofs per RFC 6962
 * §2.1, then asserts the SDK's verifier accepts valid proofs and rejects
 * tampered ones. Also checks two hardcoded known-answer vectors.
 *
 * Run: node scripts/selftest.mjs   (after `npm run build`)
 */
import { createHash } from 'node:crypto';
import {
  verifyInclusion,
  verifyConsistency,
  leafHash,
  bytesToHex,
} from '../dist/index.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const LEAF = (d) => sha256(Uint8Array.of(0x00, ...d));
const NODE = (l, r) => sha256(Uint8Array.of(0x01, ...l, ...r));

// Largest power of two strictly less than n.
function largestPow2LessThan(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// RFC 6962 Merkle Tree Hash of data entries D[n] (each entry raw bytes).
function MTH(D) {
  if (D.length === 0) return sha256(new Uint8Array(0));
  if (D.length === 1) return LEAF(D[0]);
  const k = largestPow2LessThan(D.length);
  return NODE(MTH(D.slice(0, k)), MTH(D.slice(k)));
}

// RFC 6962 inclusion path PATH(m, D[n]) — audit path for leaf index m.
function PATH(m, D) {
  const n = D.length;
  if (n === 1) return [];
  const k = largestPow2LessThan(n);
  if (m < k) {
    return [...PATH(m, D.slice(0, k)), MTH(D.slice(k))];
  }
  return [...PATH(m - k, D.slice(k)), MTH(D.slice(0, k))];
}

// RFC 6962 consistency proof PROOF(m, D[n]) with SUBPROOF.
function SUBPROOF(m, D, b) {
  const n = D.length;
  if (m === n) return b ? [] : [MTH(D)];
  const k = largestPow2LessThan(n);
  if (m <= k) {
    return [...SUBPROOF(m, D.slice(0, k), b), MTH(D.slice(k))];
  }
  return [...SUBPROOF(m - k, D.slice(k), false), MTH(D.slice(0, k))];
}
function PROOF(m, D) {
  return SUBPROOF(m, D, true);
}

const hex = (b) => bytesToHex(b);
const mkData = (n) =>
  Array.from({ length: n }, (_, i) => new TextEncoder().encode(`leaf-entry-${i}`));

/* -------------------------------------------------------------------------- */
/* 1. Known-answer vectors (RFC 6962 hashing rules)                           */
/* -------------------------------------------------------------------------- */

// SHA256(0x00) — leaf hash of the empty entry. Well-known CT test value.
const emptyLeaf = hex(leafHash(new Uint8Array(0)));
assert(
  emptyLeaf === '0x6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  `empty-entry leaf hash KAT, got ${emptyLeaf}`,
);

// Two-leaf root: MTH({d0,d1}) = NODE(LEAF(d0), LEAF(d1)); check verifyInclusion
// of leaf 0 against it with a one-element audit path [LEAF(d1)].
{
  const D = mkData(2);
  const root = MTH(D);
  const ok0 = verifyInclusion(LEAF(D[0]), { leaf_index: 0, tree_size: 2, audit_path: [hex(LEAF(D[1]))] }, hex(root));
  const ok1 = verifyInclusion(LEAF(D[1]), { leaf_index: 1, tree_size: 2, audit_path: [hex(LEAF(D[0]))] }, hex(root));
  assert(ok0 && ok1, 'two-leaf inclusion (both leaves) verifies');
}

/* -------------------------------------------------------------------------- */
/* 2. Inclusion proofs across many tree sizes and every leaf index            */
/* -------------------------------------------------------------------------- */

for (const n of [1, 2, 3, 4, 5, 7, 8, 13, 16, 33, 100]) {
  const D = mkData(n);
  const root = hex(MTH(D));
  for (let m = 0; m < n; m++) {
    const proof = { leaf_index: m, tree_size: n, audit_path: PATH(m, D).map(hex) };
    const lh = LEAF(D[m]);
    assert(verifyInclusion(lh, proof, root), `inclusion valid n=${n} m=${m}`);
    // Accept hex leaf input too.
    assert(verifyInclusion(hex(lh), proof, root), `inclusion valid (hex leaf) n=${n} m=${m}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Negative inclusion cases — tampering must be rejected                   */
/* -------------------------------------------------------------------------- */

{
  const n = 16, m = 5;
  const D = mkData(n);
  const root = hex(MTH(D));
  const good = PATH(m, D).map(hex);
  const lh = LEAF(D[m]);

  // Flip one byte of the root.
  const badRootBytes = MTH(D);
  badRootBytes[0] ^= 0xff;
  assert(!verifyInclusion(lh, { leaf_index: m, tree_size: n, audit_path: good }, hex(badRootBytes)), 'reject flipped root');

  // Flip one byte in the audit path.
  const badPath = [...good];
  const b = new Uint8Array((await import('../dist/index.js')).hexToBytes(badPath[1]));
  b[3] ^= 0x01;
  badPath[1] = bytesToHex(b);
  assert(!verifyInclusion(lh, { leaf_index: m, tree_size: n, audit_path: badPath }, root), 'reject flipped audit-path node');

  // Wrong leaf hash.
  const wrongLeaf = LEAF(new TextEncoder().encode('not-the-leaf'));
  assert(!verifyInclusion(wrongLeaf, { leaf_index: m, tree_size: n, audit_path: good }, root), 'reject wrong leaf');

  // Wrong index.
  assert(!verifyInclusion(lh, { leaf_index: m + 1, tree_size: n, audit_path: good }, root), 'reject wrong index');

  // Out-of-range index.
  assert(!verifyInclusion(lh, { leaf_index: n, tree_size: n, audit_path: good }, root), 'reject index >= tree_size');
}

/* -------------------------------------------------------------------------- */
/* 4. Consistency proofs — valid extensions across many size pairs            */
/* -------------------------------------------------------------------------- */

for (const n2 of [1, 2, 3, 5, 8, 13, 16, 100]) {
  const D2 = mkData(n2);
  const secondRoot = hex(MTH(D2));
  for (let n1 = 1; n1 <= n2; n1++) {
    const D1 = D2.slice(0, n1);
    const firstRoot = hex(MTH(D1));
    const path = PROOF(n1, D2).map(hex);
    const ok = verifyConsistency(
      { tree_size: n1, root_hash: firstRoot },
      { tree_size: n2, root_hash: secondRoot },
      path,
    );
    assert(ok, `consistency valid n1=${n1} n2=${n2}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Negative consistency cases — a rewritten chain must fail                */
/* -------------------------------------------------------------------------- */

{
  const n1 = 7, n2 = 13;
  const D2 = mkData(n2);
  const D1 = D2.slice(0, n1);
  const firstRoot = hex(MTH(D1));
  const secondRoot = hex(MTH(D2));
  const goodPath = PROOF(n1, D2).map(hex);

  // Rewrite history: change an early leaf, recompute the "first" root the
  // attacker claims. Consistency against the real second tree must fail.
  const rewritten = mkData(n2);
  rewritten[2] = new TextEncoder().encode('REWRITTEN-leaf-2');
  const rewrittenFirstRoot = hex(MTH(rewritten.slice(0, n1)));
  assert(
    !verifyConsistency(
      { tree_size: n1, root_hash: rewrittenFirstRoot },
      { tree_size: n2, root_hash: secondRoot },
      goodPath,
    ),
    'reject rewritten-history first root',
  );

  // Flip a byte in the consistency path.
  const badPath = [...goodPath];
  const bb = new Uint8Array((await import('../dist/index.js')).hexToBytes(badPath[0]));
  bb[0] ^= 0x80;
  badPath[0] = bytesToHex(bb);
  assert(
    !verifyConsistency({ tree_size: n1, root_hash: firstRoot }, { tree_size: n2, root_hash: secondRoot }, badPath),
    'reject flipped consistency-path node',
  );

  // Wrong second root.
  const badSecond = MTH(D2); badSecond[10] ^= 0x0f;
  assert(
    !verifyConsistency({ tree_size: n1, root_hash: firstRoot }, { tree_size: n2, root_hash: hex(badSecond) }, goodPath),
    'reject wrong second root',
  );

  // Equal sizes with non-empty path must fail; equal sizes + empty path + equal roots must pass.
  assert(
    verifyConsistency({ tree_size: n2, root_hash: secondRoot }, { tree_size: n2, root_hash: secondRoot }, []),
    'equal trees + empty path verify',
  );
  assert(
    !verifyConsistency({ tree_size: n2, root_hash: secondRoot }, { tree_size: n2, root_hash: secondRoot }, goodPath),
    'equal trees + non-empty path reject',
  );
}

/* -------------------------------------------------------------------------- */

console.log(`\nverifier self-test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
