# Hara Registry — Session State Handoff #6 (2026-06-03)

Carries forward from `hara-registry-state-5.md` (read that for the console build,
metrics exporters, and the 2026-06-02/03 chain-halt incident). This session
**deployed the PITR backup tier to production**, **migrated the data/minio
Compose projects to `hara-registry-*`**, and **built + shipped a Backups & DR
monitoring screen** in the Strata Console. Everything in state-5 still holds
unless noted below.

---

## 0. TL;DR — what happened this session

1. **PITR backup tier deployed to prod** (`hara-stateful`). Postgres recreated with
   `archive_mode=on` + WAL archiving; full 6-timer suite installed (basebackup
   01:30, postgres dump 02:00, redis 02:30, minio 02:45, vault 04:00, WAL every
   10 min); every job dry-run lands an off-host object; **PITR restore drill
   PASSES**. (PR #33/#35 code was already merged but had never run live.)
2. **Compose project rename done** — live stacks migrated `hara-ledger-data` →
   **`hara-registry-data`** (postgres+redis) and `hara-ledger-minio` →
   **`hara-registry-minio`** (minio), by volume-copy migration. Data intact, all
   services reconnected.
3. **Console "Backups & DR" monitoring** built + deployed live: per-job health
   (ok/failed/overdue/never), run duration, artifact size, fleet summary, and
   dedicated backup alerts.
4. **3 real bugs caught by running things live** (the docs were "syntax-validated
   only"): the Compose project-name data-loss landmine, the PITR drill
   `max_connections` abort, and the agent `systemctl show --value` ordering bug.
5. **PRs #36–#41 merged** (all admin-merged past the 1-review gate per operator
   authorization — candidates for retro-review).

---

## 1. PITR backup tier — now LIVE on hara-stateful

Deployed per `deploy/ops/DEPLOY-BACKUP-RECOVERY.md`. State:

| Job | Timer | Cadence | Verified |
|---|---|---|---|
| Postgres logical dump | `hara-postgres-snapshot` | 02:00 | ✓ (pre-existing) |
| Postgres base backup | `hara-postgres-basebackup-snapshot` | 01:30 | ✓ dry-run, ~270 MB off-host |
| Postgres WAL (PITR) | `hara-postgres-wal-snapshot` | every 10 min | ✓ shipping; `failed_count=0` |
| Redis RDB | `hara-redis-snapshot` | 02:30 | ✓ |
| MinIO objects | `hara-minio-snapshot` | 02:45 | ✓ |
| Vault Raft | `hara-vault-snapshot` | 04:00 | ✓ (pre-existing) |
| Validator chain-data | `hara-validator-snapshot` (v1–v4) | staggered 03:xx | ✓ (pre-existing) |

- **Archiving:** `archive_mode=on`, `archive_timeout=5min`, `wal_level=replica`,
  `max_wal_senders=10`; `postgres-wal-archive` volume + `postgres-archive-init`
  sidecar (chowns it to uid 70). `pg_stat_archiver.failed_count=0`.
- **PITR drill** (`deploy/ops/pitr-restore-drill.sh`) passes — base + WAL replay
  reconstructs a post-base sentinel.
- **Gotcha (fixed):** the drill's recovery side-cluster must set
  `max_connections` (and other postmaster GUCs) ≥ the primary's 300, else WAL
  replay aborts with "recovery aborted because of insufficient parameter
  settings". The drill now copies the live GUCs across.
- **Hostname quirk:** `hostname -s` on hara-stateful is `localhost`, so
  `install-backup-timers.sh` auto-detect fails — pass roles explicitly:
  `sudo ./deploy/ops/install-backup-timers.sh vault postgres postgres-basebackup postgres-wal redis minio`.
- Acceptance still wants **one clean nightly cycle** (timers first auto-fire the
  night of 2026-06-03) + `failed_count` still 0 the next morning (§7 of the runbook).

---

## 2. Compose project migration — `hara-ledger-*` → `hara-registry-*`

The live data + minio stacks had been running under the **old** project names
(pre-rename) while the compose files declared `hara-registry-*`. Running
`docker compose up` without `-p` would have created empty `hara-registry-*`
projects and **orphaned the live data** — a real landmine.

Migrated by: `docker compose -p <old> ... down` → `docker volume create
hara-registry-*_<vol>` → `cp -a` each named volume old→new → `docker compose -f
... up -d` (no `-p`, so the file `name:` resolves). Verified data intact, mesh
IPs unchanged (10.42.0.30/31/42), all downstream services reconnected.

**Now:**
- postgres + redis → project **`hara-registry-data`** (volumes
  `hara-registry-data_postgres-data`, `_redis-data`, `_postgres-wal-archive`)
- minio → project **`hara-registry-minio`** (volume `hara-registry-minio_minio-data`)
- console → project `hara-console` (unchanged; already matched)

**`docker compose` commands no longer need `-p`.** Runbooks updated (RECOVERY.md,
DEPLOY-BACKUP-RECOVERY.md).

**⚠ Pending cleanup:** the pre-migration volumes still exist (orphaned, ~3.4 GB):
`hara-ledger-data_postgres-data`, `_redis-data`, `_postgres-wal-archive`,
`hara-ledger-minio_minio-data`. Kept as a rollback safety net; **remove with
`docker volume rm` once confident** (operator-gated — agent is blocked from
deleting prod data volumes).

---

## 3. Strata Console — Backups & DR monitoring (NEW)

Live at `https://console.platform.haratrust.io` → **Backups & DR**.

- **Agent** (`console/agent/src/index.mjs`, still dep-free): per snapshot service
  reports `result`, `exitStatus`, **`durationSec`**, `activeState`, and the newest
  local **artifact size + mtime** (`/var/backups/hara/*`). `lastRun` = newer of
  the timer's last-trigger and the service's last exit (so manual / pre-first-fire
  runs aren't shown as "never").
- **API** `GET /api/backups` (`console/server/src/sources.ts → getBackupsReport`):
  per-job **health** = ok / failed / overdue / never, computed vs expected cadence
  (WAL 10 min, others 24 h, 1.3× grace), + fleet summary (healthy / failed /
  overdue / oldest-success age). Backwards-compatible.
- **Alerts** (`/api/anomalies`): backups now split into failed (critical),
  **overdue** (warn — the silently-stopped-timer case), never-run (info), and
  agent-unreachable (warn).
- **Web** (`console/src/App.tsx` `BackupsScreen`): summary header + worst-first
  per-job rows (health pill · last/next · cadence · duration · size) + dedicated
  Backup-alerts panel.

**Agent gotcha (fixed):** `systemctl show --value` does **not** preserve the
requested `--property` order — it uses systemd's internal order. Parse `KEY=value`
pairs, never positionally. Duration is from `ExecMain*TimestampMonotonic` (µs
since boot); the same CLOCK_MONOTONIC origin (`process.hrtime`) converts a
monotonic stamp to wall-clock without locale/TZ parsing.

**Deploying the console:** sync `console/` + compose from origin on
hara-stateless-2, `docker compose -f deploy/services/docker-compose.console.yml
--env-file deploy/services/.env up -d --build`; for the agent, on each of the 5
agent hosts `git checkout origin/main -- console/agent/src/index.mjs && sudo
systemctl restart hara-console-agent`.

---

## 4. PRs merged this session

| PR | What |
|---|---|
| #36 | Backup multipart upload fix (postgres+vault) + Strata design assets committed |
| #37 | `install-backup-timers.sh` +x bit |
| #38 | PITR drill `max_connections` fix + runbook corrections (interim `-p` notes) |
| #39 | Runbook docs reflect completed `hara-registry-*` migration |
| #40 | Console Backups & DR monitoring feature |
| #41 | Agent oneshot duration/lastRun fix (`--value` ordering + service-exit fallback) |

All admin-merged (branch protection requires 1 review; bypassed with operator
authorization). **Worth a retro-review.**

---

## 5. Open items (priority order)

1. **🔴 Rotate leaked creds (still #1):** Vault root token, GitHub PAT, Kimi key
   (`deploy/services/.env`). Carried from state-5 §8.1.
2. **Remove pre-migration volumes** (§2) once confident — `docker volume rm` the 4
   `hara-ledger-*` volumes on hara-stateful.
3. **PITR §7 acceptance:** next morning, confirm fresh overnight objects in every
   bucket + `failed_count` still 0 + `/wal-archive` not growing unbounded.
4. **Console artifact size for WAL/Vault:** `durationSec` works for all; artifact
   *size* is null for `hara-postgres-wal` (continuous) and `hara-vault` (writes to
   `./snapshots`, not `/var/backups/hara`) — add those dirs to the agent's
   `ARTIFACT_DIRS` map if you want sizes there.
5. **Real alerting** (Alertmanager → Slack/PagerDuty/email) — still stdout-only.
6. **Admin multisig (Gnosis Safe)** → unlocks console P2 governance.
7. Carried from state-5: Vault metrics charts (needs operator restart+unseal),
   new-box hardening, validator RAM 8→16 GB, prod image rebuild under
   `hara-registry-*`, node_exporter, console P2/P5, JS bundle code-split.

---

## 6. Constraints & gotchas added this session (carry forward)

- **Compose project name = the file's `name:`** now matches the live stacks
  (`hara-registry-data` / `-minio`); do **not** pass `-p hara-ledger-data` anymore.
- **`docker compose up` without `-p` on a renamed stack orphans data** if the
  file `name:` doesn't match the running project — always check
  `docker inspect <c> --format '{{index .Config.Labels "com.docker.compose.project"}}'`
  before recreating.
- **Volume migration** = down → `docker volume create` new → `cp -a /from/. /to/`
  (preserves uid/perms) → up. Wipe target fully (incl. dotfiles like
  `.minio.sys`) before re-copying, or counts drift.
- **PITR recovery** needs the side cluster's postmaster GUCs ≥ primary's.
- **`systemctl show --value`** ignores requested property order — parse `KEY=value`.
- **hara-stateful `hostname -s` = `localhost`** — breaks role auto-detection in
  ops scripts; pass roles explicitly. (Fixing the hostname is a clean follow-up.)
- All state-4/5 constraints still hold (same-host=container name / cross-host=mesh
  IP; ufw vs Docker; Nevacloud S3 multipart; QBFT 3/4; Vault unseal 3/5; gasPrice
  0; chainId 131216).

---

## 7. Warm-start

Chain + console healthy; PITR archiving live (`failed_count=0`); all data verified
intact through the project migration; backups monitor live and accurate. Read
`hara-registry-state-5.md` then this file. The console
(`https://console.platform.haratrust.io`) Backups & DR screen is the front door
for backup health. Top open item remains **credential rotation** (§5.1).
