# L4 — Monitoring & alerting runbook

L4 closes the loop on observability: every component now emits metrics + logs, Prometheus scrapes the metrics, Loki ingests the logs, Alertmanager fires alerts when something breaks, and Grafana correlates all of it on one screen.

## Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│  All containers (validators, RPC, services, infra)                    │
│  └─ stdout/stderr ──────────► Promtail (Docker SD) ──► Loki :3100     │
│  └─ /metrics ◄─── scrape ──── Prometheus :9090                        │
│                                  │                                    │
│                                  └─ evaluates alert_rules.yml ────►   │
│                                                                       │
│                                  Alertmanager :9093                   │
│                                       │                               │
│                                       ▼ webhook                       │
│                                  alert-sink :8080  (dev)              │
│                                       │                               │
│                                       └─► stdout (visible via         │
│                                              docker logs)             │
│                                                                       │
│  Grafana :3000  ◄──── Prometheus + Alertmanager + Loki (datasources) │
│                 ◄──── dashboards: Besu / RPC tier / Indexer / Fleet  │
└──────────────────────────────────────────────────────────────────────┘
```

## What's new vs L3

| Component | L3 | L4 |
|---|---|---|
| Metrics scrape | Besu + HAProxy + indexer (no alerting) | + 11 alert rules across 4 groups, evaluated every 15–30s |
| Alert routing | None | Alertmanager → webhook → `alert-sink` (replaced by Slack/PagerDuty in P1) |
| Logs | `docker logs` only | All container stdout/stderr in Loki, queryable in Grafana |
| Dashboards | 3 per-tier | + "Fleet overview" combining metrics + alert count + logs |
| Failure detection time | Manual / human | Automated, ≤ 30s for critical alerts |

## Bring-up

```bash
# Build alert-sink image, pull Loki/Promtail/Alertmanager
docker compose -f chain/docker-compose.yml --env-file chain/.env build alert-sink
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d
```

Health probes:
```bash
curl http://localhost:9090/-/ready          # Prometheus
curl http://localhost:9093/-/ready          # Alertmanager
curl http://localhost:3201/ready            # Loki
curl http://localhost:9090/api/v1/rules     # Rule groups loaded
```

## L4 exit criteria

- [ ] Prometheus `/api/v1/rules` returns **4 groups, 11 rules**
- [ ] All scrape targets are UP at `http://localhost:9090/targets`
- [ ] Loki `/labels` returns at least `cluster`, `container`, `service`, `stream`
- [ ] **Killing the indexer → `IndexerDown` alert fires at Alertmanager and lands in `alert-sink` stdout within ~90s** (verified)
- [ ] Restarting the indexer → alert auto-resolves and a `resolved` notification fires (verified)
- [ ] Grafana "Fleet overview" dashboard shows: active-alert count, chain head, indexer lag, RPC backend status, recent error logs
- [ ] Loki query `{container="hara-indexer"}` returns recent log lines
- [ ] At least one alert runbook is present under `ops/runbooks/alerts/`

## Active alert rules

| Group | Alert | Severity | Fires when |
|---|---|---:|---|
| chain | ChainStalled | critical | No new blocks for 1m on any node |
| chain | ValidatorPeersLow | warning | Validator peer count < 3 for 1m |
| chain | ValidatorMetricsMissing | critical | `up==0` for validator scrape for 1m |
| rpc | RPCBackendDown | warning | HAProxy reports any rpc_*_pool server DOWN for 30s |
| rpc | RPCReadPoolAllDown | critical | All read pool servers DOWN for 30s |
| rpc | RPCHighErrorRate | warning | 4xx/5xx rate > 5% for 2m |
| services | IndexerLagHigh | warning | Indexer >50 blocks behind for 1m |
| services | IndexerLagCritical | critical | Indexer >500 blocks behind for 1m |
| services | IndexerErrorsFiring | warning | >5 errors per 5m at any stage |
| services | IndexerDown | critical | `up==0` for indexer scrape for 1m |
| infra | ScrapeTargetMissing | warning | Any target down for 2m |

## End-to-end verification

### Trigger and observe an alert

