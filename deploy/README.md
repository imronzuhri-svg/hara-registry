# deploy/ — Production deployment layout

This folder contains role-split docker-compose files for **production deployment**. Each subdirectory is self-contained and can run on a separate VPS, OR multiple can be co-located on one host.

## Why this exists

The development setup in `chain/docker-compose.yml` and `_platform/docker-compose.yml` runs **everything on one Docker host**. That's perfect for development. For production on Nevacloud (or any cloud), you want to spread services across multiple VPS for fault tolerance:

- **4 validators on 4 separate hosts** so the QBFT consensus survives any single host failure
- **App-tier separate from chain-tier** so a runaway query doesn't slow block production
- **Data tier dedicated** so backups don't compete with live workload
- **Observability isolated** so monitoring keeps working even when the cluster has problems

The compose files in this folder are designed so the **same files** work across the entire scale spectrum — from 1 VPS (everything co-located) up to 25+ VPS (P3 global). The only thing that changes is **which compose files run on which host**.

## Layout

```
deploy/
├── README.md                       ← this file
├── platform/                       ← shared infra (Vault, Prom, Grafana, Loki, Alertmgr, alert-sink, Promtail)
│   ├── docker-compose.yml
│   ├── .env.example
│   ├── prometheus/
│   ├── alertmanager/
│   ├── alert-sink/
│   ├── loki/
│   ├── promtail/
│   └── grafana/
├── chain/                          ← Besu QBFT validators (one validator service per host in P1b+)
│   ├── docker-compose.yml          (4 validators; uncomment/comment as needed)
│   ├── docker-compose.validator-only.yml   (single-validator override for per-host deploy)
│   ├── init/                       (genesis bootstrap one-shot)
│   ├── node/                       (validator image with curl + Vault key fetch)
│   ├── scripts/
│   ├── genesis/
│   └── qbft-config.json
├── rpc/                            ← Read/Write RPC nodes + HAProxy LB
│   ├── docker-compose.yml
│   ├── lb/haproxy.cfg
│   └── scripts/
├── services/                       ← App tier (signer, broadcaster, indexer, rpc-cache, blockscout, +fe)
│   ├── docker-compose.yml
│   └── migrations/                 (Postgres migrations applied by migrate one-shot)
├── data/                           ← Per-project Postgres + Redis (will move to platform/ in Phase 2)
│   └── docker-compose.yml
├── networks/
│   └── wireguard/                  ← WireGuard mesh setup script for cross-VPS overlay
└── ops/
    ├── cloud-init.yaml             ← Bootstrap any Nevacloud VPS for Docker + repo checkout
    ├── secrets-bootstrap.sh        ← Generate per-deployment passwords + push to Vault
    ├── snapshot-validator.sh       ← Daily backup of validator data → Nevacloud Object Storage
    └── snapshot-postgres.sh        ← Daily Postgres dump → Nevacloud Object Storage
```

## Deployment scenarios

### P0 — Single host (development on Nevacloud)

For a smoke-test deployment on one VPS, run everything:

```bash
# On the single VPS, after cloud-init has installed Docker + cloned the repo
cd deploy/
docker compose -f platform/docker-compose.yml up -d
docker compose -f chain/docker-compose.yml up -d
docker compose -f rpc/docker-compose.yml up -d
docker compose -f data/docker-compose.yml up -d
docker compose -f services/docker-compose.yml up -d
```

This is equivalent to today's local dev setup, just on a real VPS. Useful as a P0 staging.

### P1a — 5 VPS (real BFT pilot)

| VPS hostname | What runs | docker-compose files |
|---|---|---|
| `hara-v1` | validator1 | `chain/docker-compose.validator-only.yml` (VALIDATOR_ID=1) |
| `hara-v2` | validator2 | same (VALIDATOR_ID=2) |
| `hara-v3` | validator3 | same (VALIDATOR_ID=3) |
| `hara-v4` | validator4 | same (VALIDATOR_ID=4) |
| `hara-app` | Everything else | `platform/` + `rpc/` + `data/` + `services/` |

**Networking**: 5 VPS connected via a WireGuard mesh on `10.42.0.0/24`. Container IPs already match this subnet (validators `10.42.0.11–14`, services `10.42.0.40–47`, platform `10.42.0.2–8`). Docker Swarm overlay or a Docker network created as `attachable` allows cross-VPS container DNS.

