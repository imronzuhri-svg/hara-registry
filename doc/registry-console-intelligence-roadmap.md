# Strata Console — Intelligence Roadmap

> Where the console goes beyond "is it up?" — layering analysis, prediction, and
> insight on top of the live numbers it already collects. The guiding principle:
> **AI suggests, operators decide.** Every action-taking capability routes through
> the existing **propose-only** model (the console builds a reviewed command; a
> human approves and runs it). Nothing here ever signs or moves value on its own.

A condensed version of this is in the console under **Help & Guide → Intelligence roadmap**.

> **Status (2026-06-02): Phases 1 & 2 are LIVE** in the console **Insights** screen
> (`GET /api/insights`): statistical baselining (1.1), forecasts + backup-freshness
> (1.2), RPC SLO/error-budget (1.4), cache hit-rate (2.1), validator fairness (2.2),
> indexer batch hints (2.4) — rolled up into plain-language recommendations. Phase 3
> (forecasting vs the 45-month projection), Phase 4 (LLM copilot), and Phase 5
> (supply-chain intelligence) remain ahead.

---

## What we already have to work with

The console + Prometheus already collect a rich, real-time stream:

- **Chain:** block height, block-rate/time, gas used, tx-pool size, event throughput.
- **Validators:** per-node peers, in-sync, proposed-block counts, liveness.
- **RPC tier:** request rate, sessions, 5xx errors, cache behaviour (HAProxy).
- **Services:** indexer lag, batch latency, error rate, event-loop, memory.
- **Platform:** Vault seal/health, backup success + timing, alert history.
- **Domain (on-chain):** the full palm-oil custody DAG — batches, hops, splits/merges,
  RSPO certs, plantation IDs, PQ anchors — already indexed in Postgres.

That's the fuel. The roadmap is about what intelligence we put on top.

---

## Phase 0 — Threshold signals (LIVE today)

Stateless rules that flag a number crossing a healthy bound, surfaced in the
anomaly banner + Alertmanager:

- chain not advancing (block-rate ≈ 0), indexer lag high, indexer errors,
  failed backups, stale validators, firing-alert count.

Good for "known bad". Misses slow drifts and novel failure modes — that's Phase 1+.

---

## Phase 1 — Make sure it works (reliability intelligence)

**1.1 Statistical baselining.** Learn each metric's normal range (rolling
mean/stdev → z-score, or Holt-Winters / Prometheus `holt_winters`, `predict_linear`)
and flag deviations *before* a hard threshold. Catches: a validator slowly losing
peers, indexer batch latency creeping up, RPC error rate inching from 0.1%→1%.

