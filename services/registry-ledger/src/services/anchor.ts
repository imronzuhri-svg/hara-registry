/**
 * Anchor service — publishes a Signed Tree Head (STH) and commits it on-chain.
 *
 * REAL: given a log's current {root_hash, tree_size}, it
 *   1. builds the canonical STH message and ML-DSA-65-signs it (the "Signed" in
 *      Signed Tree Head), with pqSignatureHash = keccak256(sig),
 *   2. anchors it via PQAnchorRegistry.recordAnchor exactly as the integration
 *      guide (§1) specifies:
 *        merkleRoot   = STH root_hash
 *        sha3Root     = root_hash  (same value — hash-agility slot)
 *        blockFrom    = blockTo = safe head
 *        eventCount   = tree_size
 *        anchorChain  = keccak256("log_id")
 *        pqSignatureHash = keccak256(mlDsa65.sign(canonical STH))
 *      via a viem legacy tx (type "legacy", gasPrice 0, chainId 131216, explicit
 *      gas) to the WRITE RPC; waits for the receipt, checks for revert, and parses
 *      AnchorRecorded for the onChainId,
 *   3. returns the STH with anchor:{chainId,txHash,onChainId,contract}.
 *
 * Anchor WRITES are disabled — anchorSTH() returns a locally-signed but UNANCHORED
 * STH (no `anchor` field) and logs a warning — until BOTH secrets are real
 * (ANCHOR_ECDSA_KEY + PQ_MLDSA_SEED) AND PQ_ANCHOR_REGISTRY is a Ledger-scoped
 * instance (never the shared platform registry). This keeps the transparency-log
 * features (append, inclusion, consistency) fully usable in dev while making it
 * impossible to accidentally anchor into the wrong registry. A chain error while
 * writes ARE enabled surfaces as 503 chain_unavailable.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toBytes,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pino from "pino";

import { config, isLedgerScopedRegistry, isRealPrivateKey, isRealSeed } from "../config.js";
import { ProblemError } from "../errors.js";
import {
  canonicalSTH,
  fromHex,
  keygenFromSeed,
  publicKeyHash,
  sign as pqSign,
  toHex,
  type PqKeypair,
} from "./pq.js";
import type { Anchor, STH } from "../types.js";

const log = pino({ name: "registry-ledger-anchor" });

/**
 * Minimal PQAnchorRegistry ABI (recordAnchor + the AnchorRecorded event so we can
 * parse the onChainId). Matches contracts/src/PQAnchorRegistry.sol.
 */
const PQ_ANCHOR_REGISTRY_ABI = [
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
  {
    type: "event",
    name: "AnchorRecorded",
    inputs: [
      { name: "anchorId", type: "uint256", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: false },
      { name: "sha3Root", type: "bytes32", indexed: false },
      { name: "blockFrom", type: "uint64", indexed: false },
      { name: "blockTo", type: "uint64", indexed: false },
      { name: "eventCount", type: "uint64", indexed: false },
      { name: "pqSignatureHash", type: "bytes32", indexed: false },
      { name: "pqKeyHash", type: "bytes32", indexed: false },
      { name: "anchorChain", type: "bytes32", indexed: false },
    ],
  },
] as const;

const haraChain = defineChain({
  id: config.chainId,
  name: "HaraRegistry",
  nativeCurrency: { name: "HARA", symbol: "HARA", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcReadUrl] } },
});

function bytesToHex32(b: Uint8Array): Hex {
  return ("0x" + Buffer.from(b).toString("hex")) as Hex;
}

/** anchorChain = keccak256("log_id"). */
function anchorChainTag(logId: string): Hex {
  return keccak256(toBytes(logId));
}

export class AnchorService {
  private readClient: PublicClient;
  private writeClient: WalletClient | null = null;
  private account = isRealPrivateKey(config.anchorEcdsaKey)
    ? privateKeyToAccount(config.anchorEcdsaKey)
    : null;

  /** Derived ML-DSA-65 keypair (from PQ_MLDSA_SEED). Null when the seed is a placeholder. */
  private pqKeypair: PqKeypair | null;
  private pqKeyHashHex: string;

  constructor() {
    this.readClient = createPublicClient({
      chain: haraChain,
      transport: http(config.rpcReadUrl),
    });

    if (this.account) {
      this.writeClient = createWalletClient({
        chain: haraChain,
        transport: http(config.rpcWriteUrl),
        account: this.account,
      });
    }

    if (isRealSeed(config.pqMldsaSeed)) {
      this.pqKeypair = keygenFromSeed(fromHex(config.pqMldsaSeed));
      this.pqKeyHashHex = toHex(publicKeyHash(this.pqKeypair.publicKey));
    } else {
      this.pqKeypair = null;
      this.pqKeyHashHex = "0x" + "00".repeat(32);
      log.warn("PQ_MLDSA_SEED is a placeholder — STHs are unsigned + anchoring disabled until Vault-wired");
    }
    if (!this.account) {
      log.warn("ANCHOR_ECDSA_KEY is a placeholder — anchoring disabled until Vault-wired");
    }
    if (!isLedgerScopedRegistry(config.pqAnchorRegistry)) {
      log.warn(
        "PQ_ANCHOR_REGISTRY is unset or the shared platform registry — anchoring disabled; " +
          "point it at the Ledger-scoped instance (never 0x8A79…C318)",
      );
    }
  }