### P1b — 8 VPS (sustained load)

Same chain hosts. The app host gets split into 4 more:

| VPS | Role | docker-compose files |
|---|---|---|
| `hara-v1..v4` | validators | unchanged |
| `hara-rpc` | RPC mesh + LB | `rpc/docker-compose.yml` |
| `hara-services` | App tier | `services/docker-compose.yml` |
| `hara-data` | Postgres + Redis | `data/docker-compose.yml` |
| `hara-platform` | Vault + observability | `platform/docker-compose.yml` |

### P2+ — multi-region + Huawei DR

Multiple instances of each compose file across regions. See `doc/hara-ledger-roadmap.md` Phase 2.

## How the network works across hosts

Inside a single host, the `hara-platform` Docker bridge network gives every container DNS via service name (`vault:8200`, `postgres:5432`, `rpc-read-1:8545`).

Across hosts, two options:

**Option A — Docker Swarm overlay** (recommended for production)
```bash
# On hara-app: init swarm
docker swarm init --advertise-addr <wireguard-ip-of-hara-app>
# It prints a join token. Then on each other VPS:
docker swarm join --token <token> <hara-app-wireguard-ip>:2377
# Create the overlay network ONCE (auto-replicates to all nodes):
docker network create --driver overlay --attachable --subnet 10.42.0.0/24 hara-platform
```

All compose files in this folder declare `hara-platform` as an `external` network — they'll join the overlay regardless of which host they run on. DNS works across hosts.

**Option B — Plain Compose + WireGuard with `extra_hosts`**

Less flexible but simpler — define each cross-host service's IP explicitly via `extra_hosts:` in your compose overrides. Tolerable for fixed 5–8 VPS deployments.

## Bring-up order

Whichever scenario you pick:

1. **WireGuard mesh up first** so the VPSes can see each other.
2. **Platform stack** (Vault must be healthy before anything that needs keys).
3. **Data tier** (Postgres ready before services that need to migrate).
4. **Chain tier** (validators need Vault keys + each other for P2P).
5. **RPC tier** (needs validators alive for static-nodes resolution).
6. **Services tier** (needs LB, DB, Vault, Redis).

The `make` targets in the repo root handle order on a single host. For multi-VPS, use the per-VPS bootstrap script in `ops/cloud-init.yaml` — it knows the bring-up order and waits for prerequisites.

## Secrets strategy

**Never commit secrets.** The `.env.example` files in each subdirectory document required environment variables. Real values come from one of:

1. **Vault** for chain-related secrets (validator keys, signer keys). Already implemented today.
2. **`.env` files on each VPS** for Vault tokens, DB passwords, Grafana admin. Generated per-deployment by `ops/secrets-bootstrap.sh`, never in git.
3. **Cloud provider's secret manager** (Nevacloud KMS, Huawei KMS) — recommended at P2+.

See `ops/secrets-bootstrap.sh` for the rotation procedure.

## Differences from the dev setup in chain/

| | `chain/docker-compose.yml` (dev) | `deploy/` (production) |
|---|---|---|
| Number of compose files | 2 (chain + _platform) | 5 (platform, chain, rpc, services, data) |
| Network | bridge `hara-platform` | overlay `hara-platform` (Swarm) |
| Host port mappings | All services bind to `0.0.0.0:*` | Only LB + Grafana + Vault UI exposed; everything else internal-only |
| TLS | None | Required at platform/grafana, rpc/lb (planned — see audit doc) |
| Vault mode | dev (`-dev`, root token in env) | Raft HA + AppRole auth (P1 hardening) |
| Postgres credentials | `hara/hara_dev_password` | generated per-deploy, in Vault |
| Backup | None | Daily snapshot to Nevacloud Object Storage |
| Validator restart policy | `unless-stopped` | same, but with systemd watchdog as second layer |

## Migration path: from dev → production

1. **Now (today)**: dev setup works. `deploy/` is parallel, not a replacement.
2. **Pre-P1a**: run smoke test with `deploy/` on a single Nevacloud VPS — verify all 5 compose files come up cleanly together.
3. **P1a**: provision 5 VPS, configure WireGuard, deploy. Old `chain/docker-compose.yml` stops being used. (We can delete it later if you want or keep as the "all-in-one dev mode" option.)
4. **P1b/P2**: scale by adding VPS and re-running the per-role compose on new hosts. No code changes.
