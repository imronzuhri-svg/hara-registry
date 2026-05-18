/**
 * Hand-extracted minimal ABIs for PQAnchorRegistry.
 *
 * We don't pull in the full forge artifacts here because:
 *   • this worker only ever touches three functions
 *   • keeping the ABI inline avoids a build-time dependency on the contracts/
 *     compile output
 *   • when the contract evolves, this surface is small enough to update by
 *     hand in seconds
 */

export const PQ_ANCHOR_REGISTRY_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "currentPQKeyHash",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "currentPQAlgorithm",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "anchorCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "rotatePQKey",
    inputs: [
      { name: "newKeyHash", type: "bytes32" },
      { name: "newAlgorithm", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "recordAnchor",
    inputs: [
      { name: "merkleRoot", type: "bytes32" },
      { name: "sha3Root", type: "bytes32" },
      { name: "blockFrom", type: "uint64" },
      { name: "blockTo", type: "uint64" },
      { name: "eventCount", type: "uint64" },
      { name: "anchorChain", type: "bytes32" },
      { name: "pqSignatureHash", type: "bytes32" },
    ],
    outputs: [{ name: "anchorId", type: "uint256" }],
  },
] as const;
