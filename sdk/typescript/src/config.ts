import { defineChain } from "viem";
import type { Address } from "viem";

/**
 * Hara Registry — canonical chain & deployment constants.
 *
 * Single source of truth: doc/api/hara-registry-facts.md (verified 2026-06-08).
 * Do not edit values here without updating the facts file first.
 */

/** Chain identity (INVARIANT — never changes). */
export const CHAIN_ID = 131216 as const;

/** Gas is free on this chain (`zeroBaseFee` genesis). Always send legacy txs with gasPrice 0. */
export const GAS_PRICE = 0n;

/** Native token symbol (used only for gas accounting; gas is free). */
export const NATIVE_SYMBOL = "HARA" as const;

/**
 * Public endpoints. The trailing slash on /read/ and /write/ matters —
 * `…/read` (no slash) returns 404. Reads go to /read/ (cached), writes to /write/.
 */
export const ENDPOINTS = {
  /** JSON-RPC reads (rpc-cache + LB). */
  read: "https://rpc.ledger.haratrust.io/read/",
  /** JSON-RPC writes (eth_sendRawTransaction). */
  write: "https://rpc.ledger.haratrust.io/write/",
  /** JSON-RPC WebSocket (subscriptions / live reads). */
  ws: "wss://rpc.ledger.haratrust.io/ws",
  /** Blockscout explorer + /api/v2/*. */
  explorer: "https://explorer.ledger.haratrust.io/",
  /** Traceability REST API (/v1/*) + DAG viewer. HTTP Basic auth. */
  trace: "https://trace.ledger.haratrust.io/",
} as const;

/** `trace` RPC namespace base (debug/trace methods route through the read LB). */
export const TRACE_RPC_URL = ENDPOINTS.read;

/**
 * Deployed contract addresses on chain 131216.
 * See doc/api/hara-registry-facts.md §3.
 */
export const ADDRESSES = {
  HaraPalmOil: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  TraceabilityBatchRelay: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  PQAnchorRegistry: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  ContractRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  GovernanceContract: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  /** Legacy ECDSA-only anchoring (compat). Prefer PQAnchorRegistry. */
  AnchorRegistry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
} as const satisfies Record<string, Address>;

export type ContractName = keyof typeof ADDRESSES;

/**
 * viem chain object for Hara Registry.
 *
 * Note: this chain is QBFT/Besu with a free gas market (zeroBaseFee) and only
 * accepts **legacy (type 0)** transactions. EIP-1559 (type 2) fields are rejected,
 * so always build txs with `type: "legacy", gasPrice: 0n`.
 */
export const haraChain = defineChain({
  id: CHAIN_ID,
  name: "Hara Registry",
  nativeCurrency: {
    name: "HARA",
    symbol: NATIVE_SYMBOL,
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ENDPOINTS.read],
      webSocket: [ENDPOINTS.ws],
    },
    write: {
      http: [ENDPOINTS.write],
    },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: ENDPOINTS.explorer,
      apiUrl: "https://explorer.ledger.haratrust.io/api/v2",
    },
  },
  testnet: false,
});
