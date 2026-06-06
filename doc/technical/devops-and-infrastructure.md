# Hara Registry — DevOps & Infrastructure Reference

**Audience:** operators, infra/DevOps engineers, auditors, and anyone planning the
scale-out from the current single-provider pilot to a hybrid multi-cloud posture.
**Companion:** [`TECHNICAL.md`](TECHNICAL.md) (architecture/contracts/services),
[`audit-security-quantum-performance.md`](audit-security-quantum-performance.md)
(security + PQ + perf), and the latest state handoff in
[`../state/`](../state/).
**Live as-built snapshot:** 2026-06-06 (inventory pulled from the running fleet).

> This document is the **infrastructure source of truth**. It supersedes the older
> 6-VPS deployment snapshot in `TECHNICAL.md` §8–9 (which described the planned
> Option-B layout); the **as-built reality is 7 VPSes** with observability,
> services, edge, and the console co-located on one host — see §1.

---

## Part A — Current state (as-built)

## 1. Architecture (as-built)

Hara Registry runs on **7 Nevacloud VPSes** (Indonesian sovereign cloud) in a
**split-plane topology** over a WireGuard mesh. Each host keeps its own local
Docker bridge; cross-host traffic rides the mesh.

```
                         Internet (HTTPS / WSS)
                                  │
                     ┌────────────▼─────────────┐
                     │  Caddy edge (TLS, LE)     │  on hara-stateless-2
                     │  rpc. / explorer. /       │
                     │  grafana. / trace. /      │
                     │  console.*                │
                     └─────┬───────────────┬─────┘
        /read,/write,/ws   │               │  everything else
                ┌──────────▼────┐   ┌───────▼───────────────────────────┐
   RPC PLANE →  │  hara-rpc-1   │   │        hara-stateless-2           │ ← SERVICES +
   (8vCPU/23GB) │  HAProxy LB   │   │  signer broadcaster indexer       │   OBS + EDGE +
                │  rpc-write    │   │  anchor-worker rpc-cache           │   CONSOLE plane
                │  rpc-read-1/2 │   │  blockscout(+fe) console-api/web   │   (6vCPU/15GB)
                │  metrics-proxy│   │  prometheus grafana loki promtail  │
                └───────┬───────┘   │  alertmanager alert-sink tempo     │
                        │           └───────────────┬───────────────────┘
            QBFT P2P    │ JSON-RPC                  │ Vault/PG/Redis/MinIO (mesh)
        ┌───────────────▼───────────────┐   ┌───────▼───────────────────┐
   CHAIN│ hara-v1  hara-v2  hara-v3  v4  │   │      hara-stateful        │ ← DATA +
  PLANE │ Besu QBFT validators (4vCPU/  │   │  postgres redis minio     │   SECRETS plane
        │ 7GB each, quorum 3/4)         │   │  vault (Raft HA active)   │   (10vCPU/31GB)
        └───────────────────────────────┘   └───────────────────────────┘
```

**Planes & separation of concern**

| Plane | Host(s) | Workloads |
|---|---|---|
| **Data + secrets** | `hara-stateful` | Postgres 16, Redis 7, MinIO, Vault (Raft HA, active). Runs all data-tier backup timers + the weekly recovery drill. |
| **Chain** | `hara-v1..v4` | Besu QBFT validators, one per host, quorum 3/4. |
| **RPC** | `hara-rpc-1` | HAProxy LB + `rpc-write` + 2× `rpc-read` + per-node metrics proxies + autoheal. |
| **Services + Observability + Edge + Console** | `hara-stateless-2` | signer, broadcaster, indexer, anchor-worker, rpc-cache, Blockscout (BE+FE), Strata Console (API+web), Caddy edge, **and the full obs stack** (Prometheus, Grafana, Loki, Promtail, Alertmanager, alert-sink, Tempo). |

> ⚠️ **As-built deviation from the design:** the proposal split *stateful* vs
> *stateless* and implied a separate obs host. In reality **everything non-chain,
> non-data, non-RPC is on one box (`hara-stateless-2`)** — services, all
> observability, the TLS edge, *and* the console. That host is a **single point of
> failure** for the public API surface, dashboards, alerting, and admin console
> simultaneously (see Risk R-06).