**1.2 Predictive failure.** Forecast time-to-exhaustion for finite resources:
- disk fill date (esp. hara-stateful's 1 TB), inode/FD limits,
- TLS cert expiry, backup-age ("last good off-site copy is N days old"),
- chain-data growth → when to prune/archive,
- Vault lease/token pressure.
Output: "X will run out on ~DATE — schedule it" → turns surprises into milestones.

**1.3 Automated root-cause correlation.** When multiple signals fire, group them
into one incident and rank likely cause by temporal correlation (e.g. "RPC 5xx
spike began 30s after rpc-write GC pause"). Cuts mean-time-to-understand.

**1.4 Synthetic probes & SLOs.** Track availability/latency SLOs (RPC read/write,
trace API, explorer) with error budgets, and alert on burn rate, not just outages.

---

## Phase 2 — Optimise & enhance (performance intelligence)

**2.1 RPC/cache tuning.** Learn read query patterns; recommend rpc-cache TTLs and
which methods to cache; flag cache-bypass hotspots. Goal: more hit-rate, less
validator load.

**2.2 Validator fairness & load.** Detect proposer imbalance, peer-topology issues,
GC/heap pressure; recommend the 8→16 GB bump *when the data says so*, not on a hunch.

**2.3 Throughput & capacity right-sizing.** From real traffic, recommend VPS specs
(over/under-provisioned), HAProxy connection limits, batch sizes — cost vs headroom.

**2.4 Indexer optimisation.** Tune batch size / concurrency from observed
batch-duration vs lag; spot slow event types.

---

## Phase 3 — Predict the future (forecasting & milestones)

**3.1 Capacity vs the projected workload.** The nevacloud proposal sized for ~45
months (25k batches × ~7k transfers + 4M halal-passport NFTs). Continuously
compare *actual* growth to that curve and forecast when each ceiling is hit:
storage, TPS headroom, validator count, RPC capacity. Surfaces real "critical
milestones" with dates.

**3.2 Demand / load forecasting.** Seasonal/however-shaped forecasts of tx volume
and partner (hara-did) anchoring rate → pre-emptive scaling.

**3.3 Time-series anomaly ML.** Per-metric models (Prophet/ARIMA, or Grafana ML /
Mimir) for the high-value series (block time, lag, RPC latency) feeding back into
Alertmanager with real routing (Slack/PagerDuty — still stdout-only today, §17.4).

---

## Phase 4 — Operator copilot (LLM)

An assistant grounded in **live metrics + the repo's runbooks/docs (RAG)**:

- **Natural-language queries:** "why is indexer lag high?", "which validator is
  slow and since when?", "are backups healthy this week?".
- **Auto incident summaries:** when an anomaly/alert fires, draft a timeline +
  likely cause + the relevant runbook section.
- **Proposes fixes, never executes:** the copilot emits actions through the
  **existing propose-only Operations layer** — e.g. "fund 0x…", "grant MINTER then
  revoke", "mute this alert 1h" — which a human reviews and runs. This is the
  natural, safe home for AI action-taking on this system.

---

## Phase 5 — Supply-chain intelligence (domain insights & revelations)

This is the unique, high-value frontier — analysis of the **palm-oil traceability
data itself**, not just infra:

**5.1 Graph analytics on the custody DAG.** Flow maps (plantation → mill →
refinery → export), bottleneck/concentration analysis, hop-count and dwell-time
distributions, "who-supplies-whom" networks. (GNNs for richer patterns later.)

**5.2 Integrity / fraud detection.** Mass-balance violations (more out than in),
impossible custody timelines, duplicate/cloned batches, RSPO-cert gaps, suspicious
splitting/merging — i.e. greenwashing & double-counting detection on-chain.

**5.3 Compliance & ESG reporting.** Auto-generate RSPO/EUDR-style traceability
reports, certified-volume coverage, and audit packets straight from the chain +
PQ anchors — turning the registry into a reporting product.

**5.4 Market & sustainability insights.** Aggregate (privacy-preserving) trends:
certified vs uncertified volume over time, regional flows, throughput per
plantation — the "interesting revelations" layer for stakeholders.

---

## How it plugs in (architecture sketch)

```
Prometheus (metrics) ─┐
indexer Postgres ─────┼─→ Intelligence service(s) ──→ Console
custody DAG / anchors ┘    (baselining · forecasts ·     · new "Insights"/"Forecast" panels
                            graph analytics · LLM RAG)    · richer anomaly feed → Alertmanager
                                     │                    · copilot answers + PROPOSALS
                                     └────────────→ propose-only Operations (human-approved)
```

- Read-only against the same data the console already has; no new trust in the chain path.
- Heavy jobs (forecasts, graph/ML) run as scheduled batch services; the console reads their outputs.
- The LLM copilot is grounded (RAG over `doc/` + runbooks + live metrics) and is **action-gated** through propose-only.

---

## Suggested order (value vs effort)

1. **Statistical baselining + predictive capacity** (1.1, 1.2, 3.1) — highest ops value, modest effort, reuses Prometheus.
2. **Operator copilot — read/answer + summaries** (4, read-only first) — big usability win.
3. **Supply-chain integrity/fraud + compliance reports** (5.2, 5.3) — the differentiating product value.
4. **Copilot proposals + optimisation engine** (4 actions via propose-only, 2.x).
5. **Graph/ML depth** (5.1 GNN, 3.3) — once the data volume justifies it.
