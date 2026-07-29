/**
 * Store interface + factory.
 *
 * The store holds what the chain CANNOT: the digest↔anchorId link, objectDid,
 * purpose, tenant, tx metadata, the idempotency-key cache, and DID↔Authentik
 * bindings. Keyed by digest for natural idempotency.
 */

import { config } from "../config.js";
import type { Binding } from "../types.js";

/** The Gateway's internal record for one anchored digest. */
export interface AnchorRecord {
  anchorId: string;
  onChainId?: string;
  digest: string;
  hashAlg: string;
  objectDid: string;
  purpose: string;
  actorDid?: string;
  tenant: string;
  txHash?: string;
  blockNumber?: number;
  logIndex?: number;
  pqKeyHash: string;
  /** Off-chain ML-DSA-65 verification flag (see anchor-service.verify). */
  pqVerified: boolean;
  status: "pending" | "confirmed" | "failed";
  failureReason?: string | null;
  anchoredAt: string;
}

/** A cached idempotent response keyed by Idempotency-Key. */
export interface IdempotencyEntry {
  /** Hash of the request body — a differing body with the same key => 409. */
  bodyHash: string;
  /** The anchorId that request produced (response is rebuilt from the store). */
  anchorId: string;
  storedAt: number;
}

export interface Store {
  // Anchors
  getAnchorByDigest(digest: string): Promise<AnchorRecord | undefined>;
  getAnchorById(anchorId: string): Promise<AnchorRecord | undefined>;
  putAnchor(record: AnchorRecord): Promise<void>;

  // Idempotency-Key cache (24h TTL semantics; see §2)
  getIdempotency(key: string): Promise<IdempotencyEntry | undefined>;
  putIdempotency(entry: IdempotencyEntry & { key: string }): Promise<void>;

  // DID ↔ Authentik bindings (§4.3)
  getBindingBySubject(authentikSub: string): Promise<Binding | undefined>;
  putBinding(binding: Required<Pick<Binding, "authentikSub" | "did" | "tenant">> & Binding): Promise<Binding>;

  close(): Promise<void>;
}

/**
 * Build the store from config: empty PG_URL => in-memory (DEFAULT, works out of
 * the box); otherwise the pg-backed store.
 */
export async function createStore(): Promise<Store> {
  if (config.pgUrl) {
    const { PostgresStore } = await import("./postgres.js");
    return PostgresStore.create(config.pgUrl);
  }
  const { MemoryStore } = await import("./memory.js");
  return new MemoryStore();
}