```bash
# Kill the indexer
docker stop hara-indexer

# Wait ~90s for IndexerDown to fire
sleep 90

# See it in Prometheus
curl http://localhost:9090/api/v1/alerts | python -m json.tool

# See it in Alertmanager
curl http://localhost:9093/api/v2/alerts | python -m json.tool

# See the webhook delivery
docker logs hara-alert-sink

# Restart, wait for resolve
docker start hara-indexer
sleep 90
docker logs hara-alert-sink   # expect a "resolved" event
```

### Query logs across all containers

```bash
# All errors anywhere in the last 15m
curl -G "http://localhost:3201/loki/api/v1/query_range" \
  --data-urlencode 'query={cluster="hara-ledger-local"} |~ "(?i)error|fail"' \
  --data-urlencode "start=$(date -d '15 min ago' +%s)000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode 'limit=20' | python -m json.tool
```

Or in Grafana: Explore → Loki → `{container="hara-indexer"} |~ "error"`.

### See which alerts exist

```bash
curl -s http://localhost:9090/api/v1/rules | python -m json.tool | grep -E '"name"|"state"'
```

## Common issues

### "Prometheus shows targets DOWN but the containers are running"

The target IP/port in `prometheus.yml` might not match the container's network identity. Check:
```bash
curl http://localhost:9090/api/v1/targets | python -m json.tool | grep -E '"health"|"scrapeUrl"'
```

Targets must resolve via Docker DNS to a container on the `hara-chain` network. If a service is on a different network or its hostname doesn't match, scrape will fail.

### "Alert is firing in Prometheus but not in Alertmanager"

Connectivity issue. Check:
```bash
docker exec hara-prometheus wget -qO- http://alertmanager:9093/-/ready
```

If this returns an error, Alertmanager isn't reachable from Prometheus. Both must be on the `hara-chain` network.

### "alert-sink shows nothing"

Alert may be silenced or the route doesn't match. Check:
```bash
curl http://localhost:9093/api/v2/silences
curl http://localhost:9093/api/v2/alerts/groups
```

### "Loki shows no logs from container X"

Promtail's Docker discovery uses the `com.docker.compose.project=hara-ledger` label. If you started a container manually (without compose) it won't appear. Restart it via compose.

## What L4 does NOT include

- **Real notification channels**: Slack, PagerDuty, email. The `alert-sink` is a placeholder. Production replaces it with `webhook_configs`/`slack_configs`/`pagerduty_configs` in `alertmanager.yml`.
- **Recording rules**: pre-aggregated metrics like `rate_5m_failed_txs`. Lands when query latency on the dashboard becomes a real concern.
- **High-cardinality log labels** (e.g., `request_id`): Loki costs grow with label cardinality. Add selectively per-service as needed.
- **External uptime monitoring** (Uptime Kuma in the blueprint): adds in P1 because it requires a public-Internet-facing probe.
- **SLO dashboards**: percentile-based availability + burn-rate alerts. Lands in P2 when we have a real SLA to defend.
- **Tracing** (OpenTelemetry → Tempo): cross-service request tracing. Lands in P2 when service-to-service complexity justifies it.

## Files added in L4

```
chain/prometheus.yml                                   EDIT — adds rule_files + alerting section
chain/prometheus/alert_rules.yml                       NEW — 11 alert rules across 4 groups
chain/alertmanager/alertmanager.yml                    NEW — routing + receivers + inhibition
chain/alert-sink/                                      NEW — minimal webhook receiver (sink.mjs + Dockerfile)
chain/loki/loki-config.yml                             NEW — single-instance Loki config
chain/promtail/promtail-config.yml                     NEW — Docker SD log scraping
chain/grafana/provisioning/datasources/prometheus.yml  EDIT — adds Alertmanager + Loki datasources
chain/grafana/provisioning/dashboards/fleet-overview.json NEW — composite dashboard
chain/docker-compose.yml                               EDIT — adds alertmanager, alert-sink, loki, promtail
ops/runbooks/L4-monitoring.md                          this file
ops/runbooks/alerts/                                   per-alert runbook stubs
```

## Per-alert runbooks

Each alert annotation includes `runbook: ops/runbooks/alerts/<AlertName>.md`. See that directory for actionable steps when each alert fires.

## Next stage

**L5 — Technical explorer (Blockscout).** Drops Blockscout in front of an archive node so the ops team can inspect blocks/txs/contract calls without writing SQL.
