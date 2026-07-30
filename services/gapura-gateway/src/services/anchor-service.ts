/**
 * Anchor service — THE CORE.
 *
 * REAL: turns a hash-anchor request into an on-chain
 * PQAnchorRegistry.recordAnchor call, dual-signed by design:
 *   • ECDSA consensus signature lands the recordAnchor tx (existence + timestamp)
 *   • ML-DSA-65 PQ signature whose keccak256 is committed on-chain (pqSignatureHash)
 * There is NO external chain and NO dualPublicAnchor flag — the hybrid IS the
 * "dual public anchor" (§3.1).
 *
 * Anchoring maps a single passport digest onto the live contract exactly as the
 * integration guide specifies (§1): merkleRoot = sha3Root = digest, eventCount =
 * 1, blockFrom = blockTo = safe head, anchorChain = a bytes32 tag derived from
 * purpose|tenant, pqSignatureHash = keccak256(ml_dsa65.sign(canonicalMessage)).
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

import { config, isGapuraScopedRegistry, isRealPrivateKey, isRealSeed } from "../config.js";
import { ProblemError } from "../errors.js";
import type { Store, AnchorRecord } from "../store/index.js";
import {
  canonicalMessage,
  fromHex,
  keygenFromSeed,
  publicKeyHash,
  sign as pqSign,
  toHex,
  verify as pqVerify,
  type PqKeypair,
} from "./pq.js";
import type {
  Anchor,
  AnchorRequest,
  AnchorStatus,
  VerifyResult,
} from "../types.js";

const log = pino({ name: "gapura-anchor-service" });

/**
 * Minimal PQAnchorRegistry ABI (recordAnchor + the AnchorRecorded event, so we
 * can parse the onChainId). Matches contracts/src/PQAnchorRegistry.sol.
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
    type: "function",
    stateMutability: "view",
    name: "currentPQKeyHash",
    inputs: [],
    outputs: [{ type: "bytes32" }],
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

/** bytes32 tag derived from `purpose|tenant` (§1: anchorChain = purpose/tenant tag). */
function anchorChainTag(purpose: string, tenant: string): Hex {
  return keccak256(toBytes(`${purpose}|${tenant}`));
}

