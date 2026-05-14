export const config = {
  rpcReadUrl: process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read",
  metricsPort: Number(process.env.METRICS_PORT ?? 9100),

  // Indexing tuning
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 2000),
  batchSize: Number(process.env.BATCH_SIZE ?? 200), // blocks per eth_getLogs call
  confirmations: Number(process.env.CONFIRMATIONS ?? 1), // QBFT has instant finality; 1 = paranoid buffer
  errorBackoffMs: Number(process.env.ERROR_BACKOFF_MS ?? 5000),
};
