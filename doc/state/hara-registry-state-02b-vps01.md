# HaraLedger — Session State Handoff (2026-05-27)

## 1. Production deployment status

**Live in production on Nevacloud (Indonesian sovereign cloud), 6 VPSes:**

| Host | Role | Public IP | WG IP |
|---|---|---|---|
| hara-stateful | Vault Raft + Postgres + Redis + MinIO | 103.67.244.250 | 10.43.0.40 |
| hara-stateless | RPC + services + obs + Caddy edge | 202.155.91.66 | 10.43.0.20 |
| hara-v1 | Besu validator 1 (Jakarta) | 202.155.18.234 | 10.43.0.11 |
| hara-v2 | Besu validator 2 (Jakarta) | 103.169.206.46 | 10.43.0.12 |
| hara-v3 | Besu validator 3 (Surabaya) | 103.169.206.127 | 10.43.0.13 |
| hara-v4 | Besu validator 4 (Surabaya) | 160.19.166.23 | 10.43.0.14 |

**Chain state at session end**: ~4600+ blocks, QBFT consensus at 2s blocks, all 4 validators healthy. Anchor #1 recorded on-chain (txHash `0x2fb0d771a5e7a97e4943b962784c49d437e07523a9a2ce51314fd11cfb7373d5`).

## 2. Public endpoints

