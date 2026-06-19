import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";

import { HaraChainClient } from "./chain.js";
import { ADDRESSES } from "./config.js";

/* -------------------------------------------------------------------------- */
/* Inline ABIs (only the functions the SDK uses)                              */
/* -------------------------------------------------------------------------- */

export const haraPalmOilAbi = parseAbi([
  // ERC-1155 standard
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  // Custom mint (MINTER_ROLE gated)
  "function mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)",
]);

export const traceabilityBatchRelayAbi = parseAbi([
  "function executeChain(address token, uint256 batchId, uint256 amount, address[] holders)",
  "function executeChainVariable(address token, uint256 batchId, address[] holders, uint256[] amounts)",
  "function executeHops(address token, uint256 batchId, address[] froms, address[] tos, uint256[] amounts)",
]);

export const contractRegistryAbi = parseAbi([
  "function getActive(bytes32 name) view returns (address)",
  "function register(bytes32 name, uint64 version, address addr)",
  "function setActiveVersion(bytes32 name, uint64 version)",
  "function deactivate(bytes32 name, uint64 version)",
]);

export const pqAnchorRegistryAbi = parseAbi([
  "function recordAnchor(bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain, bytes32 pqSignatureHash) returns (uint256)",
  "function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)",
  "function currentPQKeyHash() view returns (bytes32)",
  "function currentPQAlgorithm() view returns (string)",
]);

/**
 * Encode a logical contract name to its on-chain `bytes32` key.
 * ContractRegistry keys names as **keccak256(utf8(name))** — NOT format-bytes32-string.
 * e.g. nameToKey("IssuerRegistry") === `cast keccak "IssuerRegistry"`.
 */
export function nameToKey(name: string): Hex {
  return keccak256(toBytes(name));
}

/* -------------------------------------------------------------------------- */
/* HaraPalmOil (ERC-1155)                                                     */
/* -------------------------------------------------------------------------- */

export class HaraPalmOil {
  readonly address: Address;
  constructor(
    private readonly client: HaraChainClient,
    address: Address = ADDRESSES.HaraPalmOil,
  ) {
    this.address = address;
  }

  /** Litres of `batchId` held by `account`. */
  async balanceOf(account: Address, batchId: bigint): Promise<bigint> {
    return this.client.public.readContract({
      address: this.address,
      abi: haraPalmOilAbi,
      functionName: "balanceOf",
      args: [account, batchId],
    });
  }

  /** Whether `operator` is approved to move all of `account`'s tokens. */
  async isApprovedForAll(account: Address, operator: Address): Promise<boolean> {
    return this.client.public.readContract({
      address: this.address,
      abi: haraPalmOilAbi,
      functionName: "isApprovedForAll",
      args: [account, operator],
    });
  }

  /** Approve/revoke `operator` for all of the caller's tokens (one tx). */
  async setApprovalForAll(operator: Address, approved: boolean): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: haraPalmOilAbi,
        functionName: "setApprovalForAll",
        args: [operator, approved],
      }),
    });
  }

  /** Mint a new palm-oil batch (MINTER_ROLE gated). Litres == ERC-1155 amount. */
  async mintBatch(params: {
    batchId: bigint;
    firstOwner: Address;
    liters: bigint;
    rspoCertificateHash: Hex;
    plantationId: Hex;
    productionDate: bigint; // uint64, unix seconds
  }): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: haraPalmOilAbi,
        functionName: "mintBatch",
        args: [
          params.batchId,
          params.firstOwner,
          params.liters,
          params.rspoCertificateHash,
          params.plantationId,
          params.productionDate,
        ],
      }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* TraceabilityBatchRelay                                                     */
/* -------------------------------------------------------------------------- */

export class TraceabilityBatchRelay {
  readonly address: Address;
  constructor(
    private readonly client: HaraChainClient,
    address: Address = ADDRESSES.TraceabilityBatchRelay,
  ) {
    this.address = address;
  }

