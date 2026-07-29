/**
 * In-memory store — the DEFAULT (used when PG_URL is unset). Works out of the
 * box for dev; non-persistent, single-process only.
 *
 * REAL implementation of the Store interface (just not durable).
 */

import type { AnchorRecord, IdempotencyEntry, Store } from "./index.js";
import type { Binding } from "../types.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h per §2

export class MemoryStore implements Store {
  private byDigest = new Map<string, AnchorRecord>();
  private byId = new Map<string, AnchorRecord>();
  private idem = new Map<string, IdempotencyEntry>();
  private bindingsBySub = new Map<string, Binding>();

  async getAnchorByDigest(digest: string): Promise<AnchorRecord | undefined> {
    return this.byDigest.get(digest.toLowerCase());
  }

  async getAnchorById(anchorId: string): Promise<AnchorRecord | undefined> {
    return this.byId.get(anchorId);
  }

  async putAnchor(record: AnchorRecord): Promise<void> {
    this.byDigest.set(record.digest.toLowerCase(), record);
    this.byId.set(record.anchorId, record);
  }

  async getIdempotency(key: string): Promise<IdempotencyEntry | undefined> {
    const e = this.idem.get(key);
    if (!e) return undefined;
    if (Date.now() - e.storedAt > IDEMPOTENCY_TTL_MS) {
      this.idem.delete(key);
      return undefined;
    }
    return e;
  }

  async putIdempotency(entry: IdempotencyEntry & { key: string }): Promise<void> {
    const { key, ...rest } = entry;
    this.idem.set(key, rest);
  }

  async getBindingBySubject(authentikSub: string): Promise<Binding | undefined> {
    return this.bindingsBySub.get(authentikSub);
  }

  async putBinding(
    binding: Required<Pick<Binding, "authentikSub" | "did" | "tenant">> & Binding,
  ): Promise<Binding> {
    const stored: Binding = {
      authentikSub: binding.authentikSub,
      did: binding.did,
      tenant: binding.tenant,
      boundAt: binding.boundAt ?? new Date().toISOString(),
    };
    this.bindingsBySub.set(binding.authentikSub, stored);
    return stored;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
