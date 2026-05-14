import { collectDefaultMetrics, Gauge, Counter, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "hara_indexer_" });

export const lastIndexedBlock = new Gauge({
  name: "hara_indexer_last_indexed_block",
  help: "Highest block number successfully indexed",
  registers: [registry],
});

export const chainHeadBlock = new Gauge({
  name: "hara_indexer_chain_head_block",
  help: "Latest block on the chain (from /rpc/read)",
  registers: [registry],
});

export const indexLagBlocks = new Gauge({
  name: "hara_indexer_lag_blocks",
  help: "chain head - last indexed block",
  registers: [registry],
});

export const eventsIndexedTotal = new Counter({
  name: "hara_indexer_events_indexed_total",
  help: "Number of events successfully decoded and stored",
  labelNames: ["contract", "event"],
  registers: [registry],
});

export const eventsRawTotal = new Counter({
  name: "hara_indexer_events_raw_total",
  help: "Number of raw logs seen (decoded or not)",
  labelNames: ["contract"],
  registers: [registry],
});

export const indexerErrorsTotal = new Counter({
  name: "hara_indexer_errors_total",
  help: "Errors during indexing loop",
  labelNames: ["stage"],
  registers: [registry],
});

export const batchDurationMs = new Gauge({
  name: "hara_indexer_batch_duration_ms",
  help: "Time taken to index a block range batch",
  registers: [registry],
});
