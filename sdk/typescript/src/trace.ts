import { ENDPOINTS } from "./config.js";
import type {
  BatchListResponse,
  BatchSummary,
  Graph,
  HolderBatches,
  HopsResponse,
} from "./types.js";

export interface TraceClientOptions {
  /** Base URL; defaults to the public trace endpoint. */
  baseUrl?: string;
  /** HTTP Basic auth username (trace.ledger.haratrust.io is gated). */
  user?: string;
  /** HTTP Basic auth password. */
  pass?: string;
  /** Custom fetch (e.g. for testing / Node < 18). Defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Thrown when the Traceability REST API returns a non-2xx response. */
export class TraceApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Trace API ${status} on ${path}: ${body}`);
    this.name = "TraceApiError";
  }
}

/**
 * REST client for the Hara Registry Traceability API (/v1/*).
 * The public host is gated behind HTTP Basic auth — pass user/pass.
 */
export class TraceClient {
  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TraceClientOptions = {}) {
    // Normalise to no trailing slash; we build "/v1/..." paths.
    this.baseUrl = (opts.baseUrl ?? ENDPOINTS.trace).replace(/\/+$/, "");

    if (opts.user !== undefined || opts.pass !== undefined) {
      const token = base64(`${opts.user ?? ""}:${opts.pass ?? ""}`);
      this.authHeader = `Basic ${token}`;
    }

    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error(
        "No global fetch available — pass `fetch` in TraceClientOptions (Node < 18).",
      );
    }
    this.fetchImpl = f;
  }

  private async get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const res = await this.fetchImpl(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TraceApiError(res.status, path, body);
    }
    return (await res.json()) as T;
  }

  /** List batches, newest first. */
  async listBatches(params: { limit?: number; offset?: number } = {}): Promise<BatchSummary[]> {
    const query = { limit: params.limit ?? 50, offset: params.offset ?? 0 };
    const data = await this.get<BatchListResponse>("/v1/batches", query);
    return data.items;
  }

  /** A single batch summary. Throws TraceApiError(404) if not found. */
  async getBatch(batchId: string | bigint): Promise<BatchSummary> {
    return this.get<BatchSummary>(`/v1/batches/${batchId}`);
  }

  /** Custody hops for a batch, in custody order (block, then log index). */
  async getHops(batchId: string | bigint): Promise<HopsResponse["hops"]> {
    const data = await this.get<HopsResponse>(`/v1/batches/${batchId}/hops`);
    return data.hops;
  }

  /**
   * Custody graph for a batch (Cytoscape / React-Flow ready).
   * `aggregate: true` collapses parallel A→B transfers into one weighted edge.
   */
  async getGraph(batchId: string | bigint, opts: { aggregate?: boolean } = {}): Promise<Graph> {
    return this.get<Graph>(`/v1/batches/${batchId}/graph`, {
      aggregate: opts.aggregate ?? false,
    });
  }

  /** Batch ids currently held by an address. Matched case-sensitively (checksummed). */
  async holderBatches(address: string): Promise<HolderBatches> {
    return this.get<HolderBatches>(`/v1/holders/${address}/batches`);
  }
}

/** base64 that works in Node and browsers without `Buffer` typing issues. */
function base64(input: string): string {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(input);
  }
  // Node fallback.
  return Buffer.from(input, "utf-8").toString("base64");
}