| URL | Backend |
|---|---|
| `https://rpc.ledger.haratrust.io/read/` | rpc-cache → HAProxy → rpc-read-1/2 |
| `https://rpc.ledger.haratrust.io/write/` | HAProxy → rpc-write |
| `https://rpc.ledger.haratrust.io/ws` | HAProxy → rpc-read WebSocket |
| `https://explorer.ledger.haratrust.io/` | Blockscout FE (with /api/* + /socket/* → BE) |
| `https://grafana.platform.haratrust.io/` | Grafana |

Caddy holds Let's Encrypt certs (auto-renewing). DNS at GoDaddy (haratrust.io).

## 3. Deployed contract addresses (chain ID 131216)

```
ContractRegistry:       0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
AnchorRegistry:         0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
GovernanceContract:     0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
HaraPalmOil:            0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
TraceabilityBatchRelay: 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
PQAnchorRegistry:       0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
```

## 4. Architecture — network redesign (critical)

**Subnet split** (the most important architectural decision of this session — commit `feb7116`):

```
WG mesh:        10.43.0.0/24   (each host = cross-host service endpoint)
Docker bridge:  10.42.0.0/24   (containers LOCAL to each host only)
```

Why: original plan put both on `10.42.0.0/24`; kernel had two routes for the same subnet, container outbound randomly failed.

**Service discovery model**:
- Intra-host: docker DNS (`vault`, `postgres`, `minio`, `lb`, etc.)
- Cross-host: `<remote-host-wg-ip>:<port>` (e.g., `http://10.43.0.40:8200` for Vault from any other host)
- Each service on hara-stateful binds to wg-IP (`VAULT_BIND=10.43.0.40:8200`) for cross-host reach
- Compose env vars parameterized: `${VAULT_ADDR:-http://vault:8200}` defaults to docker DNS (sim works), prod .env overrides to wg-IP

## 5. Stack

| Layer | Choice | Notes |
|---|---|---|
| Consensus | Besu QBFT 26.4.0 | 4 validators, 2s block period, gas price 0, zeroBaseFee |
| Mesh | WireGuard | 10.43.0.0/24, established via `deploy/ops/wg-bootstrap.sh` |
| Secret store | HashiCorp Vault 1.17 Raft | 5/3 unseal quorum, AppRole auth for validators/signer/anchor-worker |
| DB | Postgres 16-alpine | Indexer + Blockscout share instance, separate dbs |
| Cache | Redis 7-alpine | Rate-limit data + rpc-cache results |
| Object storage | MinIO (RELEASE.2025-09-07T16-13-09Z) | hara-chain-config + hara-pq-anchors buckets |
| Edge | Caddy 2.8-alpine | Auto LE certs, explicit `handle` blocks |
| LB | HAProxy 2.9-alpine | /rpc/read, /rpc/write, /ws path routing |
| Observability | Prometheus + Grafana + Loki + Tempo + Alertmanager | All on hara-stateless |
| Services | Node 22 + TypeScript + viem + Fastify | signer, broadcaster, indexer, rpc-cache, anchor-worker |
| Contracts | Solidity 0.8.26 + Foundry/forge | 6 production contracts |
| PQ crypto | @noble/post-quantum ML-DSA-65 (FIPS 204) | anchor-worker signs Merkle roots |
| Backup encryption | age (X25519) | All snapshots encrypted before rclone upload |

## 6. Key APIs

**Indexer trace-api** at port 9100 inside container (host: 127.0.0.1:9101):
- `GET /v1/batches?limit=N` — list ERC-1155 batches
- `GET /v1/batches/<id>/graph?aggregate=true` — custody DAG with nodes + edges
- `GET /metrics` — Prometheus metrics
- `GET /healthz`

**Anchor-worker** at port 9102 (host: 127.0.0.1:9102):
- `GET /metrics` — anchor count, sig bytes, latency
- `GET /healthz`

## 7. Critical schemas

`watched_contracts` (Postgres, hara_indexer):
```sql
contract_address character(42) PRIMARY KEY,    -- 0x-prefixed text, case-sensitive
name             text NOT NULL,
from_block       bigint NOT NULL DEFAULT 0,
enabled          boolean NOT NULL DEFAULT true
```

`pq_anchor_signatures`:
```sql
commitment_hash bytea(32) PRIMARY KEY,
algo            text NOT NULL,                  -- 'ml-dsa-65'
signer_did      text NOT NULL,
anchor_tx_hash  bytea(32) NOT NULL,
bucket          text DEFAULT 'hara-pq-anchors',
object_key      text NOT NULL,                  -- ml-dsa-65/<hash>.sig
size_bytes      integer NOT NULL,               -- typically 3309 (one anchor)
created_at      timestamptz DEFAULT now()
```

`indexer_state`:
```sql
id                 integer PRIMARY KEY,
last_indexed_block bigint,                      -- -1 to force re-scan from genesis
last_indexed_at    timestamptz
```

ABI registry at `services/indexer/src/abis.ts` — keyed by `watched_contracts.name`. Adding a new contract requires editing this file + INSERT + restart.

## 8. Sensitive material (in operator's password manager + on operator laptop)

| Secret | Location on disk | Backup |
|---|---|---|
| Vault root token + 5 unseal keys | `~/hara-ops/vault-init-keys-v2.json` | Password manager (6 items) |
| Age private key (backup encryption) | `~/.config/age/hara-backups.txt` | Password manager + paper recommended |
| Age recipient (public) | `age1fcdr3qk0wuzxy0ynmzj3d28d8m8pfe489wpk6udstzcyccj7l45sjla6e3` | Hardcoded in .env files |
| Anchor-worker ECDSA address | `0x1083b82AB0F9dC35827edAdf5f7B489cBE10C433` | Password manager |
| Anchor-worker ECDSA private key | Password manager only + Vault at `secret/haraledger/signer-keys/anchor-worker` | — |
| SSH ed25519 key | `~/.ssh/hara_ops_ed25519` | Password manager |
| 4 prod passwords (Vault, Grafana, Postgres, MinIO) | In platform/.env + data/.env on hara-stateful | Password manager |
| 6 AppRole role_id/secret_id pairs (validator, signer, anchor-worker) | Printed once during AppRole bootstrap | Password manager |

**Anvil-0 deployer key** (`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`) is well-known but pre-funded with 10000 HARA in genesis. **MUST be rotated out before any external integration** — currently still in use as the deploy key.

## 9. Constraints

- Gas price chain-wide is 0 (`zeroBaseFee: true` in genesis)
- Block gas limit `0x1fffffffffffff` (~9 PETA) — effectively unbounded
- HAProxy LB: 32K concurrent, 5K req/10s per IP rate limit
- Indexer metrics port: container 9100 → host 9101 (port 9100 owned by prometheus-node-exporter)
- WG mesh requires `udp/51820` open between all 6 VPSes
- UFW: `DEFAULT_FORWARD_POLICY=ACCEPT` (without it, Docker container NAT to internet is blocked)
- Besu base image lives on Ubuntu noble (24.04) — apt repos work via Docker DNS only after `daemon.json` adds public resolvers

## 10. Coding conventions established

- All scripts use `set -euo pipefail`
- Bash apostrophe in `${VAR:?msg}` breaks the parser (lesson from commit `8cb8cb7` — `VPS's env` → `VPS env`)
- Compose env vars: `${VAR:-default-docker-dns}` for sim parity, prod .env overrides to wg-IPs
- `IMAGE_REGISTRY` is a parameterized prefix on every image (empty for local builds, `ghcr.io/imronzuhri-svg/` for prod)
- `BACKUP_AGE_RECIPIENT` required in every per-role .env
- secrets-bootstrap.sh generates all .env files with appropriate cross-host bindings baked in
- Docker bridge subnet stays `10.42.0.0/24`; container IPs in compose unchanged
- Test scripts in `ops/load-tests/` use direct ERC-1155 + TraceabilityBatchRelay via viem; foundry-rs/foundry image for cast commands
- All shell scripts must have exec bit set in git (`git update-index --chmod=+x`) — Windows checkouts otherwise lose it

## 11. Operator orchestrator scripts (deployment runbook)

| Script | Phase | Purpose |
|---|---|---|
| `deploy/ops/bootstrap-vps.sh` | 1 | Apt + Docker + WG + age + repo clone (cloud-init equivalent for providers without user-data) |
| `deploy/ops/wg-bootstrap.sh` | 3 | Render wg0.conf on all 6 hosts; verify 30/30 mesh edges |
| `deploy/ops/backup-setup.sh` | 0 | One-time age keypair generation on operator laptop |
| `deploy/ops/secrets-bootstrap.sh` | 4 | Generate all .env files with wg-IP bindings |
| `deploy/ops/vault-raft-init.sh` | 4 | Init + unseal Vault; auto-detects docker exec |
| `deploy/ops/vault-approle-bootstrap.sh` | 4 | Create AppRole policies for validator/signer/anchor-worker |
| `deploy/ops/seed-anchor-key.sh` | 7 | Write anchor-worker ECDSA key to Vault |
| `deploy/ops/bringup-stateful.sh` | 4c | Vault unseal verification → AppRole → Postgres+Redis → MinIO → chain init → genesis to MinIO |
| `deploy/ops/bringup-validators.sh` | 5 | All 4 validators with WG-IP enodes |
| `deploy/ops/bringup-stateless.sh` | 6 | RPC + services + obs + Caddy edge |
| `deploy/ops/bringup-phase7.sh` | 7 | Generate anchor key → seed Vault → fund → deploy 6 contracts → start anchor-worker |

## 12. Sim (local single-host)

`deploy/sim/sim-up.sh` brings up the entire 6-VPS topology on one Docker host. Uses dev-mode Vault, all on hara-platform docker bridge. Caught 13+ production-blocking bugs before paying for VPSes.

**Sim ≠ production gaps** (documented in `deploy/sim/README.md`):
- Vault dev-mode (no Raft, no AppRole)
- No WG mesh
- No Caddy/TLS
- rpc-cache not in receipt path (so the null-cache bug wasn't caught in sim)
- Single docker bridge — no cross-host routing tested

## 13. Test scenarios

`ops/load-tests/`:
- `scenario-palm-oil-sequential.ts` — 100 hops via 99 sequential `safeTransferFrom` (~7 min)
- `scenario-palm-oil-batch-relay.ts` — 100 hops in 1 tx via `executeChain` (~30s)
- `scenario-palm-oil-batch-relay-v2.ts` — same with JSON-RPC batched approvals
- `scenario-refinery-dag.ts` — 224 hops in a DAG (5→10→24→6→4→8→10) — **measured on prod: 2,853,739 gas, 17.1s wall clock, ~12,740 gas/hop**
- `scenario-stress-200x500.ts` — 100K events stress test (NEW this session; currently blocked on Besu tx propagation issue)

## 14. Unresolved issues at session end

### Pending commits (not pushed)
- `5839583` — chunked-send fix for stress test

### Active blockers
1. **Besu tx propagation rate limit** — when many txs from different senders all with nonce=0 are submitted in parallel (the 500-wallet approval phase), Besu's local mempool accepts but P2P broadcast throttles. Validators don't see ~half of them. The 200x500 stress test is stuck at this. Chunking to 50/batch didn't fully solve it (zombies still accumulate from earlier runs).
2. **Mempool persistence across restarts** — Besu defaults `--tx-pool-enable-save-restore=true`. Wiping rpc-write's data volume did NOT clear the mempool (or txs came back from somewhere). Need to investigate where they're persisted, or force-disable save/restore in rpc start script.
3. **rpc-cache fix not yet deployed** — commit `f46d2be` (don't cache null receipts) is pushed to main but the image hasn't been rebuilt+pulled on hara-stateless. Workaround: clients use `/write/` for reads to bypass cache.

### Cosmetic / nice-to-have
- Blockscout viewer (the trace-api UI at `ops/traceability-view/viewer.html`) works through SSH tunnel — tunnel is finicky on WSL. Could be exposed via Caddy on its own hostname for stable access.
- Blockscout indexer needed manual cursor reset to pick up retroactively-registered contracts. Future deploys should register contracts BEFORE creating events (or build automatic re-scan on watched_contracts INSERT).
- The validators on different hosts have empty txpools while rpc-write accumulates — this is a real systemic issue beyond the immediate stress test.
- IPv6 `[::1]:9100` listener exists on operator WSL (probably node_exporter or similar) — doesn't conflict with IPv4 tunnel but worth noting.

### Deferred (Phase 8+)
- Snapshot crons not scheduled (`vault-raft-snapshot.sh`, `snapshot-postgres.sh`, `snapshot-validator.sh` — all ready, just need systemd timers)
- GitHub branch protection
- Nevacloud Object Storage bucket exists but rclone remote isn't configured on the VPSes — backups aren't actually uploading anywhere

## 15. Bug count

**~25+ production-blocking bugs caught and fixed this session.** Sim dry-run caught the first 13; live deploy caught the rest. Each has a commit with `fix(...)` subject. Highlights:

1. Vault Raft volume permissions (sim)
2. Vault double `-config` parse error (sim)
3. MinIO image tags 404 (sim)
4. Redis rename-command malformed (sim)
5. anchor-worker missing from compose (sim)
6. Compose images need registry-aware prefix (sim)
7. snapshot-validator VOLUME assignment in comment (sim)
8. secrets-bootstrap missing 8 env vars (sim)
9. snapshot-postgres apostrophe bash-parse error (sim)
10. chain-shared volume not externally addressable (sim)
11. RPC compose pointing at non-existent ./genesis/ (sim)
12. anchor-worker key not seeded + role grants missing from deploy (sim)
13. UFW hara-p2p profile syntax (live)
14. UFW DEFAULT_FORWARD_POLICY=DROP blocked Docker NAT (live)
15. Nevacloud doesn't expose user-data → bootstrap-vps.sh workaround (live)
16. Network redesign — wg/bridge subnet conflict (live, big refactor)
17. chain init container couldn't reach 10.43.0.40 from bridge (live)
18. VAULT_DEV_ROOT_TOKEN env mismatched real Raft root token (live)
19. MinIO image's `_FILE` env vars overrode root credentials (live)
20. mc `alias set` cache bug — switched to `MC_HOST_h` URL form (live)
21. Blockscout envs gitignored, missing on hara-stateless (live)
22. blockscout-db-init hardcoded `PGHOST: postgres` (live)
23. INDEXER_METRICS_BIND collision with node_exporter on port 9100 (live)
24. Caddyfile bare `reverse_proxy` intercepted /api/* (live)
25. rpc-cache caching null receipts for 1h TTL (live)
26. Indexer watched_contracts case sensitivity + missed events on register-after-fact (live)
27. Besu mempool tx propagation rate limit blocking parallel multi-wallet sends (live, OPEN)

## 16. Next priorities

In rough order:

1. **Resolve Besu tx propagation rate limit** — investigate `--tx-pool-enable-save-restore` and the broadcast rate. May need to tweak rpc start flags. Without this, parallel multi-wallet load tests are blocked.
2. **Deploy rpc-cache fix** — pull updated image on hara-stateless, restart container, flush Redis cache. Then clients can use `/read/` again without the null-receipt issue.
3. **Phase 8 — schedule snapshot crons** — configure rclone on hara-stateful with the Nevacloud Object Storage credentials, install the systemd timers from `deploy/nevacloud-runbook.md §9`.
4. **Run the 200x500 stress test successfully** — once #1 is fixed. Get real numbers for projecting 100K-event throughput.
5. **Phase 9 — GitHub branch protection** — main branch requires PR + CI green.
6. **Anvil-0 key rotation** — replace the well-known deployer key with a fresh one before any external integration. Drain anvil-0's balance to a new key, update Vault + signer config.
7. **Vault snapshot drill** — verify the actual restore path works on hara-stateful with the encrypted snapshot pipeline.
8. **rpc-cache fix into CI build pipeline** — ensure the `:latest` GHCR tag actually includes commit `f46d2be` (verify GitHub Actions ran on push).
9. **Expose viewer behind Caddy** — `viewer.platform.haratrust.io` → indexer's trace-api. Avoids the SSH-tunnel friction.

## 17. Useful diagnostic commands

```bash
# Chain health
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'

# Mempool state
curl -s -X POST https://rpc.ledger.haratrust.io/write/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"txpool_status","id":1}'

# Validator block height directly via WG
ssh hara-v1 'docker run --rm --network hara-platform alpine:3.20 \
  wget -qO- --post-data="{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"id\":1}" \
  --header="Content-Type: application/json" http://hara-validator1:8545'

# Indexer trace-api (via SSH tunnel from operator laptop)
ssh -fNL 9100:127.0.0.1:9101 hara-stateless
curl -s http://localhost:9100/v1/batches?limit=5

# Vault status via container exec
ssh hara-stateful 'docker exec hara-vault vault status'

# Anchor-worker anchor count on-chain
docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  call 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 'anchorCount()(uint256)' \
  --rpc-url https://rpc.ledger.haratrust.io/write/

# Postgres anchor records
ssh hara-stateful "docker exec hara-postgres psql -U hara -d hara_indexer -c \
  \"SELECT count(*), algo, max(created_at) FROM pq_anchor_signatures GROUP BY algo\""

# MinIO listing (use MC_HOST_h URL form — `mc alias set` has an auth bug)
ssh hara-stateful '
  MUSER=$(grep MINIO_ROOT_USER /opt/hara/hara-registry/deploy/data/.env | cut -d= -f2)
  MPASS=$(grep MINIO_ROOT_PASSWORD /opt/hara/hara-registry/deploy/data/.env | cut -d= -f2)
  docker run --rm --network hara-platform \
    -e MC_HOST_h="http://$MUSER:$MPASS@hara-minio:9000" \
    --entrypoint mc minio/mc:RELEASE.2025-08-13T08-35-41Z \
    ls --recursive h/hara-pq-anchors/
'
```

## 18. Repository layout (key paths)

```
hara-registry/
├── chain/                      # legacy single-host compose (kept for local make up)
├── contracts/                  # Solidity sources + Foundry config
│   ├── src/
│   ├── script/                 # Deploy.s.sol, DeployPalmOil.s.sol, DeployPQAnchor.s.sol
│   └── broadcast/              # forge outputs — addresses + tx hashes
├── deploy/
│   ├── chain/                  # validator compose (single + per-host)
│   ├── data/                   # postgres + redis + minio compose
│   ├── edge/                   # Caddy compose + Caddyfile
│   ├── ops/                    # operator orchestrator scripts (all *.sh)
│   ├── platform/               # vault + obs composes
│   ├── rpc/                    # haproxy LB + rpc-read/write Besu nodes
│   ├── services/               # signer/broadcaster/indexer/rpc-cache/anchor-worker/blockscout
│   ├── sim/                    # local-host production-shape sim
│   ├── nevacloud-runbook.md    # 700-line step-by-step deploy guide
│   ├── PRE-VPS-CHECKLIST.md
│   └── topology.md
├── ops/
│   ├── load-tests/             # viem-based load scenarios + viewer reports
│   └── traceability-view/
│       └── viewer.html         # Cytoscape custody-chain visualizer
├── scripts/
│   ├── register-from-broadcast.sh
│   └── register-watched.sh
├── services/                   # TypeScript service implementations
│   ├── anchor-worker/
│   ├── broadcaster/
│   ├── indexer/                # includes src/abis.ts + src/trace-api.ts
│   ├── migrate/
│   ├── rpc-cache/
│   ├── shared/
│   └── signer/
├── _platform/                  # SIBLING dir (not in repo) — local dev infra
└── haraleder-vps-01.md         # THIS FILE
```
