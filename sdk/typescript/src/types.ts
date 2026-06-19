import type { Address, Hex } from "viem";

/**
 * Traceability REST API schemas (trace.ledger.haratrust.io /v1/*).
 * All litre amounts are returned as decimal strings (uint256-safe).
 * Mirrors doc/api/hara-registry-facts.md §4.
 */

export interface BatchSummary {
  /** ERC-1155 token id, decimal string. */
  batch_id: string;
  /** Litres minted at origin, decimal string. */
  initial_liters: string;
  /** Plantation / origin address. */
  first_owner: Address;
  /** Current custodian address. */
  current_holder: Address;
  /** Number of custody hops, decimal string. */
  hop_count: string;
  rspo_hash: Hex;
  plantation_id: Hex;
  /** ISO-8601 UTC (or the raw production-date encoding). */
  production_date: string;
  /** ISO-8601 UTC. */
  minted_at: string;
  /** ISO-8601 UTC; null/absent if no hops yet. */
  last_hop_at: string | null;
}

export interface Hop {
  batch_id: string;
  /** Litres moved in this hop, decimal string. */
  liters: string;
  from_addr: Address;
  to_addr: Address;
  /** The relay/operator that executed the transfer. */
  operator_addr: Address;
  tx_hash: Hex;
  /** Block number, decimal string. */
  block_number: string;
  log_index: number;
  /** ISO-8601 UTC. */
  occurred_at: string;
}

export interface GraphNode {
  /** Address (node id). */
  id: Address;
  label: string;
  hopIndex: number;
  receivedLiters: string;
  sentLiters: string;
  currentLiters: string;
  isFirstOwner: boolean;
  isCurrentHolder: boolean;
  isPassThrough: boolean;
}

export interface GraphEdge {
  id: string;
  source: Address;
  target: Address;
  label: string;
  liters: string;
  txCount: number;
  firstAt: string;
  lastAt: string;
  sampleTxHash: Hex;
}

export interface Graph {
  batch: BatchSummary;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when parallel A→B transfers were collapsed (`?aggregate=true`). */
  aggregated: boolean;
}

export interface HolderBatches {
  address: Address;
  /** Batch ids (decimal strings) the address currently holds. */
  batches: string[];
}

/** Envelope shapes the REST API returns. */
export interface BatchListResponse {
  items: BatchSummary[];
}

export interface HopsResponse {
  hops: Hop[];
}
