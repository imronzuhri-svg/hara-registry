# Hara Registry — Session State Handoff #7 (2026-06-03)

Supersedes `hara-registry-state-6.md` (read it for the PITR-deploy + project-rename
narrative). This file is the **comprehensive technical state** as of the end of the
2026-06-03 session: architecture, stack, APIs, schemas, conventions, files, open
items. Everything in state-6 still holds; the deltas are the **console DR
categorization + periodic recovery testing** and the **sleeping-standby
foundation**.

---

## 0. TL;DR — what changed since state-6

1. **Console Backups menu reorganised into the 5 DR pillars** — 1·Backups,
   2·Snapshots, 3·Replication, 4·Failover, 5·Recovery — each independently
   monitored. New `GET /api/backups` returns per-job DR `category` + a `dr`
   summary (replication / failover / recovery). LIVE.
2. **Periodic recovery testing** — restore drills now write pass/fail JSON; a
   weekly `hara-drill-snapshot` timer (Sun 05:00) runs them; the console Recovery
   panel surfaces results. Drills currently PASS. LIVE.
3. **Sleeping-standby DR model chosen + foundation built** — cold/sleeping
   standby, restore base + replay WAL from S3, **operator-triggered** failover.
   `deploy/ops/standby-bootstrap.sh` (the "wake" action) merged. NOT deployed —
   no standby host exists yet; Nevacloud power automation pending creds.
4. **Agent enrichment + bug fixes** — backups agent now reports run duration,
   artifact size/age, and drill results; fixed the `systemctl show --value`
   ordering bug and the oneshot `lastRun`/`durationSec` gaps.
5. **PRs #43, #44 merged** (admin-bypass of the 1-review gate, like #36–#42).

---

## 1. Architecture (current)

### Topology (unchanged from state-4/5; 7 Nevacloud VPSes, split plane)
- **hara-stateful** — data + secrets plane: Postgres, Redis, MinIO, Vault. Runs
  all data-tier backup timers + the weekly recovery drill.
- **hara-v1..v4** — QBFT Besu validators (quorum 3/4). Each runs its own
  validator chain-data snapshot timer.
- **hara-rpc-1** — RPC tier (HAProxy LB + besu rpc-write/read nodes).
- **hara-stateless-2** — services + the Strata Console: indexer, broadcaster,
  signer, anchor-worker, Blockscout (+ FE), `hara-console-api`, `hara-console-web`.
- **.25 (platform/obs host)** — Prometheus, Alertmanager, Grafana, Loki, Tempo,
  edge Caddy. (Mesh IP 10.43.0.25.)
- **Networks:** WG mesh `10.43.0.0/24` (cross-host) vs per-host docker bridge
  `10.42.0.0/24` (`hara-platform`). **Rule: same-host = container name,
  cross-host = mesh IP.**

### Disaster-recovery model (NEW — the 5 pillars)
| Pillar | Implementation | State |
|---|---|---|
| **Backups** | logical/object off-host copies (postgres dump, redis RDB, minio tar, vault raft) → age-encrypted → Nevacloud S3 | live |
| **Snapshots** | physical point-in-time: postgres base backup (PITR baseline) + validator chain-data | live |
| **Replication** | continuous async: every WAL segment → S3 every 10 min (RPO ≤ ~10 min). No streaming replica | live (async only) |
| **Failover** | **cold/sleeping standby**: a normally-off VPS that wakes, restores base + replays WAL from S3, operator-promoted | foundation only (no VPS yet) |
| **Recovery** | weekly automated restore drills (PITR + logical), results surfaced in console | live, passing |

**Chosen failover design (decisions 2026-06-03):** cold/sleeping standby (not
always-on streaming) → near-zero standby compute cost, RPO ~10 min, RTO
~download+replay; **Nevacloud API automation** for power/provision (creds
pending); **operator-triggered** failover (no auto-promote → no split-brain).

