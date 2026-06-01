function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

export const config = {
  // Chain
  rpcReadUrl: process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read",
  rpcWriteUrl: process.env.RPC_WRITE_URL ?? "http://lb:8545/rpc/write",
  chainId: Number(process.env.CHAIN_ID ?? 131216),
  pqAnchorAddress: requireEnv("PQ_ANCHOR_REGISTRY_ADDRESS") as `0x${string}`,

  // Cadence
  // 10 min default matches audit-security-quantum-performance.md §"P1 anchoring frequency".
  intervalMs: Number(process.env.ANCHOR_INTERVAL_MS ?? 600_000),
  // Don't anchor a slice smaller than this — would emit lots of empty
  // commitments at low traffic.
  minEvents: Number(process.env.ANCHOR_MIN_EVENTS ?? 1),
  // Cap a slice so we never compute a Merkle root over more events than
  // memory comfortably holds at peak.
  maxEvents: Number(process.env.ANCHOR_MAX_EVENTS ?? 200_000),

  // Storage
  databaseUrl: requireEnv("DATABASE_URL"),
  // Algorithm label committed alongside the anchor. Matches FIPS 204.
  algorithm: process.env.PQ_ALGORITHM ?? "ML-DSA-65",
  // Anchor-chain tag — keccak256("hara-registry") for self-anchoring; replace
  // when adding IOTA / Ethereum L1 anchor confirmation.
  anchorChainTag:
    (process.env.ANCHOR_CHAIN_TAG as `0x${string}`) ??
    ("0x" + "00".repeat(32)) as `0x${string}`,

  // MinIO
  minio: {
    endPoint: (process.env.MINIO_ENDPOINT ?? "hara-minio:9000").split(":")[0],
    port: Number((process.env.MINIO_ENDPOINT ?? "hara-minio:9000").split(":")[1] ?? 9000),
    useSSL: /^(1|true|yes)$/i.test(process.env.MINIO_USE_SSL ?? ""),
    accessKey: requireEnv("MINIO_ACCESS_KEY"),
    secretKey: requireEnv("MINIO_SECRET_KEY"),
    bucket: process.env.PQ_BUCKET ?? "hara-pq-anchors",
  },

  // Observability
  metricsPort: Number(process.env.METRICS_PORT ?? 9102),
};
