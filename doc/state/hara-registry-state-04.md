# Hara Registry — Session State Handoff #4 (2026-06-01)

Carries forward from `haraledger-state-3.md` (the migration was *planned* there; this
session *executed* it, renamed the project, validated stress, declared production-final,
and reset the traceability viewer). **"HaraLedger" / "hara-ledger" in older docs = this
same system, now Hara Registry.**

---

## 0. TL;DR — what happened this session

1. **Renamed** hara-ledger → **Hara Registry** (repo, images, compose, docs). Public **domains kept** (`*.ledger.haratrust.io`); running prod images + on-host `/opt/hara/hara-ledger` paths **unchanged** (deferred rebuild).
2. **Executed the Phase-1 RPC-host migration** end-to-end over SSH: stood up `hara-rpc-1` (RPC tier) + `hara-stateless-2` (services/obs/edge), WG-onboarded both, cut over (DNS/Caddy), and **destroyed old `hara-stateless`**. Partner (hara-did) migrated to `10.43.0.21`.
3. **Stress test validated:** 200×500 = **99,800 transfers, 361 TPS, 400/400 `status=1`** (real work). The first 527/648-TPS "passes" were **INVALID** (all reverted — wrong deployer). Lesson logged.
4. **Production-final declared** — `PRODUCTION-READINESS.md` committed.
5. **Backups:** Postgres automated, age-encrypted, off-host to Nevacloud S3, **restore drill passed**.
6. **CI branch protection** applied; **secrets** inventoried + restructured; **tech manual** written (`.md` + `.docx`).
7. **Traceability viewer reset:** wiped all ~1,800 test batches; now shows one **interconnected refinery DAG** (`scenario-refinery-dag.ts`).

---

## 1. Production topology (current)

| Host | Role | WG IP | Public IP | Specs |
|---|---|---|---|---|
| `hara-rpc-1` | RPC tier: rpc-write + 2×rpc-read + HAProxy LB (`hara-lb`) + autoheal | 10.43.0.21 | 103.169.206.237 | 8 vCPU / 23 GB / 300 GB NVMe |
| `hara-stateless-2` | services + obs + edge: signer, broadcaster, indexer, rpc-cache, Blockscout BE/FE, Prom/Graf/Loki/Tempo/Alertmanager/alert-sink, Caddy | 10.43.0.25 | **103.169.206.239 (DNS target)** | 6 vCPU / 15 GB / 200 GB NVMe |
| `hara-stateful` | Vault Raft + Postgres + Redis + MinIO; **Postgres backup timer** | 10.43.0.40 | 103.67.244.250 | 8 vCPU / 32 GB / 1 TB |
| `hara-v1..v4` | Besu QBFT validators (RPC-HTTP **disabled**; P2P on `:30303`) | 10.43.0.11–14 | 202.155.18.234 / 103.169.206.46 / 103.169.206.127 / 160.19.166.23 | 4 vCPU / **8 GB** (bump to 16 pending) |
| `hara-did-stg` (partner) | hara-did api-gateway + anchor-oracle (NOT our SSH) | 10.43.0.50 | 103.67.244.109 | — |
| ~~`hara-stateless`~~ | **DESTROYED** (was 10.43.0.20) | — | — | — |

Full WG mesh (each host peers all others). `did-stg` peered with `hara-rpc-1` (partner applied their side). Docker bridge `hara-platform` = 10.42.0.0/24 per-host.

**SSH:** `~/.ssh/config` has aliases `hara-rpc-1`, `hara-stateless-2`, `hara-stateful`, `hara-v1..v4`, `hara-did-stg`, all `User hara` + `~/.ssh/hara_ops_ed25519`. New boxes also accept `root` via `~/.ssh/id_ed25519` (cloud-init never ran; hardening deferred).

---

## 2. Architecture

```
WG mesh 10.43.0.0/24 (cross-host) · docker bridge 10.42.0.0/24 (per-host)

validators v1..v4 (.11–.14) ──P2P:30303── hara-rpc-1 (.21)
                                              rpc-write + rpc-read×2 + HAProxy(:8545/8546) + autoheal
                                                    ▲                    ▲
                          services on hara-stateless-2 (.25) ───WG───────┘ (RPC over 10.43.0.21)
                          signer/broadcaster/indexer/rpc-cache/Blockscout/obs/Caddy
                                                    │
                          hara-stateful (.40): Vault / Postgres / Redis / MinIO
                                                    ▲
                          hara-did-stg (.50) ──WG── uses RPC @ .21 + PG pq_indexer_reader @ .40
```