### Strata Console (data flow)
```
browser ─HTTPS→ Caddy (console.platform.haratrust.io, basic_auth)
  ├ /api/* → hara-console-api:8910 (Fastify, read-only + propose-only)
  └ /*     → hara-console-web:80   (nginx static SPA)
hara-console-api reads: Besu RPC (mesh), Vault (mesh), Prometheus/Alertmanager
  (same-host container name), indexer /metrics, the 5 backups agents
  (10.43.0.{40,11,12,13,14}:8911), Kimi/Moonshot (egress).
```

---

## 2. Stack

| Layer | Choice |
|---|---|
| Chain | Hyperledger Besu, QBFT, chainId **131216**, gasPrice 0, legacy txs, 3/4 quorum |
| Data | Postgres 16-alpine (PITR: archive_mode + WAL), Redis 7-alpine, MinIO |
| Secrets | Vault (Raft, AppRole; unseal 3/5) |
| Backups | bash + `age` (encrypt) + `zstd` + `rclone` → Nevacloud S3; systemd timers |
| Console web | Vite + React 18 + TS + Tailwind (Strata theme) + Recharts; nginx |
| Console API | Node 22 + Fastify 5 + `tsx` (run, not compiled); deps: fastify, @fastify/cors, tsx |
| Console agent | **zero npm deps** — plain `node:http` on distro Node 18 |
| Copilot LLM | Kimi/Moonshot (`moonshot-v1-128k` fast default), base `https://api.moonshot.ai/v1` |
| CI | GitHub Actions; required gates: contracts/services/slither/echidna/console-gate, Gitleaks, CodeQL (Analyze actions + js-ts) |

---

## 3. Console APIs

**`hara-console-api`, base `/api` (read-only / propose-only):**
- `GET /healthz`
- `GET /api/overview` → `{chain,validators,accounts,rpcTier,services,vault,alerts,backups}`, each a `Section<T> = {available:true,data}|{available:false,error}`.
- **`GET /api/backups`** → `BackupsReport` (see §4) — the dedicated DR screen source.
- `GET /api/metrics/series` · `GET /api/metrics/range?series=<name>&minutes=<n>` — allowlisted PromQL only (`metrics.ts SERIES`).
- `GET /api/anomalies` → `{generatedAt, anomalies:[{area,level,message,at}]}`. Backup signals now: **failed** (critical), **overdue** (warn — silently-stopped timer), **never-run** (info), **agent-unreachable** (warn).
- `GET /api/insights` (baselines/forecasts/slo/fairness/capacity/backup-freshness/recommendations).
- `GET /api/copilot/status` · `POST /api/copilot {question}`.
- `GET /api/alerts/silences` · `POST /api/alerts/silence {alertname,hours,comment}` · `DELETE /api/alerts/silence/:id`.
- `POST /api/propose/:kind` (`fund|register|grantRole|revokeRole|onboard|snapshot`) + `GET /api/audit` (propose-only; builds + audits commands, never executes).

**Backups agent** (`hara-console-agent`, systemd, **wg0:8911**, read-only, dep-free):
- `GET /healthz` → `{ok, host}`
- `GET /backups` → `{host, generatedAt, timers[], drills[]}` (see §4 schema).

---

## 4. Schemas

### Agent `/backups` payload
```jsonc
{
  "host": "localhost",                  // NB: hara-stateful's hostname is "localhost"
  "generatedAt": "ISO",
  "timers": [{
    "unit": "hara-postgres-wal-snapshot.timer",
    "service": "hara-postgres-wal-snapshot.service",
    "nextRun": "ISO|null",
    "lastRun": "ISO|null",              // = max(timer last-trigger, service last-exit)
    "result": "success|exit-code|...|null",
    "exitStatus": "0|null",
    "durationSec": 13,                  // from ExecMain*TimestampMonotonic
    "activeState": "inactive|active|...",
    "artifactBytes": 56273952,          // newest file in the unit's backup dir (or null)
    "artifactAt": "ISO|null"
  }],
  "drills": [{ "drill": "pitr|logical-dump", "status": "pass|fail", "at": "ISO", "durationSec": 16 }]
}
```
- Artifact dir map (agent `ARTIFACT_DIRS`): postgres→`/var/backups/hara/postgres`, basebackup→`…/postgres-base`, redis→`…/redis`, minio→`…/minio`, validator→`/var/backups/hara`. **WAL + vault have no entry → `artifactBytes:null`** (WAL is continuous; vault writes to `./snapshots`). Adding them is a minor open item.

