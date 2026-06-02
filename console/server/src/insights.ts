// Intelligence: Phase 1 (reliability) + Phase 2 (optimisation), read-only.
// Everything is computed from Prometheus (range/instant queries) + the existing
// sources. No mutations — this produces signals + plain-language recommendations
// that an operator acts on (via the propose-only Operations layer).
import { config } from "./config.js";
import { fetchT } from "./rpc.js";
import { getBackups, getValidators } from "./sources.js";

async function prom(expr: string): Promise<number | null> {
  try {
    const res = await fetchT(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`);
    if (!res.ok) return null;
    const r = (await res.json()) as { data?: { result?: Array<{ value?: [number, string] }> } };
    const v = r.data?.result?.[0]?.value?.[1];
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

// ── Phase 1.1 — statistical baselining (z-score over a 2h window) ─────────────
export interface Baseline {
  key: string;
  label: string;
  unit: string;
  current: number | null;
  mean: number | null;
  z: number | null;
  status: "normal" | "elevated" | "anomalous";
}

const BASELINE_SERIES: { key: string; label: string; unit: string; metric: string }[] = [
  { key: "indexerLag", label: "Indexer lag", unit: "blocks", metric: "hara_indexer_lag_blocks" },
  { key: "batchMs", label: "Indexer batch duration", unit: "ms", metric: "hara_indexer_batch_duration_ms" },
  { key: "rpcSessions", label: "RPC active sessions", unit: "sessions", metric: "sum(haproxy_backend_current_sessions)" },
  { key: "validatorPeers", label: "Validator peers", unit: "peers", metric: 'avg(ethereum_peer_count{role="validator"})' },
  { key: "txpool", label: "Tx-pool size", unit: "txs", metric: "max(besu_transaction_pool_number_of_transactions)" },
];

async function baseline(s: { key: string; label: string; unit: string; metric: string }): Promise<Baseline> {
  const [current, mean, stdev] = await Promise.all([
    prom(s.metric),
    prom(`avg_over_time((${s.metric})[2h:1m])`),
    prom(`stddev_over_time((${s.metric})[2h:1m])`),
  ]);
  let z: number | null = null;
  let status: Baseline["status"] = "normal";
  if (current != null && mean != null && stdev != null && stdev > 1e-6) {
    z = (current - mean) / stdev;
    const az = Math.abs(z);
    status = az >= 3 ? "anomalous" : az >= 2 ? "elevated" : "normal";
  }
  return { key: s.key, label: s.label, unit: s.unit, current, mean, z, status };
}

// ── Phase 1.2 — forecasts + backup freshness ─────────────────────────────────
export interface Forecast {
  label: string;
  current: number | null;
  predicted1h: number | null;
  threshold: number;
  willBreach: boolean;
}

export interface BackupFreshness {
  unit: string;
  host: string;
  ageHours: number | null;
  result: string | null;
  overdue: boolean; // a daily backup older than ~26h or last result not success
}

// ── Phase 1.4 — RPC SLO / error budget ───────────────────────────────────────
export interface Slo {
  successPct: number | null;
  total: number | null;
  errors5xx: number | null;
  recent5xxPerMin: number | null;
}

// ── Phase 2 — optimisation signals ───────────────────────────────────────────
export interface Fairness {
  shares: { address: string; pct: number; recentlyProposed: boolean }[];
  spreadPct: number | null; // max-min proposing share
  verdict: string;
}

export interface Recommendation {
  area: string;
  severity: "info" | "warn" | "critical";
  text: string;
}

export interface Insights {
  generatedAt: string;
  baselines: Baseline[];
  forecasts: Forecast[];
  backups: BackupFreshness[];
  slo: Slo;
  cacheHitPct: number | null;
  fairness: Fairness;
  recommendations: Recommendation[];
}

export async function getInsights(nowMs: number): Promise<Insights> {
  const recs: Recommendation[] = [];

  // 1.1 baselines
  const baselines = await Promise.all(BASELINE_SERIES.map(baseline));
  for (const b of baselines) {
    if (b.status === "anomalous")
      recs.push({ area: b.key, severity: "warn", text: `${b.label} is statistically anomalous (${b.current?.toFixed(1)} vs ~${b.mean?.toFixed(1)} baseline, z=${b.z?.toFixed(1)}). Investigate before it trips a hard alert.` });
  }

  // 1.2 forecasts
  const [lagNow, lagPred, memNow, memPred] = await Promise.all([
    prom("hara_indexer_lag_blocks"),
    prom("predict_linear(hara_indexer_lag_blocks[30m], 3600)"),
    prom("hara_indexer_process_resident_memory_bytes"),
    prom("predict_linear(hara_indexer_process_resident_memory_bytes[1h], 3600)"),
  ]);
  const forecasts: Forecast[] = [
    { label: "Indexer lag (+1h)", current: lagNow, predicted1h: lagPred, threshold: 25, willBreach: (lagPred ?? 0) > 25 },
    { label: "Indexer memory (+1h)", current: memNow, predicted1h: memPred, threshold: 2 * 1024 ** 3, willBreach: (memPred ?? 0) > 2 * 1024 ** 3 },
  ];
  if (forecasts[0].willBreach) recs.push({ area: "services", severity: "warn", text: `Indexer lag is trending up — projected ~${lagPred?.toFixed(0)} blocks within the hour (threshold 25). Check indexer throughput / RPC.` });

  // 1.2 backup freshness
  const backups: BackupFreshness[] = [];
  try {
    const b = await getBackups();
    for (const h of b.hosts)
      for (const t of h.timers) {
        const ageHours = t.lastRun ? (nowMs - new Date(t.lastRun).getTime()) / 3600000 : null;
        const overdue = t.result !== "success" || (ageHours != null && ageHours > 26);
        backups.push({ unit: t.unit, host: h.host, ageHours, result: t.result, overdue });
        if (overdue) recs.push({ area: "backups", severity: "warn", text: `${t.unit} on ${h.host} hasn't had a successful run in ${ageHours ? ageHours.toFixed(0) + "h" : "a while"} (last result: ${t.result}). Verify the nightly backup.` });
      }
  } catch {
    /* agents unreachable */
  }

  // 1.4 RPC SLO
  const [nonErr, total, recent5xx] = await Promise.all([
    prom('sum(haproxy_backend_http_responses_total{code!="5xx"})'),
    prom("sum(haproxy_backend_http_responses_total)"),
    prom('sum(rate(haproxy_backend_http_responses_total{code="5xx"}[5m])) * 60'),
  ]);
  const successPct = nonErr != null && total ? (100 * nonErr) / total : null;
  const slo: Slo = { successPct, total, errors5xx: total != null && nonErr != null ? total - nonErr : null, recent5xxPerMin: recent5xx };
  if (successPct != null && successPct < 99.9) recs.push({ area: "rpc", severity: "warn", text: `RPC success rate ${successPct.toFixed(3)}% is below the 99.9% target — investigate 5xx sources.` });

  // 2.1 cache hit ratio
  const cacheHit = await prom("sum(guava_cache_hit_total) / clamp_min(sum(guava_cache_requests_total), 1)");
  const cacheHitPct = cacheHit != null ? cacheHit * 100 : null;
  if (cacheHitPct != null && cacheHitPct < 70) recs.push({ area: "rpc", severity: "info", text: `RPC cache hit-rate is ${cacheHitPct.toFixed(0)}% — consider longer TTLs or caching more read methods to cut validator load.` });

  // 2.2 validator fairness
  let fairness: Fairness = { shares: [], spreadPct: null, verdict: "no data" };
  try {
    const v = await getValidators();
    const counts = v.validators.map((x) => x.proposedBlockCount ?? 0);
    const sum = counts.reduce((a, c) => a + c, 0);
    if (sum > 0) {
      const shares = v.validators.map((x) => ({ address: x.address, pct: (100 * (x.proposedBlockCount ?? 0)) / sum, recentlyProposed: x.recentlyProposed }));
      const pcts = shares.map((s) => s.pct);
      const spreadPct = Math.max(...pcts) - Math.min(...pcts);
      const ideal = 100 / shares.length;
      const verdict = spreadPct < ideal * 0.5 ? "balanced" : spreadPct < ideal ? "slightly uneven" : "uneven — investigate the lagging validator(s)";
      fairness = { shares, spreadPct, verdict };
      if (spreadPct >= ideal) recs.push({ area: "validators", severity: "info", text: `Validator proposing share is uneven (spread ${spreadPct.toFixed(0)}pp). A node may be slow/peering poorly — check the lowest-share validator.` });
    }
  } catch {
    /* skip */
  }

  // 2.4 indexer batch tuning
  const batch = baselines.find((b) => b.key === "batchMs");
  if (batch?.current != null && batch.current > 250) recs.push({ area: "services", severity: "info", text: `Indexer batch duration ~${batch.current.toFixed(0)}ms is high — consider a smaller batch size or more concurrency to keep lag low.` });

  if (recs.length === 0) recs.push({ area: "all", severity: "info", text: "No optimisation or reliability concerns detected — baselines normal, forecasts within bounds, SLO healthy." });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    baselines,
    forecasts,
    backups,
    slo,
    cacheHitPct,
    fairness,
    recommendations: recs,
  };
}
