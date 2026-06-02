// Time-series + anomaly endpoints, backed by Prometheus (reached on the mesh).
// Only an ALLOWLISTED set of named series is queryable — no arbitrary PromQL is
// exposed through the console.
import { config } from "./config.js";
import { fetchT } from "./rpc.js";
import { getBackups, getValidators } from "./sources.js";

export interface SeriesDef {
  promql: string;
  unit: string;
  label: string;
}

// Grounded in metrics Prometheus actually scrapes today (indexer + Blockscout).
export const SERIES: Record<string, SeriesDef> = {
  chainHeight: { promql: "hara_indexer_chain_head_block", unit: "block", label: "Chain height" },
  blockRate: { promql: "rate(hara_indexer_chain_head_block[2m])", unit: "blk/s", label: "Block rate" },
  indexerLag: { promql: "hara_indexer_lag_blocks", unit: "blocks", label: "Indexer lag" },
  eventRate: { promql: "rate(hara_indexer_events_indexed_total[2m])", unit: "ev/s", label: "Event throughput" },
  batchMs: { promql: "hara_indexer_batch_duration_ms", unit: "ms", label: "Indexer batch duration" },
  errorRate: { promql: "rate(hara_indexer_errors_total[5m])", unit: "err/s", label: "Indexer error rate" },
  indexerMem: { promql: "hara_indexer_process_resident_memory_bytes", unit: "bytes", label: "Indexer memory" },
  eventloopP90: { promql: "hara_indexer_nodejs_eventloop_lag_p90_seconds", unit: "s", label: "Event-loop lag p90" },
  alertsFiring: { promql: 'count(ALERTS{alertstate="firing"})', unit: "count", label: "Firing alerts" },
  // Besu (validators) — via the wg0:9545 metrics proxies
  validatorPeers: { promql: 'avg(ethereum_peer_count{role="validator"})', unit: "peers", label: "Validator peers (avg)" },
  validatorHeight: { promql: 'max(ethereum_blockchain_height{role="validator"})', unit: "block", label: "Validator chain height" },
  validatorInSync: { promql: 'min(besu_synchronizer_in_sync{role="validator"})', unit: "1=synced", label: "Validators in-sync (min)" },
  txpool: { promql: "max(besu_transaction_pool_number_of_transactions)", unit: "txs", label: "Tx-pool size" },
  // RPC tier — HAProxy + rpc-node besu metrics
  rpcReqRate: { promql: "sum(rate(haproxy_backend_http_requests_total[2m]))", unit: "req/s", label: "RPC request rate" },
  rpcSessions: { promql: "sum(haproxy_backend_current_sessions)", unit: "sessions", label: "RPC active sessions" },
  rpc5xx: { promql: 'sum(rate(haproxy_backend_http_responses_total{code="5xx"}[5m]))', unit: "5xx/s", label: "RPC 5xx rate" },
  rpcPeers: { promql: 'avg(ethereum_peer_count{role="rpc"})', unit: "peers", label: "RPC node peers (avg)" },
};

export interface RangePoint {
  t: number; // unix seconds
  v: number;
}

export async function getRange(name: string, minutes: number, nowMs: number): Promise<{ name: string; unit: string; label: string; points: RangePoint[] }> {
  const def = SERIES[name];
  if (!def) throw new Error(`unknown series '${name}'`);
  const end = Math.floor(nowMs / 1000);
  const start = end - Math.max(5, Math.min(1440, minutes)) * 60;
  const step = Math.max(15, Math.round((end - start) / 200)); // ~<=200 points
  const url =
    `${config.prometheusUrl}/api/v1/query_range?query=${encodeURIComponent(def.promql)}` +
    `&start=${start}&end=${end}&step=${step}`;
  const res = await fetchT(url);
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { result?: Array<{ values?: [number, string][] }> } };
  const values = j.data?.result?.[0]?.values ?? [];
  return {
    name,
    unit: def.unit,
    label: def.label,
    points: values.map(([t, v]) => ({ t, v: Number(v) })),
  };
}

async function prom(expr: string, nowMs: number): Promise<number | null> {
  void nowMs;
  try {
    const res = await fetchT(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { result?: Array<{ value?: [number, string] }> } };
    const v = j.data?.result?.[0]?.value?.[1];
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

export interface Anomaly {
  area: string;
  level: "info" | "warn" | "critical";
  message: string;
}

// Threshold-based anomalies (P1 of the anomaly roadmap). Mirrors the existing
// Prometheus alert rules; statistical/ML baselining is a later phase.
export async function getAnomalies(nowMs: number): Promise<Anomaly[]> {
  const out: Anomaly[] = [];
  const [lag, blockRate, errRate, firing] = await Promise.all([
    prom("hara_indexer_lag_blocks", nowMs),
    prom("rate(hara_indexer_chain_head_block[2m])", nowMs),
    prom("rate(hara_indexer_errors_total[5m])", nowMs),
    prom('count(ALERTS{alertstate="firing"})', nowMs),
  ]);

  if (blockRate != null && blockRate < 0.05) out.push({ area: "chain", level: "critical", message: "Chain not advancing (block rate ≈ 0) — possible stall." });
  if (lag != null && lag > 100) out.push({ area: "services", level: "critical", message: `Indexer lag ${lag} blocks (>100).` });
  else if (lag != null && lag > 25) out.push({ area: "services", level: "warn", message: `Indexer lag ${lag} blocks (>25).` });
  if (errRate != null && errRate > 0) out.push({ area: "services", level: "warn", message: "Indexer is logging errors." });
  if (firing != null && firing > 0) out.push({ area: "alerts", level: "info", message: `${firing} alert(s) firing in Alertmanager.` });

  // Backups: any failed (non-success) timer across hosts.
  try {
    const b = await getBackups();
    for (const h of b.hosts) {
      for (const t of h.timers) {
        if (t.lastRun && t.result && t.result !== "success") {
          out.push({ area: "backups", level: "warn", message: `${t.unit} on ${h.host} last result: ${t.result}.` });
        }
      }
    }
  } catch {
    /* agents unreachable — skip */
  }

  // Validators: any not recently proposing.
  try {
    const v = await getValidators();
    const stale = v.validators.filter((x) => !x.recentlyProposed);
    if (stale.length) out.push({ area: "validators", level: stale.length >= 2 ? "critical" : "warn", message: `${stale.length} validator(s) not recently proposing.` });
  } catch {
    /* skip */
  }

  return out;
}