### `BackupsReport` (`GET /api/backups`, `console/server/src/sources.ts`)
```ts
{
  generatedAt, hosts, unreachable,
  jobs: BackupJob[],   // BackupTimerRaw + {host, base, category, expectedIntervalHours, ageHours, overdue, health}
  summary: { total, ok, failed, overdue, never, oldestSuccessAgeHours },
  dr: {
    replication: { method, walLastShipAt, walLagMinutes, healthy, rpoMinutes, streamingReplica:"configured"|"not configured" },
    failover:    { model, configured, standbyHost, standbyAwake:boolean|null, note },
    recovery:    { scheduled:boolean, drills:[{drill,status,at,durationSec,host,ageHours}], lastPass, anyFail }
  }
}
```
- `category: "backup" | "snapshot" | "replication"` (map in `sources.ts CATEGORY`).
- `health: "ok" | "failed" | "overdue" | "never" | "unknown"`.
- `EXPECTED_INTERVAL_HOURS`: wal 10/60h, all others 24h; `OVERDUE_GRACE = 1.3`.
- The `hara-drill-snapshot` timer is **excluded** from `jobs` and drives `dr.recovery.scheduled`.

### Drill result file (`/var/backups/hara/drills/<drill>.json`)
```json
{"drill":"pitr","status":"pass","exitCode":0,"at":"ISO","durationSec":16}
```
Written by the EXIT trap in `pitr-restore-drill.sh` and `snapshot-restore-drill.sh` (status from exit code).

### Postgres schema (indexer, unchanged) — tables incl. `watched_contracts`,
`indexed_events`, `pq_anchor_signatures`, `_migrations`; DBs `hara_indexer` +
`blockscout`. **`psql` needs `-d hara_indexer`** (no DB named `hara`).

---

## 5. Backup tier — timers & schedules

`install-backup-timers.sh` roles: `vault|validator|postgres|postgres-basebackup|postgres-wal|redis|minio|drill`.
hara-stateful auto-suite = `vault postgres postgres-basebackup postgres-wal redis minio drill`.
**Auto-detect fails on hara-stateful** (`hostname -s`=`localhost`) → pass roles explicitly.

| Unit | Schedule | Script |
|---|---|---|
| hara-postgres-basebackup-snapshot | 01:30 | snapshot-postgres-basebackup.sh |
| hara-postgres-snapshot | 02:00 | snapshot-postgres.sh |
| hara-redis-snapshot | 02:30 | snapshot-redis.sh |
| hara-minio-snapshot | 02:45 | snapshot-minio.sh |
| hara-vault-snapshot | 04:00 | vault-raft-snapshot.sh |
| hara-postgres-wal-snapshot | every 10 min | snapshot-postgres-wal.sh |
| hara-validator-snapshot (v1..v4) | 03:00/15/30/45 | snapshot-validator.sh |
| hara-drill-snapshot | Sun 05:00 | pitr-restore-drill.sh; snapshot-restore-drill.sh |

All uploads use **chunked multipart** (`--s3-upload-cutoff 16Mi --s3-chunk-size 16Mi`) — Nevacloud S3 rejects large single-PUT.

---

## 6. Compose projects (post-migration — no `-p` needed)

| Stack | Project | Volumes |
|---|---|---|
| postgres + redis | `hara-registry-data` | `hara-registry-data_{postgres-data,redis-data,postgres-wal-archive}` |
| minio | `hara-registry-minio` | `hara-registry-minio_minio-data` |
| console | `hara-console` | — |

