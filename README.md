# HaraLedger

Private permissioned EVM chain for the HARA ecosystem. Besu QBFT consensus, 4-validator minimum, instant finality.

> Renamed **HaraLedger → Hara Registry** (2026-06-01). Older docs use the former name.

**Start here:**
- [`doc/`](doc/README.md) — documentation index (product · technical · guides · state · …).
- [`doc/product/PRODUCT.md`](doc/product/PRODUCT.md) — product manual, features, stages, roadmap.
- [`doc/technical/TECHNICAL.md`](doc/technical/TECHNICAL.md) — comprehensive technical reference (architecture, contracts, services, APIs, ops).
- `deploy/topology.md` — 6-VPS deployment plan + pre-VPS checklist.
- [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) — production sign-off + open follow-ups.

Deeper reading: [`doc/archives/haraledger_ecosystem_development_blueprint.md`](doc/archives/haraledger_ecosystem_development_blueprint.md) (original blueprint), [`doc/roadmap/hara-ledger-roadmap.md`](doc/roadmap/hara-ledger-roadmap.md) (P0–P3 phases), [`doc/technical/audit-security-quantum-performance.md`](doc/technical/audit-security-quantum-performance.md) (security + PQ rationale), [`doc/guides/hara-registry-integration-manual.md`](doc/guides/hara-registry-integration-manual.md) (for hara-did developers), [`doc/state/hara-registry-state-07.md`](doc/state/hara-registry-state-07.md) (latest state).

## Stack

| Layer | Choice |
|---|---|
| Chain client | Hyperledger Besu (QBFT consensus) |
| Smart contracts | Solidity 0.8.x, Foundry toolchain |
| Validator keys | Vault from day one (no plaintext keys, ever) |
| Services language | TypeScript / Node |
| Local orchestration | Docker Compose |
| Monitoring | Prometheus + Grafana |

## Prerequisites

- Docker Desktop (Windows / macOS) or Docker Engine (Linux)
- GNU Make (on Windows: `winget install GnuWin32.Make` or use WSL)
- Foundry — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Node 20+ and pnpm — `corepack enable && corepack prepare pnpm@latest --activate`

## Quick start

Shared infra (Vault, Prometheus, Grafana, Loki, Alertmanager) lives in `../_platform/`.
Bring it up **once** for the host machine; then bring up hara-registry on top.

```bash
make platform-up        # one-time: shared Vault + observability stack
make bootstrap          # generates validator keys → Vault, writes genesis
make up                 # brings up 4 validators + 3 RPC nodes + LB + signer + broadcaster + indexer
make deploy-all         # deploys all 6 contracts + auto-registers them with the indexer
make register-watched   # re-register watched_contracts from existing broadcast files (no redeploy)
make reset-indexer      # truncate indexer state + cursor (keeps watched_contracts)
make logs               # tail logs
make down               # stop hara-registry (data persists)
make clean              # destroy hara-registry chain data (platform stays up)
```

After `make up`, services are available at:

| Service | URL | Provided by |
|---|---|---|
| RPC (HTTP, path-routed `/rpc/read` and `/rpc/write`) | http://localhost:8545 | hara-registry |
| RPC (WebSocket) | ws://localhost:8546 | hara-registry |
| HAProxy stats | http://localhost:8404 | hara-registry |
| Signer API | http://localhost:7000 | hara-registry |
| Indexer metrics | http://localhost:9100 | hara-registry |
| **Blockscout UI** | http://localhost:4010 | hara-registry (L5) |
| Blockscout API | http://localhost:4000/api/v2 | hara-registry (L5) |
| Vault UI | http://localhost:8200 (root token: `haraledger-dev-root`) | _platform |
| Grafana | http://localhost:3200 (admin / admin) | _platform |
| Loki | http://localhost:3201 | _platform |
| Prometheus | http://localhost:9090 | _platform |
| Alertmanager | http://localhost:9093 | _platform |

## Project layout

```
hara-registry/
├── chain/                  # chain infra (docker-compose, genesis, validator init)
│   ├── docker-compose.yml
│   ├── qbft-config.json    # input to besu operator tool
│   ├── init/               # init container that generates keys + loads Vault
│   ├── prometheus.yml
│   └── grafana/
├── contracts/              # Foundry project
│   ├── src/
│   ├── script/
│   └── test/
├── services/               # backend services (signer, indexer, batcher — populated from L2 onward)
├── ops/                    # runbooks + dashboards
└── doc/                    # architecture documents
```

## Development phases

See `doc/product/PRODUCT.md` §6 (overview) and `doc/roadmap/hara-ledger-roadmap.md` (full timeline).
Current stage: **P0.5 — VPS transition** (P0 complete in local dev; all 7 pre-VPS gates closed per `deploy/topology.md` §9).