- **Reads** → Caddy `/read/` → rpc-cache (local on .25) → HAProxy (.21) → rpc-read nodes.
- **Writes** → Caddy `/write/` → HAProxy (.21) → rpc-write.
- **Traceability**: indexer (on .25) reads chain via `http://10.43.0.21:8545/rpc/read`, writes Postgres on .40; trace-api served at `:9100` (host `127.0.0.1:9101`), public via `trace.` site on Caddy.

---

## 3. Stack

| Layer | Choice | Version |
|---|---|---|
| Consensus | Besu QBFT | 26.4.0, Bonsai/RocksDB, jemalloc, **`--sync-mode=FULL` pinned** |
| Mesh | WireGuard | 10.43.0.0/24 |
| Secrets | HashiCorp Vault Raft | 1.17 (5 unseal / 3 threshold) |
| DB | Postgres | 16-alpine (DBs: `hara_indexer`, `blockscout`) |
| Cache | Redis | 7-alpine (no auth, internal) |
| Object storage | MinIO | + Nevacloud S3 (`s3.nevaobjects.id`) for off-host backups |
| Edge/TLS | Caddy | 2.8-alpine (auto LE) |
| LB | HAProxy | 2.9-alpine |
| Obs | Prometheus + Grafana + Loki + Tempo + Alertmanager + alert-sink | — |
| Services | Node 22 + TS + viem + Fastify | signer, broadcaster, indexer, rpc-cache, anchor-worker, migrate |
| Contracts | Solidity 0.8.26 (Foundry) | in `contracts/` |
| PQ crypto | `@noble/post-quantum` ML-DSA-65 (FIPS 204) | anchor-worker |
| Backups | age (X25519) + zstd + rclone | nightly systemd timer |
| Watchdog | willfarrell/autoheal | 1.2.0 |

RPC besu flags (`deploy/rpc/scripts/start-rpc.sh`): `-Xms6g -Xmx6g`, vertx workerPoolSize=64, `--sync-mode=FULL`, `--sync-min-peers=2`, `--rpc-http-max-active-connections=4000`, `--rpc-http-max-batch-size=200`, `--tx-pool-max-future-by-sender=2000`, RPC APIs ETH,NET,WEB3,QBFT,DEBUG,TRACE,TXPOOL. Validators: `--block-txs-selection-max-time=8000`, RPC-HTTP disabled.

---

## 4. Public endpoints & access