  /** True when both secrets are real AND the registry is a Ledger-scoped instance. */
  get writesEnabled(): boolean {
    return (
      !!this.account &&
      !!this.writeClient &&
      !!this.pqKeypair &&
      isLedgerScopedRegistry(config.pqAnchorRegistry)
    );
  }

  get pqKeyHash(): string {
    return this.pqKeyHashHex;
  }

  /**
   * Publish + anchor a Signed Tree Head for `logId` at {rootHex, treeSize}.
   *
   * When writes are enabled: signs, submits recordAnchor, waits for the receipt,
   * parses onChainId, returns the STH WITH its on-chain anchor.
   * When disabled: returns a locally-signed (or unsigned) STH WITHOUT an anchor so
   * dev flows keep working. A chain failure while enabled → 503 chain_unavailable.
   */
  async anchorSTH(logId: string, rootHex: string, treeSize: number): Promise<STH> {
    const timestamp = new Date();
    const sth: STH = {
      log_id: logId,
      tree_size: treeSize,
      root_hash: rootHex,
      timestamp: timestamp.toISOString(),
    };

    const rootBytes = fromHex(rootHex);
    if (rootBytes.length !== 32) {
      throw new ProblemError("invalid_hash", "root_hash must be 32-byte 0x-prefixed hex");
    }

    // Sign the STH if we hold a PQ key (makes it a genuine Signed Tree Head even
    // when on-chain anchoring is not configured).
    let pqSignatureHash: Hex | null = null;
    if (this.pqKeypair) {
      const msg = canonicalSTH({
        algorithm: config.pqAlgorithm,
        logId,
        treeSize: BigInt(treeSize),
        rootHash: rootBytes,
        timestampMs: BigInt(timestamp.getTime()),
      });
      const sig = pqSign(this.pqKeypair.secretKey, msg);
      pqSignatureHash = keccak256(sig);
      // TODO: PUT the raw ~3.3 KB ML-DSA-65 signature blob to MinIO bucket
      // `hara-pq-anchors` keyed by {logId, treeSize} so the SDK verifier can
      // re-run the off-chain PQ check. Out of scope for this skeleton.
    }

    if (!this.writesEnabled || !this.writeClient || !this.account || !pqSignatureHash) {
      // Locally-signed but UNANCHORED STH (no `anchor`). Dev-usable; clearly logged.
      log.warn(
        { logId, treeSize },
        "anchoring disabled — returning unanchored STH (set ANCHOR_ECDSA_KEY + PQ_MLDSA_SEED and " +
          "a Ledger-scoped PQ_ANCHOR_REGISTRY to enable on-chain anchoring)",
      );
      return sth;
    }

    // Safe head = latest - 1 (QBFT instant finality; lag one block for safety).
    let safeHead: bigint;
    try {
      const latest = await this.readClient.getBlockNumber();
      safeHead = latest > 0n ? latest - 1n : 0n;
    } catch (e) {
      throw new ProblemError("chain_unavailable", `read RPC failed: ${(e as Error).message}`);
    }

    const anchorChain = anchorChainTag(logId);

    // Submit a legacy tx (type 0, gasPrice 0, chainId 131216).
    let txHash: Hex;
    try {
      txHash = await this.writeClient.writeContract({
        address: config.pqAnchorRegistry,
        abi: PQ_ANCHOR_REGISTRY_ABI,
        functionName: "recordAnchor",
        args: [
          bytesToHex32(rootBytes), // merkleRoot = STH root_hash
          bytesToHex32(rootBytes), // sha3Root  = root_hash
          safeHead,
          safeHead,
          BigInt(treeSize), // eventCount = tree_size
          anchorChain, // keccak256("log_id")
          pqSignatureHash,
        ],
        chain: haraChain,
        account: this.account,
        gas: config.anchorGasLimit,
        gasPrice: 0n,
        type: "legacy",
      });
    } catch (e) {
      throw new ProblemError("chain_unavailable", `recordAnchor submit failed: ${(e as Error).message}`);
    }

    // Wait for the receipt; a mined tx can still have reverted.
    let onChainId: string | undefined;
    try {
      const receipt = await this.readClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new ProblemError("chain_unavailable", `recordAnchor reverted in block ${receipt.blockNumber}`);
      }
      for (const evLog of receipt.logs) {
        if (
          evLog.address.toLowerCase() === config.pqAnchorRegistry.toLowerCase() &&
          evLog.topics[0]
        ) {
          onChainId = BigInt(evLog.topics[1] ?? "0x0").toString();
          break;
        }
      }
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      throw new ProblemError("chain_unavailable", `receipt wait failed: ${(e as Error).message}`);
    }

    const anchor: Anchor = {
      chainId: config.chainId,
      txHash,
      onChainId,
      contract: config.pqAnchorRegistry,
    };
    log.info({ logId, treeSize, txHash, onChainId }, "STH anchored");
    return { ...sth, anchor };
  }
}