Pre-migration `hara-ledger-*` volumes were **deleted** this session. Migration
method: `compose -p <old> down` → `docker volume create <new>` → `cp -a /from/. /to/`
(wipe target incl. dotfiles first) → `compose up -d` (file `name:` resolves).

---

## 7. Key files (this session)

**Console:**
- `console/agent/src/index.mjs` — enriched agent: duration, artifact size/age, drills; `makeMonoToIso()` (monotonic→walltime); KEY=value parse of `systemctl show`.
- `console/server/src/sources.ts` — `getBackupsReport()`, `CATEGORY`, `EXPECTED_INTERVAL_HOURS`, `DrReplication/DrFailover/DrRecovery`, `probeStandby()`.
- `console/server/src/config.ts` — `standby.{host,healthUrl,rpoMinutes}` (env `STANDBY_HOST`/`STANDBY_HEALTH_URL`/`STANDBY_RPO_MINUTES`).
- `console/server/src/index.ts` — `GET /api/backups` route.
- `console/server/src/metrics.ts` — backup anomalies (failed/overdue/never/agent-down).
- `console/src/lib/api.ts` — `fetchBackups()`, `fmtBytes`, `fmtDuration`, DR types.
- `console/src/App.tsx` — `BackupsScreen` (5 DR sections), `CategoryPanel`, `KV`, `BackupJobRow`.

**Ops:**
- `deploy/ops/standby-bootstrap.sh` — NEW: sleeping-standby wake (restore base + replay WAL from S3 → promote; operator cutover printed).
- `deploy/ops/install-backup-timers.sh` — `drill` role + 755 exec bit.
- `deploy/ops/pitr-restore-drill.sh` — GUC-copy fix (recovery GUCs ≥ primary) + drill-result writer.
- `deploy/ops/snapshot-restore-drill.sh` — drill-result writer.
- `deploy/ops/snapshot-postgres.sh`, `vault-raft-snapshot.sh` — multipart + retention fixes.
- `deploy/ops/RECOVERY.md`, `DEPLOY-BACKUP-RECOVERY.md` — migration notes, `-d hara_indexer`, explicit-roles note.

**Compose:** `deploy/data/docker-compose.yml` (PITR), `deploy/data/docker-compose.minio.yml` (name).

**On-host gitignored:** `deploy/ops/backup.env`, `deploy/services/.env` (copilot key + future Nevacloud/standby creds), per-validator `rclone.conf`, `ops/secrets.txt`.

---

## 8. Constraints & gotchas (carry forward — NEW this session in bold)

