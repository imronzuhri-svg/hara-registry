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

**Networking**: VPSes are connected via a **WireGuard mesh on `10.43.0.0/24`** (host IPs: validators `10.43.0.11–14`, `hara-rpc-1` `.21`, `hara-stateless-2` `.25`, `hara-stateful` `.40`). Each host *also* keeps its own local Docker bridge `hara-platform` on `10.42.0.0/24` for same-host container DNS (validators `10.42.0.11–14`, services `10.42.0.40–47`, platform `10.42.0.2–8`). **Cross-host traffic uses the `10.43.0.x` mesh IPs** — there is no Docker Swarm / overlay in production (see "How the network works across hosts").

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

Multiple instances of each compose file across regions. See `doc/hara-registry-roadmap.md` Phase 2.

## How the network works across hosts

Inside a single host, the `hara-platform` Docker bridge network gives every container DNS via service name (`vault:8200`, `postgres:5432`, `rpc-read-1:8545`).

Across hosts, **production uses plain Compose + the WireGuard mesh** (the Docker
Swarm overlay option below was evaluated and **not** adopted — it added a control
plane and failure mode we didn't want for a fixed handful of VPSes):

**Production approach — plain Compose + WireGuard mesh IPs**

Each host runs its own `docker compose` with its own local `hara-platform`
bridge. Cross-host service references are set per host in the `.env` to the
peer's `10.43.0.x` mesh IP — e.g. on `hara-stateless-2`, the services point at
`RPC_*_URL=http://10.43.0.21:8545/...` (the RPC tier on `hara-rpc-1`) and Vault/
Postgres at `http://10.43.0.40:...`. Compose env defaults use docker-DNS names
for local sim and are overridden to mesh IPs in the prod `.env`. No Swarm, no
overlay network — the WireGuard tunnel is the only cross-host transport.

<details><summary>Not used: Docker Swarm overlay (evaluated, rejected)</summary>

```bash
docker swarm init --advertise-addr <wireguard-ip>
docker swarm join --token <token> <manager-wireguard-ip>:2377
docker network create --driver overlay --attachable --subnet 10.42.0.0/24 hara-platform
```
Would have given cross-host container DNS, but the split topology reaches peers
by mesh IP instead, which is simpler to reason about and debug.
</details>

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
| Network | bridge `hara-platform` (single host) | per-host bridge `hara-platform` (`10.42.0.0/24`) + WireGuard mesh (`10.43.0.0/24`) for cross-host; no Swarm |
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