## 2. Stack (current, real versions)

| Layer | Choice | Version (as-built) |
|---|---|---|
| Host OS / kernel | Ubuntu, kernel 6.8.0-63 | — |
| Container runtime | Docker | 29.5.2 |
| Orchestration | Docker Compose (per-host), no Swarm/k8s | — |
| Chain client | Hyperledger Besu, QBFT, chainId 131216, gasPrice 0 | besu 26.x (Bonsai) |
| Datastore | PostgreSQL (PITR: archive_mode + WAL) | 16-alpine |
| Cache/queue | Redis (Streams + KV) | 7-alpine |
| Object store | MinIO (S3-compatible) | — |
| Secrets | HashiCorp Vault (Raft, AppRole, 3/5 unseal) | 1.17.6, HA active |
| Edge / TLS | Caddy + Let's Encrypt | 2.x |
| Backups | bash + `age` + `zstd` + `rclone` → Nevacloud S3; systemd timers | — |
| Explorer | Blockscout BE + `ghcr.io/blockscout/frontend` | 6.10.1 / v1.37.1 |
| Console | Vite/React (web) + Node 22/Fastify (API) + dep-free agent | — |
| Observability | Prometheus + Grafana + Loki + Promtail + Alertmanager + Tempo | — |
| Mesh | WireGuard (ChaCha20-Poly1305) | — |
| CI | GitHub Actions (contracts/services/slither/echidna/console-gate, Gitleaks, CodeQL) | — |

## 3. Security framework & standards (current)

**Controls in place**
- **Key custody:** validator/signer/anchor keys in Vault (Raft HA); per-role
  **AppRole** policies, read-scoped to the minimal path; **no root token on prod
  hosts**. Keys cached in memory by services; never on disk.
- **TLS:** terminated at Caddy (auto-renewed LE) for the public hostnames; upstream
  is plaintext **inside the WG tunnel** (ChaCha20-Poly1305 encrypted on the wire).
- **Network isolation:** WireGuard mesh + per-host `ufw`; only mesh peers reach a
  host; Vault is never publicly exposed (SSH-tunnel only).
- **App-layer PQ:** hybrid ECDSA + ML-DSA-65 (FIPS 204) audit anchoring via
  `PQAnchorRegistry`; signature blobs in MinIO, commitment on-chain.
- **Supply chain:** Slither + (Echidna) on contracts, Gitleaks secret-scan, CodeQL,
  branch protection (1 review) on `main`.
- **Console:** read-only / **propose-only** — builds + audits privileged commands,
  never signs or executes.

**Standards observed / targeted** — UU PDP (data residency: sovereign cloud), RSPO
chain-of-custody, BPJPH halal rules, EU CSDDD/EUDR traceability, NIST **FIPS 204**
(ML-DSA) today + **FIPS 203** (ML-KEM) reserved for hybrid TLS, W3C DID-Core;
**ISO 27001** + **SOC 2 Type II** in prep (P1/P2). Full rationale in
`audit-security-quantum-performance.md`.

**Current security gaps (honest)** — see the risk register §11: leaked-credential
rotation pending (Vault root token, GitHub PAT, Kimi key); single admin key (no
multisig yet); alerting is stdout-only; no HSM; `.env` files untracked with no
templates (root-caused the Blockscout outage); per-service DB users not yet split.

## 4. Network information (current)

**Two networks (the critical rule):** **same-host = container name, cross-host =
mesh IP.**
- **WireGuard mesh `10.43.0.0/24`** — cross-host. Key peers: `hara-stateful`
  `10.43.0.40`, RPC tier `10.43.0.21`, validators `10.43.0.11–14`, services/obs
  `10.43.0.25`.
- **Docker bridge `10.42.0.0/24`** (`hara-platform`) — per-host, service-name DNS.

**Public surface (Caddy → mesh upstream):**