- **`systemctl show --value` does NOT preserve requested `--property` order** — parse `KEY=value` pairs, never positionally.
- **Derive wall-clock from systemd monotonic timestamps** via `process.hrtime` (same CLOCK_MONOTONIC origin) — never parse locale strings like `"… WIB"` (JS `Date` can't).
- **PITR recovery cluster GUCs must be ≥ primary** (`max_connections=300`, etc.) or replay aborts ("insufficient parameter settings").
- **Compose project-name landmine:** running `docker compose up` whose file `name:` ≠ the live project orphans data. Always check `com.docker.compose.project` before recreating.
- **hara-stateful `hostname -s` = `localhost`** → breaks role auto-detect; pass roles explicitly.
- **BASH apostrophe pitfall in commit/PR messages:** `git commit -m @'…stateful's…'` breaks on the apostrophe. Use `git commit -F <file>` / `gh pr create --body-file <file>` for any message with apostrophes.
- **Branch protection requires 1 review** on `main`; this session's PRs (#36–#44) were admin-bypassed with operator authorization — **candidates for retro-review**.
- **Same-host = container name, cross-host = mesh IP**; ufw guards host procs (agents :8911) but Docker-published ports bypass ufw (bind to wg0 IP); Nevacloud S3 needs chunked multipart; Kimi `.ai` not `.cn`.
- All state-4/5/6 chain constraints hold (gasPrice 0, chainId 131216, legacy txs, QBFT 3/4, Vault unseal 3/5).

---

## 9. Coding conventions

- Bash: `set -euo pipefail`; `${VAR:?msg}`; avoid apostrophes in heredoc-less strings; single-file bind-mount inode trap; any backup that stops a validator MUST `trap … EXIT` restart it.
- Console API/agent: ESM, `tsx` for API (run, not built), **agent stays dependency-free** (`node:http`/`node:fs` only). Each `/api/overview` source wrapped so one failure degrades gracefully.
- Metrics: allowlisted named series only — never expose arbitrary PromQL.
- Propose-only: console builds + audits commands, never executes privileged actions.
- Per-host deploy: **selective `git checkout origin/main -- <paths>`** (never a full pull — on-host repos carry dirty config; HEAD is intentionally frozen behind).
- Commit/PR messages with apostrophes → use `-F`/`--body-file` (see §8).

---

## 10. Unresolved / open items (priority order)

1. **🔴 Rotate leaked creds (still #1):** Vault root token, GitHub PAT, Kimi key. Operator-only (agent gated from prod secret stores).
2. **Phase 2 — sleeping replica (in progress):** needs (a) Nevacloud API docs + creds, (b) a provisioned standby VPS, then (c) wire power-on/provision automation + console Failover panel via `STANDBY_HOST`/`STANDBY_HEALTH_URL`, and (d) test `standby-bootstrap.sh` end-to-end. `standby-bootstrap.sh` is merged + ready.
3. **PITR §7 acceptance:** confirm the first overnight nightly cycle landed fresh off-host objects + `failed_count`=0 + `/wal-archive` not growing (the night of 2026-06-03).
4. **Retro-review PRs #36–#44** (admin-merged past the review gate).
5. **Agent artifact size for WAL/Vault** (null today) — add their dirs to `ARTIFACT_DIRS` if wanted.
6. **Real alerting:** Alertmanager → Slack/PagerDuty/email (still stdout-only).
7. **Admin multisig (Gnosis Safe)** → unlocks console P2 governance.
8. Carried from state-5/6: Vault metrics charts (operator restart+unseal), new-box hardening, validator RAM 8→16 GB, prod image rebuild under `hara-registry-*`, node_exporter, console P2/P5, JS bundle >500 KB code-split, fix hara-stateful hostname.

---

## 11. PRs merged this session (all on `main`)

| PR | Summary |
|---|---|
| #36 | Backup multipart upload (postgres+vault) + Strata design assets |
| #37 | `install-backup-timers.sh` +x bit |
| #38 | PITR drill `max_connections` GUC fix + runbook corrections |
| #39 | Runbook docs: completed `hara-registry-*` migration |
| #40 | Console Backups & DR monitoring (agent duration/size, `/api/backups`) |
| #41 | Agent oneshot duration/lastRun fix (`--value` ordering + service-exit fallback) |
| #42 | state-6 handoff |
| #43 | Console DR categorization (5 pillars) + periodic recovery drills |
| #44 | `standby-bootstrap.sh` (sleeping-standby wake from S3 PITR) |

---

## 12. Next priorities (ordered)

0. **Rotate the 3 exposed creds** (§10.1) — operator-only.
1. **Phase 2 sleeping replica** — supply Nevacloud API creds/docs + provision a standby → I wire power automation + Failover panel + test `standby-bootstrap.sh`.
2. **Confirm PITR nightly acceptance** (§10.3) — quick morning check.
3. **Real alerting** (Alertmanager routing) — high ops value.
4. **Admin multisig** → console P2.
5. Hardening, validator RAM, prod image rebuild, node_exporter, hostname fix.

**Warm-start:** chain + console healthy; PITR archiving live (`failed_count=0`);
backups monitor live with all 5 DR pillars + passing recovery drills; project
migration clean. The console (`https://console.platform.haratrust.io`) →
**Backups & DR** is the DR front door. Read this file + state-6. Top open item:
**credential rotation**; biggest in-flight effort: **the sleeping replica
(Phase 2), blocked on Nevacloud API access**.
