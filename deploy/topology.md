# Deploy Topology — 6-VPS Nevacloud (Option B)

**Audience:** the person provisioning Nevacloud VPSes and bringing the stack up.
**Authoritative cross-refs:** `doc/nevacloud-proposal.md` §"Option B (6 VPS) — REKOMENDASI"; `doc/hara-ledger state 2.md` §2 (architecture), §11 (priorities).

This is the missing link between "we have docker-compose files" and "we can fan out across 6 hosts." It maps every container in `deploy/` to exactly one VPS, names the network plan, and gives a bring-up sequence that respects the cross-host dependencies.

---

## 1. The 6 VPSes at a glance

```
                       ┌───────────────────────────────────────────────────────┐
                       │ Internet (HTTPS via Caddy on hara-stateless)          │
                       └───────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ WireGuard mesh: 10.42.0.0/24                                                   │
│                                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                        │
│  │ hara-v1  │  │ hara-v2  │  │ hara-v3  │  │ hara-v4  │   ← validators         │
│  │ .11      │  │ .12      │  │ .13      │  │ .14      │                        │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘                        │
│        └─────────────┴─────────────┴─────────────┘                             │
│                            │                                                   │
│        ┌───────────────────┴───────────────────┐                               │
│        ▼                                       ▼                               │
│  ┌─────────────────┐                  ┌────────────────────────┐               │
│  │ hara-stateful   │                  │ hara-stateless         │               │
│  │ .30 / .31 / .40 │                  │ .20 / .21              │               │
│  │                 │                  │                        │               │
│  │ • Postgres      │                  │ • RPC read × 2 + write │               │
│  │ • Redis         │                  │ • HAProxy LB           │               │
│  │ • Vault (Raft)  │                  │ • signer               │               │
│  │ • MinIO         │                  │ • broadcaster          │               │
│  │ • init (once)   │                  │ • indexer              │               │
│  │                 │                  │ • rpc-cache            │               │
│  │                 │                  │ • Blockscout BE + FE   │               │
│  │                 │                  │ • Prom/Graf/Loki/AM    │               │
│  │                 │                  │ • Caddy (TLS)          │               │
│  └─────────────────┘                  └────────────────────────┘               │
└────────────────────────────────────────────────────────────────────────────────┘
```

Per `nevacloud-proposal.md` Option B, total ~Rp 7.7M/month for hara-ledger alone (validators ×4 + 2 app VPSes + 300 GB object storage). Stateful + stateless tiers are explicitly separated so you can scale the stateless tier horizontally without touching data.

---

## 2. Per-VPS role, compose files, ports

### 2.1 `hara-v1` / `hara-v2` / `hara-v3` / `hara-v4` — validators

**Specs:** 4 vCPU / 8 GB / 100 GB NVMe each.

**Role:** Besu QBFT validator. Crash-only; no app workload. The chain's consensus quorum needs ≥3 of these alive — that's why they're physically separated.

**Compose file:**
```
deploy/chain/docker-compose.validator-only.yml
```
(versus the local-dev `docker-compose.yml` which runs all 4 validators in one stack, the `validator-only` variant runs a single validator per host, parameterised by env.)

**Required env (per VPS, in `chain/.env`):**
```
VALIDATOR_ID=1            # 2 / 3 / 4 on the other hosts
VAULT_ADDR=http://10.42.0.40:8200
VAULT_TOKEN=<role-token issued by Vault AppRole on hara-stateful>
HARA_CHAIN_ID=131216
```

**Volumes:**
- `validator-data` (local NVMe; ~25 GB/year per validator at current event rates)
- `chain-shared` (read-only — genesis.json + static-nodes.json, fetched once from hara-stateful at first boot)

**Public ports:** none. All validator-to-validator traffic stays inside the WireGuard mesh on 30303/tcp.

**Internal ports (mesh only):**
- `30303/tcp` — Besu P2P (devp2p)
- `9545/tcp` — Prometheus metrics (scraped by hara-stateless)

**Snapshots:** `deploy/ops/snapshot-validator.sh` runs nightly via systemd timer; uploads to object storage. State-2 §11 mentions this script exists.

### 2.2 `hara-stateful` — data + secrets

**Specs:** 8 vCPU / 32 GB / 1 TB NVMe. The 1 TB is the Option-B upgrade over Option A's 500 GB; sized for full 45-month workload per `nevacloud-proposal.md` §Bagian 2.