| Hostname | Routes to |
|---|---|
| `rpc.ledger.haratrust.io` | `/read/`→rpc-cache, `/write/`→LB:8545, `/ws`→LB:8546 |
| `explorer.ledger.haratrust.io` | `/api/*` + `/socket/*`→Blockscout BE, else FE |
| `grafana.platform.haratrust.io` | Grafana |
| `trace.ledger.haratrust.io` | indexer trace-API + DAG viewer (HTTP Basic) |
| `console.platform.haratrust.io` | console-api `/api/*` + console-web (Basic, WG-gated) |

**Rate limits:** HAProxy ~5,000 req/10s per IP, 32k concurrent at the LB. **Public
IPs** (SSH/edge): stateful 103.67.244.250, rpc-1 103.169.206.237, stateless-2
103.169.206.239, v1 202.155.18.234, v2 103.169.206.46, v3 103.169.206.127,
v4 160.19.166.23.

## 5. Server configuration (current — as-built inventory)

| Host | vCPU | RAM | Disk | Util | Role | Notes |
|---|---:|---:|---:|---:|---|---|
| `hara-stateful` | 10 | 31 GB | 400 GB | 8% | Postgres, Redis, MinIO, Vault (Raft HA active) | Vault container shows **unhealthy** = false healthcheck (Vault is unsealed/active — R-02) |
| `hara-rpc-1` | 8 | 23 GB | 300 GB | ~~82%~~ **6%** | HAProxy LB, rpc-write, rpc-read-1/2, metrics proxies, autoheal | Was 82% from 229 GB unrotated Docker logs — **remediated 2026-06-06** (truncate + hourly logrotate + daemon.json); see R-01 |
| `hara-stateless-2` | 6 | 15 GB | 200 GB | 9% | signer, broadcaster, indexer, anchor-worker, rpc-cache, Blockscout BE+FE, console API+web, Caddy, **+ full obs stack** | Heavily loaded single host = SPOF (R-06); 17 containers |
| `hara-v1..v4` | 4 | 7 GB | 100 GB | 9% | Besu QBFT validator (one each) + metrics proxy | RAM at 7 GB — the 8→16 GB upgrade item (R-07) |

---

## Part B — Target state (ideal future)

## 6. Target hybrid architecture (VPS + datacenter + private cloud + AWS + Huawei)

The guiding principle is **sovereignty-first, multi-cloud for resilience, elastic
cloud for the read/verify edge**. Workloads are placed by their trust and scaling
profile, not by convenience.

```
            ┌────────────────── Anycast / CDN edge (Cloudflare) ──────────────────┐
            │   WAF · DDoS · TLS(hybrid PQ) · cache for /read + verify APIs        │
            └───────┬─────────────────────────┬──────────────────────────┬────────┘
                    │                          │                          │
        ┌───────────▼──────────┐   ┌───────────▼──────────┐   ┌───────────▼─────────┐
        │  PRIMARY (sovereign) │   │   DR / 2nd region    │   │  ELASTIC READ TIER  │
        │  Nevacloud DC +      │   │   Huawei Cloud ID    │   │  AWS (ap-southeast) │
        │  private cloud       │   │   (or AWS Jakarta)   │   │  autoscaling        │
        │                      │   │                      │   │                     │
        │ • validators v1–v3   │   │ • validator v4 +     │   │ • rpc-read pool (N) │
        │ • data tier (PG HA,  │   │   hot standby valid. │   │ • rpc-cache + CDN   │
        │   Vault HSM-backed)  │   │ • PG streaming replica│  │ • verify/trace API  │
        │ • write RPC + signer │   │ • Vault DR replica   │   │ • Blockscout read   │
        │ • indexer/anchor     │   │ • MinIO/OBS mirror   │   │                     │
        │ • K3s/K8s stateless  │   │ • cold→warm failover │   │ stateless, no keys  │
        └──────────┬───────────┘   └──────────┬───────────┘   └─────────────────────┘
                   └──── private interconnect (Direct Connect / Cloud Connect /  ────┘
                          encrypted WG/IPsec mesh, segmented per tier) ─────
```

**Placement rationale**

