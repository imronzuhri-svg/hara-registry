// Read-only Console API config. Defaults target the production split topology
// (WireGuard mesh) so it "just works" when deployed on hara-stateless-2.
// In local dev, the RPC default is the public gateway (reachable); the internal
// sources (Prometheus/HAProxy/Vault/Alertmanager) are unreachable and the API
// reports them as `available:false` rather than erroring the whole overview.

const env = process.env;

export interface WatchAccount {
  label: string;
  address: string;
}

export const config = {
  port: Number(env.PORT ?? 8910),
  // CORS origin for the Vite dev server; "*" acceptable for a read-only,
  // network-gated internal tool, but default to the dev origin.
  corsOrigin: env.CONSOLE_CORS_ORIGIN ?? "http://localhost:5273",

  // Besu RPC (read). Public gateway by default — reachable in dev.
  rpcUrl: env.RPC_URL ?? "https://rpc.ledger.haratrust.io/read/",

  // Internal sources (mesh IPs) — reachable only when deployed on the mesh.
  prometheusUrl: env.PROMETHEUS_URL ?? "http://10.43.0.25:9090",
  alertmanagerUrl: env.ALERTMANAGER_URL ?? "http://10.43.0.25:9093",
  vaultAddr: env.VAULT_ADDR ?? "http://10.43.0.40:8200",
  haproxyStatsUrl: env.HAPROXY_STATS_URL ?? "http://10.43.0.21:8404/stats;csv",
  indexerMetricsUrl: env.INDEXER_METRICS_URL ?? "http://10.43.0.25:9100/metrics",
  // Read-only backups-status agents (one per host running snapshot timers —
  // backups span hara-stateful + validators). Comma-separated. Empty => backups
  // section reports unavailable.
  backupsAgentUrls: (env.BACKUPS_AGENT_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // per-upstream fetch timeout (ms) — fail fast so unreachable internal
  // sources don't stall the overview.
  fetchTimeoutMs: Number(env.CONSOLE_FETCH_TIMEOUT_MS ?? 4000),

  // Watchlist for the zero-balance guard. All public addresses.
  watchAccounts: parseWatch(env.WATCH_ACCOUNTS) ?? [
    { label: "platform admin", address: "0x944b237097A03E1e8CdE8A0F46605506319EC329" },
    { label: "loadtest-deployer", address: "0xc9064736be2715060e79472795d759907b408bf5" },
    { label: "hara-xchange", address: "0xFB146120F459E041a9d450300cd34661a6aEAF4e" },
    { label: "anvil-1 funder", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  ],
};

function parseWatch(raw: string | undefined): WatchAccount[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WatchAccount[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