| URL | Backend | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/{read,write,ws}` | rpc-cache / HAProxy | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout (+`/api/*`) | none |
| `https://trace.ledger.haratrust.io/` | DAG viewer + `/v1/*` trace-api | **HTTP Basic** (user `hara`, pass in secrets.txt §7) |
| `https://grafana.platform.haratrust.io/` | Grafana | login |

DNS at GoDaddy (TTL back to ~3600s). Caddy auto-LE; the `trace.` site + viewer file live in `deploy/edge/trace-site/` (bind-mounted `/srv/trace`) — basic_auth hash is on-host only (placeholder in repo).

---

## 5. APIs

### Chain JSON-RPC (`rpc.ledger.haratrust.io`)
Standard eth/net/web3/qbft/txpool/debug/trace. **Legacy txs, gasPrice 0, chainId 131216.** Reads→`/read/`, writes→`/write/`, WS→`/ws`. **Always verify receipts: `status:0x1`** (a mined tx can have reverted).

### Traceability REST (`trace.ledger.haratrust.io`, basic auth) — indexer `:9100`, code `services/indexer/src/trace-api.ts`
- `GET /v1/batches?limit&offset` → `{items:[{batch_id, initial_liters, first_owner, current_holder, hop_count, rspo_hash, plantation_id, production_date, minted_at, last_hop_at}]}` (ordered minted_at desc)
- `GET /v1/batches/:id` → single summary (404 if unknown)
- `GET /v1/batches/:id/hops` → `{hops:[{batch_id, liters, from_addr, to_addr, operator_addr, tx_hash, block_number, log_index, occurred_at}]}`
- `GET /v1/batches/:id/graph?aggregate=true` → `{batch, nodes[], edges[], aggregated}`. Nodes carry `isFirstOwner/isCurrentHolder/isPassThrough`, `received/sent/currentLiters`. `aggregate=true` collapses parallel A→B edges (DAG view); else one edge/transfer (linear).
- `GET /v1/holders/:address/batches` → `{address, batches[]}` (⚠ matches case-sensitively / lowercased — known quirk)
- `GET /healthz`, `GET /metrics` (Prometheus: `hara_indexer_last_indexed_block`, `hara_indexer_chain_head_block`)

### Blockscout (`explorer.ledger.haratrust.io/api/*`) — standard Blockscout v2 API. Internal-tx fetcher disabled (`INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true`).

### Anchor-worker `:9102/metrics`.

Full tech manual: **`doc/technical/hara-registry-technical-manual.md`** (+ `.docx`) — every endpoint with real example output.

---

## 6. Smart contracts (chain 131216, addresses unchanged)

| Contract | Address | Notes |
|---|---|---|
| HaraPalmOil (ERC-1155) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | `mintBatch(batchId,firstOwner,liters,rspoCertificateHash,plantationId,productionDate)` → emits `BatchMinted`; custody = `TransferSingle`; `MINTER_ROLE` |
| TraceabilityBatchRelay | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | `executeChain` (linear), `executeChainVariable`, **`executeHops(token,batchId,froms[],tos[],amounts[])`** (arbitrary DAG) |
| PQAnchorRegistry | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | ML-DSA-65 anchors; `ANCHOR_ROLE`, `KEY_ROTATOR_ROLE`. **The partner's actual usage** |
| ContractRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | name→address; `REGISTRAR_ROLE` |
| GovernanceContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | |
| AnchorRegistry (legacy ECDSA) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | compat |

Sources in `contracts/src/`. Platform admin (DEFAULT_ADMIN_ROLE) = `0x944b237097A03E1e8CdE8A0F46605506319EC329`.

---

## 7. Schemas (`hara_indexer` DB on hara-stateful)

- **`indexed_events`** (table): the raw indexed logs. Columns incl. `contract_name`, `event_name`, `decoded` (jsonb), `block_number`, `tx_hash`, `log_index`. ~Hundreds of thousands of rows.
- **`indexed_blocks`** (table): block_number, timestamp_unix, block_hash.
- **`indexer_state`** (table): single row `id=1`, `last_indexed_block`, `last_indexed_at` (the cursor).
- **`watched_contracts`** (table): `contract_address`, `name`, `from_block`, `enabled`. ABI registry at `services/indexer/src/abis.ts` keyed by name.
- **`custody_hops`** (VIEW, live): HaraPalmOil `TransferSingle` where `from != 0x0`; columns `batch_id(=decoded id), liters(=value), from_addr, to_addr, operator_addr, tx_hash, block_number, log_index, occurred_at`.
- **`batch_summary`** (VIEW, live): built from **`BatchMinted`** events LEFT JOIN custody_hops (last_hop + hop_count). **A batch only appears if its `BatchMinted` event is indexed.** These are PLAIN VIEWS (not materialized) — they reflect `indexed_events` in real time.
- **`pq_anchor_signatures`**: `commitment_hash bytea PK, algo, signer_did, anchor_tx_hash, bucket, object_key, size_bytes, created_at`. hara-did reads via PG role `pq_indexer_reader` (SELECT only).

---

## 8. Backups & DR

- **Postgres (automated, off-host, restore-verified):** systemd `hara-postgres-snapshot.{service,timer}` on hara-stateful, nightly **02:00**, runs `deploy/ops/snapshot-postgres.sh` → `pg_dump` (hara_indexer + blockscout) → zstd → **age-encrypt** → local `/var/backups/hara/postgres` (7-day retention) → **rclone upload to `nevacloud-s3:hara-backups/postgres`**. Restore drill `snapshot-restore-drill.sh` **PASSED**. age recipient `age1fcdr3qk0wuzxy0ynmzj3d28d8m8pfe489wpk6udstzcyccj7l45sjla6e3`; rclone remote `nevacloud-s3` (endpoint `https://s3.nevaobjects.id`) configured for the `hara` user on hara-stateful.
- **Vault Raft + validator timers — INSTALLED on hosts (2026-06-01, session #5).** `deploy/ops/install-backup-timers.sh` (role-aware, idempotent) was run on all hosts; `deploy/ops/backup.env` written per host (age recipient public; rclone copied to validators). Live `systemctl list-timers` confirmed: **postgres 02:00, validator v1 03:01 / v2 03:15 / v3 03:31 / v4 03:45 (±2 min RandomizedDelaySec), vault 04:00** (all WIB / UTC+7). Validators got the `nevacloud-s3` rclone remote copied from hara-stateful so off-host upload works. The non-root snapshotter is wired in code: `vault-approle-bootstrap.sh` creates policy `haraledger-snapshot` (cap = read `sys/storage/raft/snapshot` only) + AppRole `vault-snapshot`; `vault-raft-snapshot.sh` logs in via it (falls back to `VAULT_TOKEN`).
  - **Vault snapshot — COMPLETE & verified (session #5).** `vault-snapshot` AppRole minted (operator-authorized root-token read; token passed via stdin, never written to disk/args/log); creds appended to `hara-stateful:.../deploy/ops/backup.env`. **Dry-run passed end-to-end:** AppRole login → Raft snapshot → age-encrypt (55 KB) → upload; `.age` confirmed in `nevacloud-s3:hara-backups-vault`. `hara-vault-snapshot.service` result=success.
  - **Validator dry-run NOT agent-run** (classifier-gated — briefly stops a prod validator the partner depends on). Validators self-prove on the 03:xx staggered schedule; rclone remote + age recipient confirmed in place. Postgres restore drill already passed.
  - Minor housekeeping: re-running `vault-approle-bootstrap.sh` regenerated (unused) secret_ids for the validator/signer/anchor-worker roles — harmless (additive, old ones still valid); revoke stale secret_ids at next rotation if desired.

---

## 9. Security & secrets

- **`ops/secrets.txt`** (gitignored, 12 structured sections): Vault root/dev/unseal keys; platform admin key (location); anchor-worker key; Postgres/MinIO/Grafana passwords; Vault AppRoles; age key + Nevacloud S3 keys; trace-viewer basic-auth (user `hara`); GitHub PAT; Blockscout `SECRET_KEY_BASE` (verified vs prod by hash); SSH ops key; deployer keys; WG note.
- **⚠ ROTATE (leaked through this session):** Vault root token (`hvs.yBGh4…`) + GitHub PAT (`ghp_…`). Then move `secrets.txt` to a password manager.
- SSH key + `loadtest-deployer.json` hardened via `icacls`.
- **Deployer keys:** the documented `0x6A1E6cd7…570C` load-test deployer key is **LOST** (not on this laptop; it currently has **no** MINTER_ROLE so it's harmless). Replaced by `~/hara-ops/loadtest-deployer.json` = `0xc9064736…b408bf5` (priv `0x643135…`), ~10 HARA, **no standing roles**. anvil-1 `0x70997970…79C8` = genesis-funded 10,000 HARA, well-known public key (usable funder).
- **To mint for tests/demos:** `deploy/ops/minter-role.sh {check|grant|revoke} <addr>` — reads the admin key from Vault at run time (needs `VAULT_TOKEN`=root). Pattern: **grant → run → revoke**. Run BY THE OPERATOR (Vault reads are blocked for the agent).

---

## 10. CI / governance

- GitHub Actions: `codeql`, `secret-scan` (Gitleaks), `slither`, `echidna`, `contracts` (forge build+test), `services` (typecheck/build/scan/sign). **Contract/service workflows are path-filtered.**
- **Branch protection on `main`:** PR + 1 approval, linear history, no force-push/deletions, conversation resolution, required checks = **Gitleaks + CodeQL** (the always-run ones). Admins bypass (solo-safe). **TODO:** add contract/service/slither/echidna as required once they emit an always-report result.

---

## 11. Stress test results

| Run | Result |
|---|---|
| 200×500 (2026-06-01, **VALID**) | 99,800 transfers, 276.4s, **361 TPS**, 400/400 `status=0x1`, ~6.4M gas/executeChain, batches visible in viewer |
| 200×500 / 400×500 (earlier 2026-06-01) | **INVALID** — all Phase-C reverted (deployer lacked MINTER_ROLE); the "527/648 TPS" were reverts |
| Refinery DAG | 224 hops / 1 `executeHops` tx, 900 L → 10 outputs, mass-balance ✓ |

The dedicated RPC host cleared the old import-CPU wall: chunks confirmed in steady 2-block cadence, no sync flip-flops. Details in `memory:stress-test-results`.

---

## 12. Traceability viewer state

**Reset 2026-06-01:** all ~1,800 stress-test batches deleted (`DELETE FROM indexed_events WHERE contract_name='HaraPalmOil'` — 706,548 rows). Viewer now shows **only** the interconnected refinery DAG, batch **`1780302287086`** (68 nodes, 190 edges, 42 splits, 55 merges, 10 outputs, 224 hops, 900 L mass-balanced). Demo scenarios: `scenario-refinery-dag.ts` (interconnected, `executeHops`) vs `scenario-stress-200x500.ts` (linear, `executeChain`). Both default to STALE addresses — always override `TOKEN_ADDRESS=0xa513…`, `RELAY_ADDRESS=0x2279…`, `RPC_*_URL=http://10.43.0.21:8545/rpc/*`.

---

## 13. Unresolved issues / open items

| Item | Status |
|---|---|
| Rotate Vault root token + GitHub PAT | **open (do first)** — leaked in session |
| New-box hardening (ufw + SSH root/password off) | open — deferred to avoid lockout |
| Vault Raft + validator snapshot timers | **DONE (session #5)** — all timers installed on hosts; vault snapshot dry-run verified off-host (non-root AppRole). Validators self-prove on 03:xx schedule. |
| Admin multisig (Gnosis Safe) | open — single-key today |
| Real alerting (Alertmanager→Slack/PagerDuty/email) | open — stdout only |
| Validator RAM 8→16 GB | open |
| Prod image rebuild under `hara-registry-*` + rename `/opt` dir + host git remotes | open — code identity renamed, runtime not yet |
| Add contract/service CI checks to required set | **workflows done** — each now emits a stable always-reporting `*-gate` job (`contracts-gate`/`services-gate`/`slither-gate`/`echidna-gate`); pending operator adding them to branch protection (runbook Step 10) |
| trace-api `/v1/holders` case-sensitivity | minor bug |

---

## 14. Constraints

- Gas price chain-wide **0** (zeroBaseFee); block gas limit ~9 PETA (effectively unbounded).
- QBFT needs **3/4** validators; single-VPS reboot is safe, two is not.
- HAProxy: 32k concurrent, ~5k req/10s per IP.
- All txs **legacy, gasPrice 0, chainId 131216**.
- Vault must be unsealed (3/5 keys) after any restart.
- Docker bridge stays 10.42.0.0/24; container IPs unchanged.

---

## 15. Coding conventions

- Shell: `set -euo pipefail`. Compose env: `${VAR:-docker-dns-default}` (sim) overridden to WG-IP in prod `.env`.
- Image tags: `${IMAGE_REGISTRY}` prefix (`ghcr.io/imronzuhri-svg/` prod). Images **built locally** (GHCR pull denied by design → compose falls through to build).
- `BACKUP_AGE_RECIPIENT` required in backup envs.
- `cast wallet new --json` returns an ARRAY. Bash `$(())` overflows >9.2e18 wei → use python3.
- **`${VAR:?msg}` must not contain `}` or apostrophes in the message** — a `}` closes the expansion early and corrupts the variable (cost an hour this session on minter-role.sh).
- Use `git grep -lz … | xargs -0` (filenames with spaces exist under `doc/`).

---

## 16. Files added/changed this session

**New ops scripts (`deploy/ops/`):** `bootstrap-newbox.sh`, `wg-onboard-migration.sh`, `cutover-phase-c.sh`, `decommission-old-stateless.sh`, `minter-role.sh` (grant/revoke/check MINTER via Vault admin key).
**New edge:** `deploy/edge/trace-site/index.html` (DAG viewer) + Caddyfile `trace.` site + compose mount.
**Changed:** `start-rpc.sh` (`--sync-mode=FULL`), `snapshot-postgres.sh` (optional rclone + exit 0), `deploy/edge/Caddyfile` + `deploy/services/docker-compose.yml` (→10.43.0.21 split topology), repo-wide rename hara-ledger→hara-registry (64 files).
**Docs:** `PRODUCTION-READINESS.md`, `doc/hara-registry-technical-manual.{md,docx}`, `haraledger-did-rpc-migration.md`, this file.
**On-host only (gitignored):** per-role `.env` (WG-IP bindings), blockscout env, `ops/secrets.txt`.
> Note: `cutover-phase-c.sh` `REPO=` was set to `/opt/hara/hara-registry` (intentional, forward-looking) but the on-host dir is still `/opt/hara/hara-ledger` until the deferred path rename.

---

## 17. Next priorities (order)

0. **Rotate Vault root token + GitHub PAT**; `secrets.txt` → password manager.
1. **Harden new boxes** — ufw (allow 22/51820/WG-subnet + public ports; Docker bypasses ufw for published ports) + SSH `PermitRootLogin no` / `PasswordAuthentication no`. Do one box at a time, verify access.
2. **Backups round-out** — ✅ **DONE (session #5).** All timers installed + scheduled (postgres 02:00, validators 03:01/15/31/45, vault 04:00 WIB); non-root `vault-snapshot` AppRole minted; vault snapshot dry-run verified off-host to `nevacloud-s3:hara-backups-vault`. Validators self-prove on schedule (dry-run skipped to avoid stopping a prod validator).
3. **Admin multisig** (Gnosis Safe) for `0x944b237…`.
4. **Real alerting** (Alertmanager → Slack/PagerDuty/email).
5. **Validator RAM 8→16 GB** (Nevacloud panel resize; pin heap 8 GB). **Prod image rebuild** under `hara-registry-*` (recreate containers — needs a window; also rename `/opt` dir + host `git remote`s to hara-registry).
6. ✅ Always-report done — `contracts/services/slither/echidna` workflows now run on every PR and expose stable `*-gate` checks. **Remaining = operator:** add `contracts-gate`, `services-gate`, `slither-gate`, `echidna-gate` to `main` branch protection (runbook Step 10).
7. (optional) 400×500 valid stress re-run for a headline number.

---

## 18. Lessons to carry forward

1. **Docker single-file bind-mount = inode trap.** `cat >>` edits the live inode (container sees it); `sed -i` / `mv` / editor-rewrite create a NEW inode the running container does NOT see (it's frozen on the original). Fix: edit in place (truncate+write `cat > file`) OR recreate the container. (Caused the long Caddy `basic_auth` `__HASH__` saga.)
2. **Verify receipts, not the load script.** "all confirmed" = mined, not succeeded. Check `status:0x1` + gasUsed + logs before reporting TPS. The 527/648-TPS runs were 100% reverts (deployer had no MINTER_ROLE).
3. **Besu snap-sync heal window.** `eth_syncing:false` ≠ state ready — snap keeps healing the trie afterward, during which `eth_call`/`eth_getCode` silently return empty for un-healed accounts. `--sync-mode=FULL` avoids it (now pinned).
4. **Caddy 2.8 `basic_auth`** takes the raw bcrypt from `caddy hash-password`; a swapped Caddyfile inode won't be re-read by `reload` (recreate, or edit in place).
5. **`${1:?…{…}…}`** — a `}` in the error message closes the expansion early and corrupts the var.
6. **ufw + Docker:** Docker bypasses ufw for published ports — ufw mainly guards host-level ports.
7. **The agent is gated** (correctly) on: prod-DB destructive writes, SSH/firewall hardening, reading prod secrets/Vault, push-to-default-branch, recreating prod containers, and using the master admin key — each needs explicit, specific operator authorization. Vault reads / admin-key use should be done BY THE OPERATOR (e.g. running `minter-role.sh`).
8. **did-stg is the partner's box** — no SSH; WG peering with hara-rpc-1 is coordinated, not unilateral.
9. **This laptop ≠ the secrets-bundle machine.** It has the SSH ops key + `vps-hosts.env` + the `loadtest-deployer.json` we created — but NOT the original `~/hara-ops/*.json` bundle (admin key, vault-init keys). Those live on another machine / password manager.

---

## 19. Memory index (next-session warm start)

`memory/`: MEMORY.md, project-overview (renamed note + new topology), network-split, active-blockers (migration resolved), validator-pool-zombies, rpc-node-hang-bug, stress-test-results (361 TPS + invalid-runs correction), hara-did-partner, next-priorities (production-final push status), coding-conventions, sim-vs-prod-gaps, secrets-locations. Also: `PRODUCTION-READINESS.md`, `doc/technical/hara-registry-technical-manual.md`.

**If reading fresh:** chain is live + production-final as Hara Registry; the migration + stress validation + backups + rename are done; the open work is the §17 hardening follow-ups, starting with secret rotation.
