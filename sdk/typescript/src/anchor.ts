import { encodeFunctionData, keccak256, type Hex } from "viem";

import { pqAnchorRegistryAbi, type RecordAnchorParams } from "./contracts.js";

/**
 * Post-quantum anchoring helpers.
 *
 * The PQAnchorRegistry stores a hybrid audit anchor: a Merkle root of an
 * on-chain event range PLUS a commitment to a post-quantum (ML-DSA-65,
 * NIST FIPS 204) signature over that root. The contract only commits the
 * **hash** of the PQ signature on-chain — the multi-kilobyte signature blob
 * lives off-chain (MinIO bucket `hara-pq-anchors`) and is verified off-chain
 * against the published PQ public key.
 *
 * ML-DSA signing is NOT done here — the caller signs with their PQ private key,
 * then passes the resulting signature bytes to `pqSignatureHashFromSig` (or
 * supplies a precomputed hash). For ML-DSA in JS/TS, use the optional dependency
 * `@noble/post-quantum` (ml_dsa65):
 *
 *   import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
 *   const sig = ml_dsa65.sign(secretKey, messageBytes);   // Uint8Array (~3 KB)
 *   const pqSignatureHash = pqSignatureHashFromSig(sig);  // bytes32 commitment
 *
 * pqSignatureHash MUST be non-zero; PQAnchorRegistry reverts MissingPQCommitment()
 * on a zero hash (use the legacy AnchorRegistry if you don't want PQ).
 */

/** keccak256 of the raw ML-DSA signature bytes → the on-chain bytes32 commitment. */
export function pqSignatureHashFromSig(signature: Uint8Array | Hex): Hex {
  return keccak256(signature);
}

/**
 * Build the calldata for PQAnchorRegistry.recordAnchor(...).
 * Submit with HaraChainClient.sendLegacyTx({ to: ADDRESSES.PQAnchorRegistry, data }),
 * or use the PQAnchorRegistry wrapper in contracts.ts.
 */
export function buildRecordAnchorCalldata(params: RecordAnchorParams): Hex {
  if (params.pqSignatureHash === "0x" + "0".repeat(64)) {
    throw new Error(
      "pqSignatureHash is zero — PQAnchorRegistry.recordAnchor reverts MissingPQCommitment(). " +
        "Sign the Merkle root with ML-DSA-65 and pass keccak256(signature).",
    );
  }
  if (params.blockTo < params.blockFrom) {
    throw new Error("blockTo < blockFrom — recordAnchor reverts EmptyRange().");
  }

  return encodeFunctionData({
    abi: pqAnchorRegistryAbi,
    functionName: "recordAnchor",
    args: [
      params.merkleRoot,
      params.sha3Root,
      params.blockFrom,
      params.blockTo,
      params.eventCount,
      params.anchorChain,
      params.pqSignatureHash,
    ],
  });
}
