# HaraLedger

Private permissioned EVM chain for the HARA ecosystem. Besu QBFT consensus, 4-validator minimum, instant finality.

See `doc/` for architecture:
- `haraledger_ecosystem_development_blueprint.md` — what to build
- `hara-ledger-roadmap.md` — when, where, and why (phases P0–P3)

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
Bring it up **once** for the host machine; then bring up hara-ledger on top.

```bash
make platform-up   # one-time: shared Vault + observability stack
make bootstrap     # generates validator keys → Vault, writes genesis
make up            # brings up 4 validators + 3 RPC nodes + LB + signer + broadcaster + indexer
make deploy        # deploys ContractRegistry, AnchorRegistry, GovernanceContract
make logs          # tail logs from hara-ledger services
make down          # stop hara-ledger (data persists)
make clean         # destroy hara-ledger chain data (platform stays up)
```

After `make up`, services are available at:

| Service | URL | Provided by |
|---|---|---|
| RPC (HTTP, path-routed `/rpc/read` and `/rpc/write`) | http://localhost:8545 | hara-ledger |
| RPC (WebSocket) | ws://localhost:8546 | hara-ledger |
| HAProxy stats | http://localhost:8404 | hara-ledger |
| Signer API | http://localhost:7000 | hara-ledger |
| Indexer metrics | http://localhost:9100 | hara-ledger |
| **Blockscout UI** | http://localhost:4010 | hara-ledger (L5) |
| Blockscout API | http://localhost:4000/api/v2 | hara-ledger (L5) |
| Vault UI | http://localhost:8200 (root token: `haraledger-dev-root`) | _platform |
| Grafana | http://localhost:3200 (admin / admin) | _platform |
| Loki | http://localhost:3201 | _platform |
| Prometheus | http://localhost:9090 | _platform |
| Alertmanager | http://localhost:9093 | _platform |

## Project layout

```
hara-ledger/
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

See `doc/hara-ledger-roadmap.md`. Current stage: **L0 — Chain bring-up**.