| Workload | Where | Why |
|---|---|---|
| **Validators** | Spread: ≥3 across **Nevacloud DC + private cloud**, ≥1 on **Huawei/AWS 2nd region** | Sovereignty + BFT geo-resilience; a single region/provider outage costs ≤1–2 validators, quorum (3/4 or 5/7) survives. |
| **Data tier (PG primary, Vault)** | **Private cloud / dedicated DC**, HSM-backed Vault | Highest-trust, lowest-churn; keys never leave HSM; predictable IOPS. |
| **PG hot standby + Vault DR** | **Huawei/AWS 2nd region** | Cross-provider DR; streaming replication for low RPO. |
| **Write RPC + signer + anchor** | Primary only (single-writer) | Avoid split-brain; writes are low-volume. |
| **Read RPC + cache + verify/trace APIs** | **AWS/cloud elastic + CDN edge** | This is the high-RPS surface (millions of QR-verify calls); autoscale + edge cache, stateless, **holds no keys**. |
| **Object store (anchors, blobs, docs)** | MinIO primary + **cross-cloud replication** to Huawei OBS / S3 | Content-addressed; any holder of the on-chain commit can verify a blob regardless of host. |
| **Observability + edge + console** | Own small HA pair (NOT co-located with services) | Remove the current SPOF. |

## 7. Ideal scalable architecture

Scale levers, in dependency order (read-heavy is the dominant axis — verify traffic
dwarfs writes):

1. **Stateless read tier → horizontal + edge.** rpc-read pool behind the LB scales
   linearly; front it with rpc-cache + **CDN/edge workers** for verify APIs (99%
   cache-hit measured). Target: P1 ~10k read TPS, P2 ~500k, P3 ~5M.
2. **Orchestrate the stateless tier on K3s/K8s** (validators + data stay on
   Compose/dedicated). Enables rolling deploys, HPA autoscaling, self-healing.
3. **Database:** pgBouncer connection pooling → read replicas → **ClickHouse** for
   analytics at 10M+ events (custody-DAG aggregates outgrow Postgres views).
4. **Indexer:** parallel sharded workers (by contract/topic) + bigger batches;
   promote SQL views → materialized → ClickHouse.
5. **Signer:** **HSM/KMS-backed** signing pool (5–10× throughput, parallel signing).
6. **Validators:** geo-spread + dedicated **archive nodes** for historical queries;
   raise to 7–15 validators at P2 (consortium: BPJPH/LPH/MUI partner-operated).
7. **Write path:** keep single-writer; batch via `TraceabilityBatchRelay`; per-sender
   pool caps respected (~200 sequential txs).

**Capacity-to-workload tracking** is already live in the console (Insights →
Capacity & growth) vs the 45-month projection (25k batches × ~7k transfers + 4M
passports). Add **node_exporter** for precise disk-fill forecasting (currently
estimated, not measured).

## 8. Ideal security framework

- **HSM / Cloud KMS** for validator + signer + anchor keys (replaces Vault-in-memory
  for the highest-value keys); Vault remains the broker.
- **Governance multisig:** Gnosis Safe (N-of-M) for all admin-key actions
  (role grants, validator add/remove, registry writes) → unlocks Console P2.
- **Zero-trust service mesh:** mTLS between services (step-ca / cert-manager), deny-
  by-default network policies, per-service DB users with least-privilege grants.
- **Edge:** WAF + DDoS (Cloudflare), bot/rate management, **hybrid PQ TLS**
  (X25519MLKEM768) when client/edge support lands.
- **Secrets:** automated rotation (AppRole secret-id + DB creds), short TTLs, **SIEM**
  ingest of Vault/edge/audit logs; quarterly→monthly key-rotation ceremony.
- **Compliance:** ISO 27001 (stage 1→2), SOC 2 Type II, pen-test cadence, DPA filed.
- **Governance hygiene:** end admin-bypass merges; enforce 2 reviewers as the team
  grows; signed images + provenance.

## 9. Ideal network design

- **Segmented tiers:** separate subnets/VLANs per plane (chain P2P / data / RPC /
  edge), default-deny between them, explicit allow per dependency.
- **Private interconnect** between regions/providers: Direct Connect / Cloud Connect
  or encrypted IPsec/WG mesh — **no public data plane**; data tier reachable only via
  private endpoints.
- **Multi-region WG mesh** (today single `/24`): per-region CIDRs + routed
  interconnect; persistent keepalives; automated peer onboarding.
