# Hara Registry — Session State Handoff #5 (2026-06-02/03)

Carries forward from `hara-registry-state-4.md` (read that for the chain/migration
history). This session built the **Strata Console** (monitoring + ops + AI), enabled
the metrics exporters, finished the backup timers, refreshed the docs, and resolved
a **production chain-halt incident**. Everything in state-4 still holds unless noted.

---

## 0. TL;DR — what happened this session

1. **Backups finished + verified.** `install-backup-timers.sh` (role-aware) installed on all hosts; non-root `vault-snapshot` AppRole minted; Vault Raft snapshot verified off-host. Postgres 02:00, validators 03:01/15/31/45, vault 04:00 (WIB).
2. **CI gates enforced.** `contracts-gate / services-gate / slither-gate / echidna-gate / console-gate` now required on `main` (+ `Gitleaks`, `Analyze (actions)`, `Analyze (javascript-typescript)`).
3. **hara-xchange onboarded.** `doc/hara-xchange-deploy-guide.md` + a dedicated funded deployer (`0xFB14…`, 10 HARA). Hit + documented the **zero-balance tx-skip** gotcha.
4. **Docs refreshed** to the split topology (deploy README, wireguard README, nevacloud-runbook §1, integration manual §3).
5. **Strata Console built end-to-end** (P0 monitoring → P1 propose-only ops → Insights P1–P3 → P4 Kimi copilot → help + roadmap) and **deployed live** at `https://console.platform.haratrust.io`.
6. **Metrics exporters enabled** (Besu + HAProxy) via socat sidecars — **no restarts**; Prometheus retargeted to mesh IPs.
7. **INCIDENT: chain halted ~7h** (validator-snapshot script bug stopped all 4 validators and didn't restart them). Found via the console, recovered, root-caused, fixed.

---

## 1. NEW components this session (added to the state-4 topology)

| Component | Where | Notes |
|---|---|---|
| `hara-console-api` | container on **hara-stateless-2** (`hara-platform` bridge) | read-only aggregator + propose-only ops + insights + copilot. Port 8910 (not host-published; Caddy fronts it) |
| `hara-console-web` | container on **hara-stateless-2** | nginx static SPA (Vite/React) |
| `hara-console-agent.service` | systemd on **hara-stateful + hara-v1..v4** | dependency-free Node `node:http` agent on **wg0:8911**, reports that host's `hara-*-snapshot` timer status (read-only). ufw allows 8911 from `10.43.0.0/24` |
| `hara-metrics-proxy*` | socat containers on **v1..v4** (`:9545`) + **hara-rpc-1** (`:9545/9546/9547` rpc-write/read1/read2 + `:8404` haproxy) | publish already-running Besu/HAProxy metrics on the host's wg0 IP so Prometheus can scrape cross-host. `alpine/socat`, `--restart unless-stopped` |
| Caddy `console.platform.haratrust.io` site | edge Caddy on .25 | basic_auth (user `hara`, pw in `ops/secrets.txt`), `/api/*`→console-api, `/*`→console-web. **DNS A → 103.169.206.239 already set.** |
| Prometheus (retargeted) | hara-prometheus on .25 | scrapes besu-validators `10.43.0.11-14:9545`, rpc `10.43.0.21:9545/9546/9547`, haproxy `10.43.0.21:8404`, indexer/blockscout by container name. All targets UP |

**Public URL added:** `https://console.platform.haratrust.io` (basic_auth, will move to Numira dSSO).

**On-host repos:** all host repo git remotes renamed `hara-ledger`→`hara-registry`; the `console/` tree + updated ops scripts pulled onto hosts via **selective** `git checkout origin/main -- <paths>` (so on-host dirty config files were never clobbered). On-host dir is still `/opt/hara/hara-ledger`.

---

## 2. Strata Console — architecture

```
browser ──HTTPS──▶ Caddy (console.platform.haratrust.io, basic_auth)
                     ├─ /api/*  ▶ hara-console-api:8910 (Fastify, read-only + propose-only)
                     └─ /*      ▶ hara-console-web:80   (nginx static SPA)

hara-console-api (on .25 hara-platform bridge) reads:
  • Besu RPC   → http://10.43.0.21:8545           (mesh, cross-host)
  • Vault      → http://10.43.0.40:8200            (mesh, cross-host)
  • Prometheus → http://hara-prometheus:9090       (SAME host → container name)
  • Alertmanager→ http://hara-alertmanager:9093     (SAME host → container name)
  • Indexer    → http://hara-indexer:9100/metrics  (SAME host → container name)
  • Backups    → http://10.43.0.{40,11,12,13,14}:8911/backups  (the agents, mesh)
  • Kimi/Moonshot → https://api.moonshot.ai/v1     (copilot, egress)
```

**Golden rule learned the hard way:** *same-host services are reached by container name on the per-host `hara-platform` bridge; cross-host services by their `10.43.0.x` mesh IP.* (Their host ports often bind `127.0.0.1` only.)

**Repo layout:** `console/` (web SPA), `console/server/` (Fastify API), `console/agent/` (dep-free backups agent). Stays in **this public repo** for now (decision: extract to a private repo only if/when it gains real signing power at P2).

**Security model:** the console is **read-only / propose-only** — it never holds a signing key and never executes privileged actions. It *builds* the exact `cast`/`ssh` command for the operator to run, and logs it to an append-only audit. (P2 will add Vault-Transit / Gnosis-Safe signing + Numira dSSO auth.)

---

## 3. Stack (additions this session)

| Layer | Choice |
|---|---|
| Console web | Vite + React 18 + TypeScript + Tailwind (Strata theme from `doc/design`) + Recharts; served by nginx |
| Console API | Node 22 + Fastify 5 + `tsx` (run, not compiled); deps: `fastify`, `@fastify/cors`, `tsx` |
| Console agent | **zero npm deps** — plain `node:http` (`console/agent/src/index.mjs`); runs on distro Node 18 |
| Metrics proxy | `alpine/socat` sidecars |
| Copilot LLM | **Kimi / Moonshot** (OpenAI-compatible), default model **`moonshot-v1-128k`** (~5s; `kimi-k2.6` available but ~60s reasoning), base `https://api.moonshot.ai/v1` |
| Charts source | Prometheus (besu/haproxy now scraped; indexer/blockscout already were) |

Branding = **"Strata"** mark from `doc/design/` (teal #2BD4C0 → blue #3B6BFF → indigo #5A45E0 gradient, amber core #FFC56E/#F39B24, ink #070B18/#0C1226/#101A38, Sora + Inter). `doc/design/README.txt` documents the asset set.

---

## 4. Console API (`hara-console-api`, base path `/api`)

All **read-only** except the propose/silence endpoints (which still don't execute on-chain):

- `GET /healthz`
- `GET /api/overview` → `{chain, validators, accounts, rpcTier, services, vault, alerts, backups}` — each a `{available:true,data}|{available:false,error}` section (one dead source never blanks the page).
- `GET /api/metrics/series` · `GET /api/metrics/range?series=<name>&minutes=<n>` — **allowlisted** PromQL only (`metrics.ts SERIES`): blockRate, chainHeight, indexerLag, eventRate, batchMs, errorRate, eventloopP90, indexerMem, alertsFiring, validatorPeers/Height/InSync, txpool, rpcReqRate/Sessions/5xx/Peers.
- `GET /api/anomalies` → threshold signals (chain-stall, indexer lag/errors, failed backups, stale validators, firing alerts), each with `at` timestamp.
- `GET /api/insights` → `{baselines (z-score), forecasts (predict_linear)+backup-freshness, slo, cacheHitPct, fairness, capacity (vs 45-mo projection), recommendations}`.
- `POST /api/propose/:kind` (`fund|register|grantRole|revokeRole|onboard|snapshot`) → builds the exact command + risk + notes, **audits it**, never runs it. `GET /api/audit` (JSONL on `console-audit` volume).
- `GET /api/alerts/silences` · `POST /api/alerts/silence {alertname,hours,comment}` · `DELETE /api/alerts/silence/:id` → Alertmanager silences (ack/ignore). Prometheus alerts **auto-resolve**; there is no manual "mark solved".
- `GET /api/copilot/status` · `POST /api/copilot {question}` → grounded read-only Kimi Q&A (503 if `COPILOT_API_KEY` unset).

**Backups agent** (`hara-console-agent`, wg0:8911): `GET /healthz`, `GET /backups` → `{host, generatedAt, timers:[{unit,service,nextRun,lastRun,result,exitStatus}]}`.

---

## 5. Console env / config (per-host, gitignored)

`deploy/services/docker-compose.console.yml` reads from `deploy/services/.env` (gitignored, 0600) on hara-stateless-2:
- `CONSOLE_COPILOT_API_KEY=<Kimi key>` (the "hara-xchange test" key — **⚠ rotate; it's in chat history**)
- `CONSOLE_COPILOT_BASE_URL=https://api.moonshot.ai/v1` (the `.ai`, NOT `.cn`)
- `CONSOLE_COPILOT_MODEL=moonshot-v1-128k` (fast default)
- compose defaults wire the same-host obs by container name + cross-host by mesh IP; `BACKUPS_AGENT_URLS` lists the 5 agents; `AUDIT_PATH=/data/audit.jsonl` (volume `console-audit`).
- Caddy basic-auth password stored in `ops/secrets.txt` ("Strata Console basic-auth").

---

## 6. Intelligence roadmap status (`doc/registry-console-intelligence-roadmap.md`)

- **P0 threshold anomalies — LIVE** (banner).
- **P1 reliability — LIVE**: z-score baselining, predict_linear forecasts, backup-freshness, RPC SLO/error-budget.
- **P2 optimisation — LIVE**: cache hit-rate, validator fairness, indexer batch hints.
- **P3 capacity/milestones — LIVE**: throughput vs 361 TPS ceiling + 45-month projection (Insights → Capacity & growth). *Disk-fill forecast still needs node_exporter (not scraped).*
- **P4 operator copilot — LIVE** (Kimi, read-only, grounded; points to Operations).
- **Ahead:** P5 supply-chain intelligence (custody-DAG analytics, fraud/mass-balance, ESG); ML-anomaly → real Alertmanager routing.

---

## 7. INCIDENT 2026-06-03 — chain halted ~7h (resolved)

**Symptom:** console showed critical "chain not advancing" + `ValidatorMetricsMissing`. Chain stalled at block 284307; all 4 validator containers `Exited (143)` ~7h prior (at the snapshot timer times).
**Root cause:** `snapshot-validator.sh` did `docker stop` then `tar`'d the **root-owned** Besu volume as unprivileged `hara` → tar failed → `set -e` exited **before `docker start`** → validators stayed down → QBFT lost quorum. (An earlier `/var/backups/hara` chown let the script get *past* mkdir to the stop, converting a harmless failure into a halt.)
**Fixes (merged + deployed to v1–v4):** (1) `trap … EXIT` guarantees restart no matter how the script exits; (2) `sudo tar` to read the root-owned volume; (3) **Nevacloud S3 rejects large single-PUT** → force chunked multipart (`--s3-upload-cutoff 16Mi --s3-chunk-size 16Mi`). Recovered by `docker start` on all 4; verified all backups `success`, all anomalies/alerts cleared.

---

## 8. Unresolved / open items (priority order)

1. **🔴 Rotate leaked/exposed creds (do first):** Vault root token + GitHub PAT (flagged since state-4) **and** the **Kimi API key** (now in chat + `deploy/services/.env`).
2. **Apply multipart fix to `snapshot-postgres.sh` + `vault-raft-snapshot.sh`** before those dumps outgrow Nevacloud's single-PUT limit (validator one is fixed; these will hit it as they grow).
3. **Vault metrics charts:** `vault.hcl` has `unauthenticated_metrics_access=true` **staged but not applied** — needs an operator Vault **restart + re-unseal** (agent is blocked from reading unseal shares). Then add the Prometheus `vault` job + Vault charts.
4. **New-box hardening:** ufw baseline + SSH `PermitRootLogin no`/`PasswordAuthentication no` (still deferred; targeted ufw allows for 8911 added).
5. **Admin multisig (Gnosis Safe)** — also the prerequisite for console **P2** governance signing.
6. **Real alerting:** Alertmanager → Slack/PagerDuty/email (still stdout-only).
7. **Validator RAM 8→16 GB** + **prod image rebuild** under `hara-registry-*` (on-host dir/images still `hara-ledger`).
8. **node_exporter** on hosts → true disk-fill forecasts (P3 uses chain-growth proxy).
9. **Console P2** (Vault-Transit/Gnosis-Safe signing + Numira dSSO auth) and **P5** (supply-chain intelligence).
10. Minor: console JS bundle >500 KB (code-split); `hara-stateful` hostname is `localhost` (shows as `@ localhost` in backups); trace-api `/v1/holders` case-sensitivity (from state-4).

**Done this session (was open):** backup timers + restore drill; CI required checks; exporters; the whole console.

---

## 9. Constraints & gotchas (carry forward)

- **same-host = container name, cross-host = mesh IP** (services bind 127.0.0.1 / per-host bridge).
- **ufw vs Docker:** ufw guards **host** processes (the agents on :8911); Docker-published ports **bypass** ufw — bind them to the wg0 IP, not 0.0.0.0.
- **Nevacloud S3 (`s3.nevaobjects.id`):** large single-PUT objects fail with an **HTML error** → use **chunked multipart**. The `.ai` Moonshot endpoint works for the Kimi key, `.cn` 401s.
- **Any backup that stops a validator MUST guarantee restart** (trap) — and QBFT needs 3/4, so snapshots are staggered one-at-a-time.
- **Besu metrics were already enabled** (`--metrics-enabled :9545`) — they just weren't published on the mesh; socat sidecars expose them without restarting Besu.
- **Kimi:** `kimi-k2.6` is a *reasoning* model — slow (~60s), needs `max_tokens≥4000` (reasoning_content + content) and rejects `temperature≠1`. `moonshot-v1-128k` is the fast (~5s) default. LLM call timeout must be ≥120s.
- **Agent gating observed (carry forward):** the safety classifier blocks the agent from — reading prod secret stores (Vault unseal shares, console basic-auth pw), **persisting secrets into config/inspectable artifacts** (prometheus.yml, container env), **stopping live validators**, and recreating prod containers — each needs explicit operator authorization or is operator-only. Reading a user-pasted key or a gitignored `.env`/`secrets.txt` under explicit "set this" instruction was allowed. SSH read/scp/install allowed once explicitly authorized.
- All state-4 chain constraints still hold (gasPrice 0, chainId 131216, legacy txs, QBFT 3/4, Vault unseal 3/5).

---

## 10. Coding conventions (additions)

- Console API/agent: ESM, `tsx` for the API (run, not built), **dep-free** for the agent. Each `/api/overview` source wrapped so one failure degrades gracefully.
- Metrics: **allowlisted named series** only — never expose arbitrary PromQL through the console.
- Propose-only: console builds commands, never executes; everything privileged is audited.
- Charts: self-fetching Recharts components (`<TimeSeries series=…>`), 30s poll.
- Per-host deploy: **selective `git checkout origin/main -- <paths>`** (never a full pull — on-host repos have local dirty config).
- All the state-4 conventions still apply (`set -euo pipefail`, `${VAR:?msg}` no `}`/apostrophes, single-file bind-mount inode trap, `cast wallet new` returns an array, etc.).

---

## 11. Key files added/changed this session

**Console (new):** `console/` (web: `src/App.tsx`, `components/{Panel,StrataMark,Operations,AuditLog,TimeSeries}.tsx`, `lib/api.ts`, `hooks/useOverview.ts`, Tailwind/Vite config, `Dockerfile`, `nginx.conf`); `console/server/` (`src/{index,config,rpc,sources,proposals,audit,metrics,insights,copilot,contracts,alerts}.ts`, `Dockerfile`); `console/agent/src/index.mjs`.
**Deploy (new/changed):** `deploy/services/docker-compose.console.yml`; `deploy/edge/Caddyfile` (console site, on-host); `deploy/platform/prometheus/prometheus.yml` (mesh targets); `deploy/platform/vault/vault.hcl` (unauth metrics, staged); `.github/workflows/console.yml`.
**Ops (new/changed):** `deploy/ops/install-backup-timers.sh` (+/var/backups/hara chown), `install-console-agent.sh`, `install-metrics-proxies.sh`, `vault-approle-bootstrap.sh` (+vault-snapshot AppRole), `vault-raft-snapshot.sh` (AppRole login), **`snapshot-validator.sh` (trap + sudo tar + multipart — the incident fix)**.
**Docs (new/changed):** `doc/hara-xchange-deploy-guide.md`, `doc/registry-console-plan.md`, `doc/registry-console-intelligence-roadmap.md`, this file; refreshed `deploy/README.md`, `deploy/networks/wireguard/README.md`, `deploy/nevacloud-runbook.md`, `doc/hara-registry integration manual.md`, `hara-registry-state-4.md`.
**On-host only (gitignored):** `deploy/services/.env` (copilot key), `ops/secrets.txt` (console basic-auth + hara-xchange deployer + vault-snapshot AppRole), per-host `backup.env`, rclone.conf on validators; `~/hara-ops/hara-xchange-deployer.json`.

---

## 12. Next priorities (ordered)

0. **Rotate the 3 exposed creds** (Vault root, GitHub PAT, Kimi key) — §8.1.
1. **Multipart-fix the postgres/vault snapshot scripts** (§8.2) — quick, prevents a future repeat of the upload failure.
2. **Vault metrics** (operator restart+unseal → I wire the job + charts) — §8.3.
3. **Real alerting** (Alertmanager routing) — high ops value; also unlocks ML-anomaly routing.
4. **Admin multisig** → enables console **P2** governance.
5. Hardening, validator RAM, prod image rebuild, node_exporter — §8.4/7/8.
6. **Console P2 / P5** when ready.

**Warm-start:** chain + console are healthy and live; all alerts/anomalies clear as of 2026-06-03. The console (`https://console.platform.haratrust.io`) is the front door — its **Help & Guide** explains every panel, and **Insights**/**Copilot** summarise health. Read `doc/registry-console-plan.md` + this file first.
