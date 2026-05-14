// Traceability REST endpoints — exposed by the indexer service.
// Mounted onto the existing Fastify app in src/index.ts (server already runs on :9100).
//
// Endpoints:
//   GET /v1/batches                        — paginated list with summary
//   GET /v1/batches/:batchId               — single batch summary
//   GET /v1/batches/:batchId/hops          — every TransferSingle in custody order
//   GET /v1/batches/:batchId/graph         — { nodes[], edges[] } for graph rendering
//   GET /v1/holders/:address/batches       — every batch this address has ever touched

import type { FastifyInstance } from "fastify";
import type { DbPool } from "@hara/shared";

export function registerTraceRoutes(app: FastifyInstance, db: DbPool) {
  // List batches with summary
  app.get("/v1/batches", async (req) => {
    const { limit = 50, offset = 0 } = req.query as { limit?: number; offset?: number };
    const { rows } = await db.query(
      `SELECT batch_id, initial_liters, first_owner, current_holder, hop_count,
              rspo_hash, plantation_id, production_date, minted_at, last_hop_at
         FROM batch_summary
        ORDER BY minted_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return { items: rows };
  });

  // Single batch
  app.get("/v1/batches/:batchId", async (req, reply) => {
    const { batchId } = req.params as { batchId: string };
    const { rows } = await db.query("SELECT * FROM batch_summary WHERE batch_id = $1", [batchId]);
    if (rows.length === 0) return reply.code(404).send({ error: "batch not found" });
    return rows[0];
  });

  // Every hop, ordered chronologically
  app.get("/v1/batches/:batchId/hops", async (req) => {
    const { batchId } = req.params as { batchId: string };
    const { rows } = await db.query(
      `SELECT batch_id, liters, from_addr, to_addr, operator_addr,
              tx_hash, block_number, log_index, occurred_at
         FROM custody_hops
        WHERE batch_id = $1
        ORDER BY block_number, log_index`,
      [batchId],
    );
    return { hops: rows };
  });

  // Graph view — { nodes, edges } ready for Cytoscape/React Flow.
  //   ?aggregate=true → consolidate parallel A→B transfers into a single weighted edge
  //                     with sum-of-liters and count-of-transfers (best for DAG visualisations)
  //   otherwise       → one edge per TransferSingle event (best for linear traceability)
  app.get("/v1/batches/:batchId/graph", async (req) => {
    const { batchId } = req.params as { batchId: string };
    const aggregate = (req.query as { aggregate?: string }).aggregate === "true";
    const { rows: summary } = await db.query("SELECT * FROM batch_summary WHERE batch_id = $1", [batchId]);
    const { rows: hops } = await db.query(
      `SELECT liters, from_addr, to_addr, operator_addr, tx_hash, block_number, log_index, occurred_at
         FROM custody_hops WHERE batch_id = $1 ORDER BY block_number, log_index`,
      [batchId],
    );

    // Build unique node set from edges
    const nodeMap = new Map<string, { id: string; firstSeenAt: Date; lastSeenAt: Date; receivedL: bigint; sentL: bigint }>();
    const ensure = (addr: string, ts: Date) => {
      const existing = nodeMap.get(addr);
      if (existing) {
        existing.lastSeenAt = ts;
      } else {
        nodeMap.set(addr, { id: addr, firstSeenAt: ts, lastSeenAt: ts, receivedL: 0n, sentL: 0n });
      }
      return nodeMap.get(addr)!;
    };
    for (const h of hops) {
      ensure(h.from_addr, h.occurred_at).sentL += BigInt(h.liters);
      ensure(h.to_addr, h.occurred_at).receivedL += BigInt(h.liters);
    }

    const nodes = Array.from(nodeMap.values()).map((n, i) => {
      const cur = n.receivedL - n.sentL;
      return {
        id: n.id,
        label: `${n.id.slice(0, 6)}…${n.id.slice(-4)}`,
        hopIndex: i,
        firstSeenAt: n.firstSeenAt,
        lastSeenAt: n.lastSeenAt,
        receivedLiters: Number(n.receivedL),
        sentLiters: Number(n.sentL),
        currentLiters: Number(cur),
        // Origin = the wallet that first received the minted volume (no inbound transfers)
        isFirstOwner: summary[0]?.first_owner?.toLowerCase() === n.id.toLowerCase(),
        // Final holder = node with positive balance that never forwarded it onward
        // (in a DAG there can be many such terminal nodes — e.g. 10 output batches)
        isCurrentHolder: cur > 0n && n.sentL === 0n,
        // Pure pass-through tank (everything in flowed out)
        isPassThrough: n.sentL > 0n && cur === 0n,
      };
    });

    let edges: any[];
    if (aggregate) {
      // Group parallel edges by (from, to)
      const agg = new Map<string, { from: string; to: string; totalLiters: bigint; txCount: number; firstAt: Date; lastAt: Date; sampleTxHash: string }>();
      for (const h of hops) {
        const key = `${h.from_addr}->${h.to_addr}`;
        const existing = agg.get(key);
        if (existing) {
          existing.totalLiters += BigInt(h.liters);
          existing.txCount += 1;
          if (h.occurred_at > existing.lastAt) existing.lastAt = h.occurred_at;
        } else {
          agg.set(key, {
            from: h.from_addr, to: h.to_addr,
            totalLiters: BigInt(h.liters), txCount: 1,
            firstAt: h.occurred_at, lastAt: h.occurred_at,
            sampleTxHash: h.tx_hash,
          });
        }
      }
      edges = Array.from(agg.values()).map((e, i) => ({
        id: `agg-${i}`,
        source: e.from,
        target: e.to,
        label: e.txCount > 1 ? `${e.totalLiters} L (×${e.txCount})` : `${e.totalLiters} L`,
        liters: Number(e.totalLiters),
        txCount: e.txCount,
        firstAt: e.firstAt,
        lastAt: e.lastAt,
        sampleTxHash: e.sampleTxHash,
      }));
    } else {
      edges = hops.map((h: any, i: number) => ({
        id: `${h.tx_hash}-${h.log_index}`,
        source: h.from_addr,
        target: h.to_addr,
        label: `${h.liters} L`,
        liters: Number(h.liters),
        operator: h.operator_addr,
        txHash: h.tx_hash,
        blockNumber: Number(h.block_number),
        occurredAt: h.occurred_at,
        hopOrder: i,
      }));
    }

    return { batch: summary[0] ?? null, nodes, edges, aggregated: aggregate };
  });

  // Cross-batch view per holder
  app.get("/v1/holders/:address/batches", async (req) => {
    const { address } = req.params as { address: string };
    const addr = address.toLowerCase();
    const { rows } = await db.query(
      `SELECT DISTINCT batch_id
         FROM custody_hops
        WHERE from_addr = $1 OR to_addr = $1
        ORDER BY batch_id DESC
        LIMIT 100`,
      [addr],
    );
    return { address: addr, batches: rows.map((r) => r.batch_id) };
  });
}