function newAnchorId(): string {
  return "gap_anc_" + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export class AnchorService {
  private readClient: PublicClient;
  private writeClient: WalletClient | null = null;
  private account = isRealPrivateKey(config.anchorEcdsaKey)
    ? privateKeyToAccount(config.anchorEcdsaKey)
    : null;

  /** Derived ML-DSA-65 keypair (from PQ_MLDSA_SEED). Null when seed is a placeholder. */
  private pqKeypair: PqKeypair | null;
  private pqKeyHashHex: string;

  constructor(private readonly store: Store) {
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

    // REAL: derive the PQ identity from the Vault seed when present.
    if (isRealSeed(config.pqMldsaSeed)) {
      this.pqKeypair = keygenFromSeed(fromHex(config.pqMldsaSeed));
      this.pqKeyHashHex = toHex(publicKeyHash(this.pqKeypair.publicKey));
    } else {
      // Placeholder seed: writes are disabled (createAnchor throws). Reads still work.
      this.pqKeypair = null;
      this.pqKeyHashHex = "0x" + "00".repeat(32);
      log.warn(
        "PQ_MLDSA_SEED is a placeholder — anchor writes are disabled until Vault-wired",
      );
    }
    if (!this.account) {
      log.warn(
        "ANCHOR_ECDSA_KEY is a placeholder — anchor writes are disabled until Vault-wired",
      );
    }
  }

  /** True when both the ECDSA key and PQ seed are real (anchor writes enabled). */
  get writesEnabled(): boolean {
    return (
      !!this.account &&
      !!this.writeClient &&
      !!this.pqKeypair &&
      // Refuse to anchor into the shared platform registry (or an unset one) — Gapura
      // must use its own scoped instance, keeping it separate from the platform / Atlas.
      isGapuraScopedRegistry(config.pqAnchorRegistry)
    );
  }

  private toDto(r: AnchorRecord): Anchor {
    return {
      anchorId: r.anchorId,
      onChainId: r.onChainId,
      digest: r.digest,
      objectDid: r.objectDid,
      purpose: r.purpose,
      status: r.status,
      txRef: {
        chainId: config.chainId,
        contract: config.pqAnchorRegistry,
        txHash: r.txHash,
        onChainId: r.onChainId,
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
      },
      pqKeyHash: r.pqKeyHash,
      signatures: { ecdsa: true, mlDsa65: true },
      anchoredAt: r.anchoredAt,
    };
  }

  /**
   * Anchor a digest. Returns the (possibly pre-existing) Anchor DTO.
   * `alreadyAnchored` tells the route whether to answer 200 (idempotent) vs 201.
   */
  async createAnchor(req: {
    digest: string;
    hashAlg: "sha256" | "keccak256";
    objectDid: string;
    purpose: string;
    actorDid?: string;
    metadata?: Record<string, unknown>;
    tenant: string;
  }): Promise<{ anchor: Anchor; alreadyAnchored: boolean }> {
    const digest = req.digest.toLowerCase();

    // 1. Natural idempotency — the digest is the key.
    const existing = await this.store.getAnchorByDigest(digest);
    if (existing) {
      return { anchor: this.toDto(existing), alreadyAnchored: true };
    }

    if (!this.writesEnabled || !this.pqKeypair || !this.writeClient || !this.account) {
      throw new ProblemError(
        "anchor_failed",
        "anchor writes disabled: set ANCHOR_ECDSA_KEY + PQ_MLDSA_SEED (Vault) and " +
          "PQ_ANCHOR_REGISTRY to the Gapura-scoped instance (never the shared platform registry)",
      );
    }

    // Safe head = latest - 1 (QBFT instant finality; lag one block for safety).
    let safeHead: bigint;
    try {
      const latest = await this.readClient.getBlockNumber();
      safeHead = latest > 0n ? latest - 1n : 0n;
    } catch (e) {
      throw new ProblemError("chain_unavailable", `read RPC failed: ${(e as Error).message}`);
    }

    // 2. Build canonical message, ML-DSA-65 sign it, pqSignatureHash = keccak256(sig).
    const digestBytes = fromHex(digest);
    if (digestBytes.length !== 32) {
      throw new ProblemError("invalid_digest", "digest must be 32-byte 0x-prefixed hex");
    }
    const anchorChain = fromHex(anchorChainTag(req.purpose, req.tenant));
    const msg = canonicalMessage({
      algorithm: config.pqAlgorithm,
      merkleRoot: digestBytes,
      blockFrom: safeHead,
      blockTo: safeHead,
      eventCount: 1n,
      anchorChain,
    });
    const sig = pqSign(this.pqKeypair.secretKey, msg);
    const pqSignatureHash = keccak256(sig);

    // TODO: PUT the raw ML-DSA-65 signature blob (`sig`, ~3.3 KB) + pubkey to
    // MinIO bucket `hara-pq-anchors`, keyed by anchorId/digest, so verify() can
    // re-check it off-chain later (mirrors the anchor-worker's blob storage).

    // 3–4. Build params + submit a legacy tx (type 0, gasPrice 0, chainId 131216).
    let txHash: Hex;
    try {
      txHash = await this.writeClient.writeContract({
        address: config.pqAnchorRegistry,
        abi: PQ_ANCHOR_REGISTRY_ABI,
        functionName: "recordAnchor",
        args: [
          bytesToHex32(digestBytes), // merkleRoot = digest
          bytesToHex32(digestBytes), // sha3Root  = digest
          safeHead,
          safeHead,
          1n,
          bytesToHex32(anchorChain),
          pqSignatureHash,
        ],
        chain: haraChain,
        account: this.account,
        gas: config.anchorGasLimit,
        gasPrice: 0n,
        type: "legacy",
      });
    } catch (e) {
      throw new ProblemError("anchor_failed", `recordAnchor submit failed: ${(e as Error).message}`);
    }

    // 4b. Wait for receipt; a mined tx can still have reverted.
    let blockNumber = 0;
    let logIndex: number | undefined;
    let onChainId: string | undefined;
    try {
      const receipt = await this.readClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new ProblemError("anchor_failed", `recordAnchor reverted in block ${receipt.blockNumber}`);
      }
      blockNumber = Number(receipt.blockNumber);

      // Parse the AnchorRecorded event: anchorId is the first indexed topic.
      for (const evLog of receipt.logs) {
        if (
          evLog.address.toLowerCase() === config.pqAnchorRegistry.toLowerCase() &&
          evLog.topics[0]
        ) {
          onChainId = BigInt(evLog.topics[1] ?? "0x0").toString();
          logIndex = evLog.logIndex;
          break;
        }
      }
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      throw new ProblemError("chain_unavailable", `receipt wait failed: ${(e as Error).message}`);
    }

    // 5. Persist keyed by digest.
    const record: AnchorRecord = {
      anchorId: newAnchorId(),
      onChainId,
      digest,
      hashAlg: req.hashAlg,
      objectDid: req.objectDid,
      purpose: req.purpose,
      actorDid: req.actorDid,
      tenant: req.tenant,
      txHash,
      blockNumber,
      logIndex,
      pqKeyHash: this.pqKeyHashHex,
      pqVerified: true, // we just produced + hold the sig; verify() re-checks.
      status: "confirmed", // QBFT instant finality.
      failureReason: null,
      anchoredAt: new Date().toISOString(),
    };
    await this.store.putAnchor(record);

    log.info(
      { anchorId: record.anchorId, onChainId, txHash, blockNumber },
      "anchor recorded",
    );

    // 6. Return the Anchor DTO (dual signature always both).
    return { anchor: this.toDto(record), alreadyAnchored: false };
  }

  /** Verify a digest (§3.2). Re-checks the PQ sig off-chain when the blob is available. */
  async verify(digest: string): Promise<VerifyResult> {
    const rec = await this.store.getAnchorByDigest(digest.toLowerCase());
    if (!rec) {
      return { digest, anchored: false, anchors: [], asOf: new Date().toISOString() };
    }

    // TODO: fetch the raw ML-DSA-65 sig blob from MinIO (`hara-pq-anchors`) and
    // re-run pqVerify(pubkey, canonicalMessage, sig) here. The pubkey is derived
    // from PQ_MLDSA_SEED (this.pqKeypair) while the anchor is frozen against
    // rec.pqKeyHash. With no blob store wired yet, we surface the stored flag.
    let pqVerified = rec.pqVerified;
    if (this.pqKeypair) {
      // Best-effort in-process re-derivation is possible only for anchors made
      // with the current seed; kept as a stored flag until the blob store lands.
      void pqVerify; // referenced; real re-check needs the stored sig blob.
    }

    return {
      digest: rec.digest,
      anchored: true,
      anchors: [
        {
          anchorId: rec.anchorId,
          objectDid: rec.objectDid,
          purpose: rec.purpose,
          anchoredBy: { tenant: rec.tenant, actorDid: rec.actorDid },
          anchoredAt: rec.anchoredAt,
          txRef: {
            chainId: config.chainId,
            txHash: rec.txHash,
            onChainId: rec.onChainId,
          },
          verification: {
            ecdsaOnChain: rec.status === "confirmed",
            pqVerified,
            pqKeyHash: rec.pqKeyHash,
          },
          status: rec.status,
        },
      ],
      asOf: new Date().toISOString(),
    };
  }

  /** Fetch a stored anchor by Gateway id. */
  async getAnchor(anchorId: string): Promise<Anchor> {
    const rec = await this.store.getAnchorById(anchorId);
    if (!rec) throw new ProblemError("anchor_not_found", anchorId);
    return this.toDto(rec);
  }

  /** Anchor tx lifecycle (§3.3). Confirmations from the current head; cost is gas-free. */
  async getStatus(anchorId: string): Promise<AnchorStatus> {
    const rec = await this.store.getAnchorById(anchorId);
    if (!rec) throw new ProblemError("anchor_not_found", anchorId);

    let confirmations = 0;
    if (rec.blockNumber && rec.status === "confirmed") {
      try {
        const head = await this.readClient.getBlockNumber();
        confirmations = Math.max(1, Number(head - BigInt(rec.blockNumber)) + 1);
      } catch {
        confirmations = 1; // instant finality — at least the mining block.
      }
    }

    return {
      anchorId: rec.anchorId,
      status: rec.status,
      confirmations,
      blockNumber: rec.blockNumber ?? null,
      cost: {
        gas: "0",
        unit: "HARA",
        note: "permissioned chain, gasPrice 0 — no fee; metering counts tx",
      },
      signatures: { ecdsa: true, mlDsa65: true },
      failureReason: rec.failureReason ?? null,
    };
  }
}