- **Edge:** Anycast + CDN; only `/read` + verify + explorer are public; writes/admin
  behind mTLS/VPN.
- **DNS:** health-checked failover records (primary→DR), low TTL on the RPC/verify
  endpoints.

## 10. Backup / Replication / Auto-recovery / DR

**Current (the 5 DR pillars — live, drills passing):**

| Pillar | Implementation | State |
|---|---|---|
| Backups | logical PG dump + Redis RDB + MinIO tar + Vault Raft snap → `age`-encrypted → Nevacloud S3 | live |
| Snapshots | PG base backup (PITR baseline) + validator chain-data | live |
| Replication | every WAL segment → S3 ~10 min (**RPO ≤ ~10 min**, async only) | live |
| Failover | cold/sleeping standby (`standby-bootstrap.sh`: restore base + replay WAL, operator-promote) | **foundation only — no standby host yet** |
| Recovery | weekly automated restore drills (PITR + logical), results in console | live, passing |

Schedules: PG base 01:30, PG dump 02:00, Redis 02:30, MinIO 02:45, Vault 04:00, WAL
every 10 min, validators 03:00/15/30/45, drills Sun 05:00. All uploads use chunked
multipart (Nevacloud S3 rejects large single-PUT). Encryption key (`age`) lives only
on the operator workstation; buckets see ciphertext.

**Ideal target:**

| Capability | Target |
|---|---|
| Replication | **PG streaming hot standby** (sync or low-lag async) in the DR region → RPO seconds, not 10 min. Keep WAL→S3 as the archival/PITR floor. |
| Failover | **Health-gated, operator-confirmed** promotion (never fully auto → no split-brain); DNS/health-check cutover; standby kept *warm*. |
| Object/secret | Cross-cloud replication (MinIO→Huawei OBS/S3); Vault DR replica (Enterprise) or periodic Raft-snapshot restore in DR. |
| Validators | Geo-spread quorum + a hot standby validator that can join within minutes. |
| Recovery | Automated drills + **quarterly GameDay** (full region-loss rehearsal); restore runbooks codified + timed. |
| Targets | **P1:** RPO 24h→10min, RTO 4h. **P2:** RPO ≤5min, RTO ≤1h, multi-region active-active read. **P3:** RPO ≤1min, RTO ≤15min. |

**Immediate gap:** the sleeping-standby is built but **unprovisioned** (no standby
VPS + Nevacloud power-automation creds). Until then, failover = manual
restore-from-S3 to a fresh host (RTO ≈ download+replay).

## 11. Risk register & mitigation checklist

Severity = (likelihood × impact). **🔴 act now · 🟠 near-term · 🟡 planned.**