  /**
   * Move a uniform `amount` down a line of holders in one atomic tx.
   * `holders[0]` is the current owner; the last is the final custodian.
   * Each intermediate holder must setApprovalForAll(relay, true) once beforehand.
   */
  async executeChain(
    token: Address,
    batchId: bigint,
    amount: bigint,
    holders: readonly Address[],
  ): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: traceabilityBatchRelayAbi,
        functionName: "executeChain",
        args: [token, batchId, amount, holders as Address[]],
      }),
    });
  }

  /** Per-leg amounts down a line (`amounts.length === holders.length - 1`). */
  async executeChainVariable(
    token: Address,
    batchId: bigint,
    holders: readonly Address[],
    amounts: readonly bigint[],
  ): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: traceabilityBatchRelayAbi,
        functionName: "executeChainVariable",
        args: [token, batchId, holders as Address[], amounts as bigint[]],
      }),
    });
  }

  /**
   * Arbitrary DAG of hops (splits/merges) in one tx. Hops must be in
   * topological order; mass balance is enforced by ERC-1155 semantics.
   */
  async executeHops(
    token: Address,
    batchId: bigint,
    froms: readonly Address[],
    tos: readonly Address[],
    amounts: readonly bigint[],
  ): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: traceabilityBatchRelayAbi,
        functionName: "executeHops",
        args: [token, batchId, froms as Address[], tos as Address[], amounts as bigint[]],
      }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* ContractRegistry                                                           */
/* -------------------------------------------------------------------------- */

export class ContractRegistry {
  readonly address: Address;
  constructor(
    private readonly client: HaraChainClient,
    address: Address = ADDRESSES.ContractRegistry,
  ) {
    this.address = address;
  }

  /**
   * Active address for a logical contract name. The name is hashed with
   * keccak256(utf8(name)) before the lookup — pass the human-readable string.
   */
  async getActive(name: string): Promise<Address> {
    return this.client.public.readContract({
      address: this.address,
      abi: contractRegistryAbi,
      functionName: "getActive",
      args: [nameToKey(name)],
    });
  }

  /**
   * Register a new version of `name` at `addr`. The first version auto-activates.
   * `version` is a uint64 (bigint) — NOT a bytes32 string. REGISTRAR_ROLE gated.
   */
  async register(name: string, version: bigint, addr: Address): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: contractRegistryAbi,
        functionName: "register",
        args: [nameToKey(name), version, addr],
      }),
    });
  }

  /** Switch the active version for `name`. */
  async setActiveVersion(name: string, version: bigint): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: contractRegistryAbi,
        functionName: "setActiveVersion",
        args: [nameToKey(name), version],
      }),
    });
  }

  /** Mark a registered version inactive (active pointer unchanged). */
  async deactivate(name: string, version: bigint): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: contractRegistryAbi,
        functionName: "deactivate",
        args: [nameToKey(name), version],
      }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* PQAnchorRegistry                                                           */
/* -------------------------------------------------------------------------- */

export interface RecordAnchorParams {
  merkleRoot: Hex;
  sha3Root: Hex;
  blockFrom: bigint; // uint64
  blockTo: bigint; // uint64
  eventCount: bigint; // uint64
  anchorChain: Hex; // bytes32 tag, e.g. external-chain id
  /** keccak256(ML-DSA signature bytes). Must be non-zero — see anchor.ts. */
  pqSignatureHash: Hex;
}

export class PQAnchorRegistry {
  readonly address: Address;
  constructor(
    private readonly client: HaraChainClient,
    address: Address = ADDRESSES.PQAnchorRegistry,
  ) {
    this.address = address;
  }

  /** Record a hybrid ECDSA + ML-DSA-65 audit anchor (ANCHOR_ROLE gated). */
  async recordAnchor(params: RecordAnchorParams): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
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
      }),
    });
  }

  /** Confirm an external-chain anchor tx hash for a previously recorded anchor. */
  async confirmExternalAnchor(anchorId: bigint, anchorTxHash: Hex): Promise<Hex> {
    return this.client.sendLegacyTx({
      to: this.address,
      data: encodeFunctionData({
        abi: pqAnchorRegistryAbi,
        functionName: "confirmExternalAnchor",
        args: [anchorId, anchorTxHash],
      }),
    });
  }

  /** Current active PQ signing key hash. */
  async currentPQKeyHash(): Promise<Hex> {
    return this.client.public.readContract({
      address: this.address,
      abi: pqAnchorRegistryAbi,
      functionName: "currentPQKeyHash",
    });
  }

  /** Current PQ algorithm label, e.g. "ML-DSA-65". */
  async currentPQAlgorithm(): Promise<string> {
    return this.client.public.readContract({
      address: this.address,
      abi: pqAnchorRegistryAbi,
      functionName: "currentPQAlgorithm",
    });
  }
}