**Role:** anything that has to *not* be lost. No application code runs here beyond the data services themselves.

**Compose files:**
```
deploy/platform/docker-compose.yml     # Vault only (split — see §5 below)
deploy/data/docker-compose.yml         # Postgres + Redis
deploy/data/minio.yml                  # NEW — needs to be added (ADR-0010)
```

**Internal ports (mesh only):**
- `5432/tcp` — Postgres
- `6379/tcp` — Redis
- `8200/tcp` — Vault
- `9000/tcp` — MinIO S3 API
- `9001/tcp` — MinIO console (firewalled to admin IPs)

**Public ports:** none. Everything routes through hara-stateless.

**One-shot init:** the `deploy/chain/init.sh` container runs **here, once**, to:
1. Generate QBFT genesis + 4 validator keypairs.
2. Write keys into Vault under `secret/haraledger/validators/{1..4}`.
3. Write `genesis.json` + `static-nodes.json` to MinIO bucket `hara-chain-config`.

Each validator VPS pulls those two files from MinIO on first boot. After init, the local copies on hara-stateful are discarded — Vault is the only persistent home for keys.

**Backups:** `deploy/ops/snapshot-postgres.sh` nightly; Vault Raft snapshot via `vault operator raft snapshot save` nightly; both uploaded to object storage.

**Why one VPS, not three:** Postgres / Redis / Vault all live in the same trust boundary (the data plane). Splitting them adds cost and network hops without changing the failure model — if this host dies, the chain keeps producing blocks (validators have their working set), but writes are blocked until restore. State-2 §10 explicitly limits to 6 VPSes via Compose; one stateful host is the trade-off.

### 2.3 `hara-stateless` — applications + observability + RPC

**Specs:** 8 vCPU / 32 GB / 500 GB NVMe. Stateless means you can re-create this VPS from scratch in ~5 minutes provided hara-stateful is alive — there's nothing here that's not reproducible from images + env.

**Compose files:**
```
deploy/rpc/docker-compose.yml          # 2 RPC read + 1 write + HAProxy LB
deploy/services/docker-compose.yml     # signer + broadcaster + indexer + migrate + rpc-cache
deploy/services/blockscout/            # Blockscout BE + FE
deploy/platform/docker-compose.obs.yml # NEW — Prom + Grafana + Loki + Alertmanager + Promtail
                                       # (split out from platform/ when we move Vault to stateful)
deploy/edge/caddy.yml                  # NEW — TLS termination, see §6
```

**Public ports (Caddy reverse-proxied):**
- `443/tcp` → routes to:
  - `/rpc/read` → rpc-cache (port 8088)
  - `/rpc/write` → HAProxy LB (port 8545)
  - `/ws` → HAProxy LB (port 8546)
  - `/grafana` → Grafana (port 3000)
  - `/explorer` → Blockscout FE (port 3000)
- `22/tcp` — SSH (cloud-init configures fail2ban + key-only auth)

**Internal ports (mesh):**
- Everything else stays inside.

**Why combined:** State-2 §6 says "Compose for this size — avoids k8s overhead." Stateless services are cheap to co-locate when they share the same kernel and trust boundary; the RPC tier reads from Postgres + Redis on hara-stateful, the indexer reads from validators over P2P (well, RPC actually). Caddy is the only thing terminating TLS — no TLS-on-every-service complexity.