| ID | Risk | Sev | Current state | Mitigation / action |
|---|---|:--:|---|---|
| **R-01** | **hara-rpc-1 disk 82%** — 229 GB of unrotated Docker json logs (rpc-read-1 105 GB, rpc-read-2 104 GB, lb 20 GB) → host fills → **RPC tier down** | ✅ | **REMEDIATED 2026-06-06 (zero downtime):** truncated the live logs (82%→6%, ~229 GB reclaimed); installed hourly `logrotate` (copytruncate, maxsize 500M) as the active cap; wrote `/etc/docker/daemon.json` (`max-size 50m`/`max-file 5` + `live-restore`) so future recreations rotate natively. **Follow-ups:** recreate the RPC containers at next deploy to apply Docker's native cap; reduce Besu rpc-read log verbosity at source (~20 GB/day/node is abnormal); add a disk>80% alert (ties to R-10). |
| **R-02** | Vault container reports **unhealthy** (healthcheck failing since boot) | 🟠 | Vault is actually **unsealed + HA active** — false healthcheck. Autoheal could needlessly restart a healthy Vault (which then needs 3/5 manual unseal) | Fix the healthcheck (`vault status` semantics / VAULT_ADDR); exclude from autoheal or make it seal-aware |
| **R-03** | **Leaked credentials** un-rotated: Vault root token, GitHub PAT, Kimi/Moonshot key | 🔴 | Known since multiple handoffs | Rotate all three (operator-only); scrub history; move to short-TTL AppRole |
| **R-04** | **Single admin key** governs privileged contract ops (historically anvil-0) | 🟠 | No multisig | Stand up **Gnosis Safe** N-of-M; route grants/validator changes through it |
| **R-05** | **QBFT quorum loss** — 2/4 validators down halts the chain | 🟠 | All 4 in one provider/region | Geo-spread validators across DC + 2nd cloud; add hot standby validator; raise to 5/7 at P2 |
| **R-06** | **`hara-stateless-2` SPOF** — services + obs + edge + console on one 6vCPU/15GB host | 🟠 | Single host | Split obs/edge onto an HA pair; K3s for the stateless tier; move console to its own small host |
| **R-07** | Validators at **7 GB RAM** under GC pressure | 🟡 | Nominal 8 GB | Upgrade 8→16 GB when proposer/heap data says so (console fairness panel) |
| **R-08** | **Vault single-node Raft** | 🟠 | HA mode but effectively 1 node | 3-node Raft cluster; encrypted unseal-key custody; HSM at P2 |
| **R-09** | **DR replication async only** (RPO ~10 min); **standby unprovisioned** | 🟠 | WAL→S3 live; `standby-bootstrap.sh` ready but no host | Provision standby VPS + Nevacloud API creds; add PG streaming replica in DR region |
| **R-10** | **Alerting stdout-only** — rules exist, nobody is paged | 🟠 | Alertmanager → alert-sink → stdout | Wire Alertmanager → Slack/PagerDuty/email; alert on burn-rate + disk/cert/backup-age |
| **R-11** | **`.env` files untracked, no templates** (root-caused the Blockscout FE outage) | 🟡 | Partly fixed (added FE `.env.example`) | Add tracked `.env.example` for every service; CI lint for `localhost` in prod env |
| **R-12** | **No HSM** — high-value keys in Vault memory | 🟡 | Vault dev→Raft done; no HSM | Cloud KMS/HSM for validator+signer+anchor keys at P2 |
| **R-13** | **Single object-store provider** (Nevacloud S3) for all backups | 🟡 | One bucket region | Cross-cloud replication to Huawei OBS / AWS S3 |
| **R-14** | **No WAF/DDoS** on public endpoints | 🟡 | Caddy rate-limit only (plugin optional) | Cloudflare WAF + DDoS + edge cache for verify APIs |
| **R-15** | **TLS cert expiry** | 🟢 | Caddy auto-renew (LE) | Monitor cert age in console; alert at <14 days |
| **R-16** | **Single WG mesh, no cross-region** | 🟡 | One `/24` | Multi-region CIDRs + routed private interconnect |
| **R-17** | **Admin-bypass merges** past the 1-review gate | 🟡 | Several PRs admin-merged | Retro-review backlog; enforce reviewers as team grows |
| **R-18** | **Per-service DB users not split** (shared `hara`) | 🟡 | One role | Least-privilege roles: signer/indexer/broadcaster/blockscout |
| **R-19** | **Besu QBFT mempool ordering** breaks chained txs | 🟢 | Mitigated (`TraceabilityBatchRelay`) | Keep using the relay; documented footgun |
| **R-20** | **Zero-balance sender drop** (Besu skips 0-balance even at gasPrice 0) | 🟢 | Mitigated (prefund 1 wei) | Console funder watchlist + onboarding prefund step |

**Top to action now:** ~~R-01 (disk/logs)~~ ✅ done 2026-06-06 · R-03 (rotate leaked
creds) · R-10 (real alerting — so the next R-01 pages someone before it's 82%) ·
R-02 (Vault healthcheck).

---

## Appendix — quick reference

- **Mesh rule:** same-host = container name, cross-host = mesh IP.
- **Invariants:** chainId 131216, gasPrice 0, legacy txs, EVM London, QBFT 3/4,
  Vault unseal 3/5.
- **Deploy hygiene:** on-host repos are intentionally frozen behind `main`
  (`git checkout origin/main -- <paths>` selectively, never a full pull — dirty
  config); `.env` is gitignored (keep the tracked `.env.example` current).
- **Bash gotcha:** apostrophes in commit/PR messages → use `-F`/`--body-file`.