**Scaling:** if read load saturates the stateless host (this is a real concern per `nevacloud-proposal.md` §Bagian 3 — hara-passport's verification API can drive millions of `eth_getLogs`/month), add a second stateless VPS running just `rpc/` + `services/rpc-cache/`. The LB on hara-stateless points at both. State-2 §11 #7 mentions tuning cache TTLs first.

---

## 3. WireGuard mesh — the 10.42.0.0/24 plan

This is the same IP layout the local Compose stack already uses, lifted directly into WireGuard so static enode URLs in `static-nodes.json` work without modification.

| VPS | WG IP | Reserved range |
|---|---|---|
| hara-v1 | 10.42.0.11 | |
| hara-v2 | 10.42.0.12 | |
| hara-v3 | 10.42.0.13 | |
| hara-v4 | 10.42.0.14 | |
| hara-stateless | 10.42.0.20 (read) / .21 (write) | (one host, two IPs via dummy ifaces) |
| hara-stateful | 10.42.0.30 (Postgres) / .31 (Redis) / .40 (Vault) | |
| **reserved hara-did** | 10.42.0.50–69 | sibling repo |
| **reserved hara-passport** | 10.42.0.70–89 | sibling repo |

State-2 §2 already documents this — it was the **planning** plan; now it's the wire plan.

**WireGuard key distribution:** out of scope of cloud-init (which can't know the other peers' public keys at boot). Use a small post-create script — once all 6 VPSes are up, run `deploy/ops/wg-bootstrap.sh` (to be written) from the operator laptop; it SSHes to each host, generates a key pair, collects the public keys, distributes the peer config back. One-time, ~2 minutes.

---

## 4. Deployment sequence

Hard ordering — the cross-host dependencies are real.

**Step 0: panel-create all 6 VPSes** in the Nevacloud dashboard with `deploy/ops/cloud-init.yaml` pasted into the user-data field. Wait for all 6 to show "running" + accept SSH. ~10–15 minutes total.

**Step 1: WireGuard mesh.** Run `deploy/ops/wg-bootstrap.sh` from operator laptop. Verify each VPS can `ping 10.42.0.X` every other VPS.

**Step 2: hara-stateful first.**
```bash
ssh hara@hara-stateful
cd /opt/hara-ledger
./deploy/ops/secrets-bootstrap.sh init     # generates .env files locally
docker compose -f deploy/platform/docker-compose.yml --env-file deploy/platform/.env up -d
# wait for Vault healthy
docker compose -f deploy/data/docker-compose.yml --env-file deploy/data/.env up -d
docker compose -f deploy/data/minio.yml up -d
```
Vault comes up in Raft mode (NOT `-dev`), unsealed via the `secrets-bootstrap.sh`-generated keys stored in your password manager. Postgres + Redis + MinIO follow.

**Step 3: chain init (still on hara-stateful).**
```bash
docker compose -f deploy/chain/docker-compose.yml --env-file deploy/chain/.env run --rm init
# This generates genesis + validator keys, writes keys to Vault, uploads
# genesis.json + static-nodes.json to MinIO bucket 'hara-chain-config'.
```

**Step 4: validators (4 VPSes, in parallel).**
```bash
# On each of hara-v1..v4, with VALIDATOR_ID set in chain/.env:
docker compose -f deploy/chain/docker-compose.validator-only.yml --env-file deploy/chain/.env up -d
# Validator pulls genesis from MinIO, pulls its key from Vault, peers via mesh,
# starts producing blocks once quorum (≥3) is online.
```
Verify block production: `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' http://10.42.0.11:8545` should advance.

**Step 5: hara-stateless.**
```bash
ssh hara@hara-stateless
cd /opt/hara-ledger
docker compose -f deploy/rpc/docker-compose.yml --env-file deploy/rpc/.env up -d
docker compose -f deploy/services/docker-compose.yml --env-file deploy/services/.env up -d
docker compose -f deploy/platform/docker-compose.obs.yml up -d   # Prom/Graf/Loki/AM
docker compose -f deploy/edge/caddy.yml up -d                    # TLS
```

**Step 6: contract deploy.**
```bash
make deploy-all   # already wired — see Makefile commit a858bf3
```
Contracts deploy through the LB at the public TLS endpoint; addresses auto-register into `watched_contracts`.

---

## 5. Compose files that need splitting before deploy

The current `deploy/platform/docker-compose.yml` bundles Vault + Prom + Grafana + Loki + Alertmanager + Promtail + alert-sink. **In 6-VPS prod, Vault lives on hara-stateful and the rest lives on hara-stateless.** Two solutions:

**A. Split into two files** (recommended):
- `deploy/platform/docker-compose.secrets.yml` — just Vault, deployed on hara-stateful
- `deploy/platform/docker-compose.obs.yml` — Prom/Graf/Loki/AM/Promtail/alert-sink, deployed on hara-stateless

Local dev keeps using the existing `docker-compose.yml` (which can be a thin wrapper that includes both via `include:`, or just be left as-is for the single-host case).

**B. Single file with profiles.** Keep one compose file but tag services with profiles (`profiles: [secrets]` vs `profiles: [obs]`); each VPS runs only its profile.

Pick A — explicit beats clever. The split is a one-time refactor.

Also needed:
- `deploy/data/minio.yml` — NEW. MinIO currently runs in hara-did's compose; hara-ledger needs its own for the `hara-pq-anchors` bucket (ADR-0010). Or share hara-did's MinIO and document the cross-network dependency — but the topology should not depend on a sibling repo being up first.
- `deploy/chain/docker-compose.validator-only.yml` — already exists and correctly parameterises `VALIDATOR_ID` (verified). Each validator VPS sets `VALIDATOR_ID=N` in its `chain/.env` where N is 1..4.
- `deploy/edge/caddy.yml` — NEW. Reverse-proxies all public-facing services through one TLS endpoint.

---

## 6. TLS termination — Caddy

One Caddy container on hara-stateless. Auto-renews via Let's Encrypt. `Caddyfile` outline:

```caddy
rpc.hara.id {
  reverse_proxy /read/* rpc-cache:8088
  reverse_proxy /write/* hara-lb:8545
  reverse_proxy /ws hara-lb:8546
}

grafana.hara.id {
  reverse_proxy hara-grafana:3000
}

explorer.hara.id {
  reverse_proxy hara-blockscout-fe:3000
}
```

DNS for the three hostnames points to hara-stateless's public IP. Caddy handles cert issuance + renewal; no per-service TLS.

Vault is NOT exposed publicly. Operator access via SSH tunnel or VPN.

---

## 7. Failure domains

| If this dies | What happens | Recovery |
|---|---|---|
| 1 of hara-v1..v4 | Chain keeps producing (QBFT needs 3 of 4). Some indexer latency for the dead validator's events. | Reprovision VPS, cloud-init runs, pull key from Vault, rejoin. ~10 min. |
| 2 of hara-v1..v4 | Chain HALTS (no quorum). | Recover at least one validator from snapshot to regain quorum. Snapshots are nightly to object storage. |
| hara-stateful | Chain keeps producing (validators have their keys in memory). All writes hang (signer can't reach Postgres). | Restore Postgres + Vault snapshots from object storage to a fresh VPS. ~15–30 min. State-2 §11 #3 (Vault Raft HA) reduces blast radius here. |
| hara-stateless | Public API offline. Chain itself unaffected. | Re-provision; pull images; up. ~5 min. No state lost. |
| Object storage | Backups stop landing. Existing chain unaffected. | Reconfigure rclone target. |

The validator quorum risk is the only one without a fast-recovery answer — by design (BFT). Standard mitigation: geo-spread the 4 validator VPSes across **two Nevacloud regions** (Jakarta + Surabaya per `nevacloud-proposal.md`), so a single-region outage costs ≤2 validators.

---

## 8. What this doc deliberately does not cover

These are tracked elsewhere; out of scope here:

- **Vault Raft HA configuration details** — separate doc; state-2 §11 #3.
- **TLS cert ownership / DNS provider choices** — operator concern, not topology.
- **hara-did + hara-passport VPSes** — `nevacloud-proposal.md` §Bagian 3, §Bagian 4. Reserved IPs `.50–69` and `.70–89` respectively; their compose files live in those sibling repos.
- **Disaster recovery to Huawei** — P1 work per roadmap.
- **K3s migration** — P1 work.

---

## 9. Pre-VPS gating checklist (before any of this runs)

Reproduced here from the session summary so it's all in one place:

1. **Vault Raft HA migration** — non-negotiable. Today's chain stall proved dev-mode Vault is unfit for VPS.
2. **WireGuard mesh validated locally** with two VMs/containers, ping ↔ ping, before deploying to Nevacloud.
3. **Snapshot + restore drill locally.** `chain/data` wiped, restored from `snapshot-validator.sh` output, chain resumes at correct block.
4. **TLS plan ready** — Caddyfile sketched, domains registered, DNS records prepared.
5. **`secrets-bootstrap.sh` dry-run.** All five `.env` files produced; no template variables left.
6. **Compose file split done** per §5 above (`platform.secrets.yml` + `platform.obs.yml`).
7. **First-VPS smoke test.** Provision just hara-stateful in the panel, run §4 step 2 only, verify Vault + Postgres + Redis up and reachable from operator laptop via WG. *Only then* fan out the other 5.

When all 7 are checked, you're ready to provision the 5 remaining VPSes.
