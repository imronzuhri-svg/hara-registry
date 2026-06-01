# hara-registry Integration Manual

> **Audience**: hara-did developers (and any other product that needs to integrate with hara-registry as the trust anchor).
>
> **Goal**: enable you to (a) bring up hara-registry locally for development, (b) connect hara-did services to it, (c) deploy contracts onto the chain, (d) anchor DID operations, (e) follow the operational conventions so you inherit our observability, secrets, and deployment story.
>
> Drop this file into `hara-did/docs/` or similar. Pair it with `haradid-pathway.md` and `haradid-roadmap.md`.

**hara-registry repo**: https://github.com/imronzuhri-svg/hara-registry
**Last verified against commit**: `f843fb5` (May 2026)

---

## Table of contents

1. [What hara-registry gives you](#1-what-hara-registry-gives-you)
2. [10-minute quick start](#2-10-minute-quick-start)
3. [Network topology — joining the platform](#3-network-topology--joining-the-platform)
4. [Chain RPC interfaces](#4-chain-rpc-interfaces)
5. [Vault — key storage conventions](#5-vault--key-storage-conventions)
6. [Data layer — Postgres + Redis](#6-data-layer--postgres--redis)
7. [Existing contracts hara-did can use](#7-existing-contracts-hara-did-can-use)
8. [Service architecture — patterns to mirror](#8-service-architecture--patterns-to-mirror)
9. [Deploying your own smart contracts](#9-deploying-your-own-smart-contracts)
10. [Indexing hara-did events](#10-indexing-hara-did-events)
11. [Observability — metrics, logs, alerts](#11-observability--metrics-logs-alerts)
12. [Performance — using rpc-cache and JSON-RPC batching](#12-performance--using-rpc-cache-and-json-rpc-batching)
13. [Production deployment — joining deploy/](#13-production-deployment--joining-deploy)
14. [Security checklist](#14-security-checklist)
15. [API contracts you may need](#15-api-contracts-you-may-need)
16. [Versioning + migration strategy](#16-versioning--migration-strategy)
17. [Troubleshooting](#17-troubleshooting)
18. [Reference: every endpoint, port, IP, address](#18-reference-every-endpoint-port-ip-address)

---

## 1. What hara-registry gives you

hara-registry is the **trust anchor and execution environment** for everything in the HARA ecosystem. For hara-did specifically, you get:

- A **private permissioned EVM chain** (Besu QBFT, 4 validators, ~2-second instant finality) — your `did:hara` operations end up here.
- A **Vault instance** to store signing keys (validator keys, issuer keys, future PQ keys). Centralized so you don't reinvent secret management.
- A **Postgres + Redis tier** you can carve a database/logical-DB out of for hara-did's own state.
- An **observability stack** (Prometheus + Grafana + Loki + Alertmanager) that automatically picks up your services if you follow conventions.
- **3 existing contracts** you may want to use directly:
  - `AnchorRegistry` — record Merkle roots (use for Sidetree anchor batches)
  - `PQAnchorRegistry` — quantum-safe version (hybrid ECDSA + ML-DSA commitment); preferred for long-lived audit anchors
  - `GovernanceContract` — for permissioned admin actions (e.g. registering a new IssuerDID via DAO-style multi-sig)
- A **proven service architecture** (signer, broadcaster, indexer, rpc-cache) you can copy the patterns from.
- A **deployment layout** (`deploy/` folder) you can extend.

What hara-registry does NOT do for you:

- Implement the Sidetree protocol — that's hara-did's job
- Hold DID documents — those live in hara-did's own CAS/MinIO buckets
- Issue Verifiable Credentials — that's hara-did's issuance flow
- Provide a wallet UI — your responsibility

---

## 2. 10-minute quick start

Get hara-registry running locally, deploy a test contract, and verify hara-did can call it.

### 2.1 Prerequisites

- Docker Desktop (or Docker Engine on Linux)
- `git`
- `forge` (Foundry) — for deploying Solidity. Either install locally via `curl -L https://foundry.paradigm.xyz | bash && foundryup` or use the Docker image `ghcr.io/foundry-rs/foundry:latest`
- Node 20+ (for client integration code)

### 2.2 Bring up the platform + chain

```bash
# Clone hara-registry alongside hara-did
git clone https://github.com/imronzuhri-svg/hara-registry.git
cd hara-registry

# 1. Bring up shared platform (Vault, Prometheus, Grafana, Loki)
cd ../_platform && cp .env.example .env && docker compose --env-file .env up -d
cd ../hara-registry

# 2. Bring up hara-registry chain + services
make platform-up   # confirms platform is healthy
make bootstrap      # generates validator keys → Vault, writes genesis
make up             # starts 4 validators + RPC mesh + LB + signer + broadcaster + indexer + rpc-cache + Blockscout

# 3. Deploy core contracts
make deploy

# 4. Confirm it works
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545/rpc/read
# → {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

You now have a chain producing blocks every 2 seconds at `http://localhost:8545`, with all our services running. Total time: ~10 minutes on a reasonable laptop (first run pulls Docker images).

### 2.3 Connect hara-did locally

From hara-did's compose file, declare the `hara-platform` network as external:

```yaml
# hara-did/docker-compose.dev.yml
networks:
  hara-platform:
    name: hara-platform
    external: true   # created by hara-registry's platform stack

services:
  did-services:
    # ... your service definition ...
    networks: [hara-platform]
    environment:
      RPC_READ_URL: http://lb:8545/rpc/read
      RPC_WRITE_URL: http://lb:8545/rpc/write
      RPC_CACHE_URL: http://rpc-cache:8080      # use this for read-heavy clients
      VAULT_ADDR: http://vault:8200
      VAULT_TOKEN: haraledger-dev-root           # dev only; AppRole in production
      POSTGRES_HOST: postgres
      POSTGRES_USER: hara
      POSTGRES_PASSWORD: hara_dev_password       # dev only
      POSTGRES_DB: hara_did                       # your dedicated DB (see §6)
      REDIS_HOST: redis
      REDIS_DB: 6                                 # claim a logical DB (see §6)
      SIGNER_URL: http://signer:7000             # if you want to use hara-registry's signer
      INDEXER_API_URL: http://indexer:9100
```

After `docker compose up`, your services live on the same Docker network as hara-registry's. DNS names like `vault`, `postgres`, `lb` Just Work.

---

## 3. Network topology — joining the platform

### 3.1 The shared network

All HARA services live on one Docker network named `hara-platform` (subnet `10.42.0.0/24`). Each cluster (hara-registry, hara-did, hara-passport, hara-xchange) joins as an `external: true` network in its compose file. Inside the network, every container resolves every other container by service name via Docker's embedded DNS.

In production, this network becomes a **Docker Swarm overlay** spanning multiple VPS — same DNS names, same Just Works behaviour.

### 3.2 IP allocation (avoid collisions)

We've reserved IP blocks per project:

| Range | Project | Used by |
|---|---|---|
| 10.42.0.2–10 | hara-platform | vault (2), prometheus (3), alertmanager (4), alert-sink (5), loki (6), grafana (7), promtail (8) |
| 10.42.0.11–49 | hara-registry | validators (11–14), rpc-read (21–22), rpc-write (23), lb (30), signer (40), broadcaster (41), indexer (42), blockscout (43), blockscout-fe (44), postgres (45), redis (46), rpc-cache (47) |
| **10.42.0.50–69** | **hara-did (reserved for you)** | Suggested: did-batcher (50), did-resolver (51), did-witness (52), did-wallet-api (53), did-issuer-portal (54), did-admin-console (55), did-verifier-demo (56), did-indexer (57), did-zk-prover (58) |
| 10.42.0.70–89 | hara-xchange | reserved |
| 10.42.0.100–119 | hara-halal-passport | reserved |

You don't have to use static IPs — DNS by service name works perfectly. But if you need a stable IP (e.g. cross-host firewall rules in production), pick from 10.42.0.50–69.

### 3.3 Network policies (production hardening)

In dev mode, every container can talk to every other. In production (P1b+) we recommend:

- hara-did services may connect to: `vault:8200`, `postgres:5432`, `redis:6379`, `lb:8545`, `lb:8546`, `rpc-cache:8080`
- hara-did services may **not** directly connect to: validators (use the LB), signer (unless explicitly permitted)

Enforcement: Docker Swarm or eventual k8s NetworkPolicy. We'll provide the policy templates in `deploy/networks/` once they're written for P1b.

---

## 4. Chain RPC interfaces

### 4.1 Endpoints

| Endpoint | URL (in-network) | URL (host) | Purpose |
|---|---|---|---|
| Read RPC (load-balanced) | `http://lb:8545/rpc/read` | `http://localhost:8545/rpc/read` | `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, etc. |
| Write RPC (load-balanced) | `http://lb:8545/rpc/write` | `http://localhost:8545/rpc/write` | `eth_sendRawTransaction` |
| WebSocket | `ws://lb:8546/rpc/read` | `ws://localhost:8546/rpc/read` | Subscriptions (logs, newHeads) |
| Read cache | `http://rpc-cache:8080` | `http://localhost:8088` | Use this for dashboards, public verification UIs, anything read-heavy |

Use the LB unless you have a specific reason not to. Direct connection to `http://rpc-read-1:8545` bypasses rate limiting and fail-over.

### 4.2 Chain configuration

```yaml
Chain ID:              131216
Block time:            2 seconds (instant finality via QBFT)
Native currency:       HARA (gas-free for whitelisted contracts)
EVM hardfork:          London (set in genesis; PUSH0 / Shanghai opcodes NOT supported)
Consensus:             QBFT (Hyperledger Besu)
Validator count:       4 (tolerates 1 byzantine failure)
RPC API enabled:       ETH, NET, WEB3, QBFT, DEBUG, TRACE, TXPOOL
```

**Important** for contract development:
- Compile with `evm_version = "london"` in `foundry.toml` — Solidity 0.8.20+ defaults to Shanghai which uses `PUSH0`, and our chain will revert on that.
- Send transactions as `--legacy` (type 0). EIP-1559 type 2 transactions need a base-fee mechanism that we have disabled.
- Sender wallets MUST have at least 1 wei native HARA balance, even with `gasPrice=0` — Besu's tx pool selector silently skips zero-balance senders. (We document this in our load-test scripts; see §17 troubleshooting.)

### 4.3 Calling RPC from TypeScript (viem)

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_READ = process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read";
const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://lb:8545/rpc/write";

const publicClient = createPublicClient({
  transport: http(RPC_READ, {
    batch: { batchSize: 100, wait: 16 },   // automatic JSON-RPC batching
  }),
});

const wallet = privateKeyToAccount(privateKey);
const writeClient = createWalletClient({
  account: wallet,
  transport: http(RPC_WRITE),
});

// Sign and send a legacy tx
const raw = await wallet.signTransaction({
  type: "legacy",
  chainId: 131216,
  nonce,
  to: contractAddress,
  data,
  value: 0n,
  gasPrice: 0n,
  gas: 200_000n,
});
const hash = await writeClient.sendRawTransaction({ serializedTransaction: raw });
```

### 4.4 JSON-RPC batching (for high-volume submissions)

If you're submitting many transactions (e.g. Sidetree batch anchoring multiple operations), use raw JSON-RPC batches instead of N separate HTTP POSTs. Same pattern as `services/rpc-cache/src/index.ts`:

```typescript
async function batchSendRawTxs(rpcUrl: string, signedTxs: Hex[]): Promise<(Hex | Error)[]> {
  const body = signedTxs.map((raw, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_sendRawTransaction", params: [raw],
  }));
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const results = (await res.json()) as Array<{ id: number; result?: Hex; error?: { message: string } }>;
  results.sort((a, b) => a.id - b.id);
  return results.map((r) => (r.error ? new Error(r.error.message) : r.result!));
}
```

Besu accepts up to **4096 calls in a single HTTP POST** (configured in `chain/scripts/start-rpc.sh`). For 1000 anchor operations, that's ~1 HTTP POST instead of 1000.

---

## 5. Vault — key storage conventions

### 5.1 Dev mode (today)

```
Address:  http://vault:8200
Token:    haraledger-dev-root    (root token, in-memory dev mode — lost on restart)
KV mount: secret/                 (KV v2)
```

### 5.2 Path conventions

The Vault tree is partitioned by project:

```
secret/
├── haraledger/                       # hara-registry's keys
│   ├── validators/{1..4}             # Besu validator keys
│   └── signer-keys/deployer          # The signer service's default key
│
├── haradid/                          # YOUR space — claim subpaths as needed
│   ├── issuer-keys/<issuerId>        # Per-issuer signing keys (BPJPH, LPH, MUI, etc.)
│   ├── signer-keys/<service>         # Per-service signing identities (e.g. did-batcher)
│   ├── batcher-keys/<batcher-id>     # Sidetree batcher keys (one per HA instance)
│   ├── pq-keys/<key-id>              # Post-quantum (ML-DSA) keys for PQAnchorRegistry
│   └── recovery-keys/<wallet-id>     # Holder recovery keys (only for custodial fallback)
│
├── harapassport/                     # reserved for hara-passport
└── haraxchange/                      # reserved for hara-xchange
```

### 5.3 Reading a key

```typescript
// From services/shared/src/vault.ts — already implemented in hara-registry
export async function fetchSignerKey(vaultPath: string): Promise<SignerKey> {
  const apiPath = vaultPath.replace(/^secret\//, "secret/data/");
  const url = `${VAULT_ADDR}/v1/${apiPath}`;
  const res = await fetch(url, { headers: { "X-Vault-Token": VAULT_TOKEN } });
  const body = (await res.json()) as { data: { data: { address: string; private_key: string } } };
  return {
    address: body.data.data.address.toLowerCase() as `0x${string}`,
    privateKey: body.data.data.private_key as Hex,
  };
}
```

You can import this directly:
```typescript
import { fetchSignerKey } from "@hara/shared/vault";   // if you publish hara-registry's shared as a package
// OR copy-paste the function — it's 15 lines
```

### 5.4 Writing a key (programmatic onboarding)

```typescript
async function storeIssuerKey(issuerId: string, privKey: Hex, address: Address) {
  const url = `${VAULT_ADDR}/v1/secret/data/haradid/issuer-keys/${issuerId}`;
  await fetch(url, {
    method: "POST",
    headers: { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: { address, private_key: privKey, created_at: new Date().toISOString() },
    }),
  });
}
```

### 5.5 Production (P1+): AppRole instead of root token

Each service gets its own AppRole with scoped permissions. Example policy for `did-batcher`:

```hcl
# vault-policies/did-batcher.hcl
path "secret/data/haradid/batcher-keys/*" {
  capabilities = ["read"]
}
path "secret/data/haradid/issuer-keys/*" {
  capabilities = ["read"]   # to anchor on behalf of issuers
}
```

The platform team enables AppRole auth, creates the role, hands you the role-id + secret-id. Your service exchanges those for a short-lived token at startup. This is on the P1b roadmap; for now everyone uses the root token in dev mode.

### 5.6 Vault dev-mode gotcha

Vault runs with `server -dev`, which keeps keys **in memory only**. Container restart = all keys gone. Our `chain/init/init.sh` is idempotent — it detects this and re-bootstraps. **Your services need the same pattern** if they're critical-path on Vault for startup.

For real production, switch Vault to Raft HA mode (3-node cluster, encrypted unseal keys). See `doc/audit-security-quantum-performance.md` for the migration plan.

---

## 6. Data layer — Postgres + Redis

### 6.1 Postgres

```
Host:     postgres
Port:     5432
User:     hara
Password: hara_dev_password (dev only)
```

**Carve out your own database**. Don't share `hara_indexer` (which is hara-registry's). Create `hara_did`:

```sql
-- Run this once during your hara-did's bootstrap (via a migration runner like ours)
CREATE DATABASE hara_did OWNER hara;
```

We have a migration runner pattern in `services/migrate/` you can copy. It applies SQL files from a directory in lexical order, tracks applied migrations in a `_migrations` table, and is idempotent.

**Connection from your services**:

```typescript
import pg from "pg";
const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? "postgres",
  port: 5432,
  user: process.env.POSTGRES_USER ?? "hara",
  password: process.env.POSTGRES_PASSWORD ?? "hara_dev_password",
  database: process.env.POSTGRES_DB ?? "hara_did",
  max: 20,                                     // tune per service
});
```

### 6.2 Postgres production tuning

hara-registry's production Postgres (`deploy/data/docker-compose.yml`) is tuned for NVMe with these settings:

```
max_connections = 300
shared_buffers = 512MB
effective_cache_size = 1500MB
work_mem = 8MB
maintenance_work_mem = 256MB
random_page_cost = 1.1
log_min_duration_statement = 500   # log slow queries
```

If hara-did adds heavy workloads, the platform team may need to scale Postgres up (bigger VPS or read replicas).

### 6.3 Redis

```
Host: redis
Port: 6379
```

Redis is partitioned by logical DB. Already used:

| DB | Used by | Purpose |
|---|---|---|
| 0 | broadcaster | Tx submission queue (`hara:tx:outbound` stream) |
| 3 | Blockscout | Account cache |
| 5 | rpc-cache | RPC response cache |

**Claim DBs for hara-did**:

| DB | Suggested use |
|---|---|
| **6** | did-batcher operation queue (mirrors broadcaster pattern) |
| **7** | did-resolver cache (cache resolved DID documents) |
| **8** | did-wallet session storage |
| 9–15 | future hara-did use |

Connect:
```typescript
import Redis from "ioredis";
const redis = new Redis({ host: "redis", port: 6379, db: 6 });
```

### 6.4 Redis production safety

`FLUSHALL` is disabled in our production Redis config (renamed to empty string). `FLUSHDB` still works on your own database. Stick to per-DB operations.

---

## 7. Existing contracts hara-did can use

### 7.1 AnchorRegistry — Merkle root anchoring

Use this for Sidetree batch anchoring. Each Sidetree batch produces a Merkle root that summarizes ~10,000 DID operations. Anchoring the root puts a tamper-proof commitment on-chain.

**Contract**: `contracts/src/AnchorRegistry.sol`
**Address on current dev chain**: re-deployed per chain reset — check `contracts/broadcast/Deploy.s.sol/131216/run-latest.json`
**ABI**:

```solidity
function recordAnchor(
    bytes32 merkleRoot,
    uint64 blockFrom,
    uint64 blockTo,
    uint64 eventCount,
    bytes32 anchorChain
) external returns (uint256 anchorId);

function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash) external;

event AnchorRecorded(uint256 indexed anchorId, bytes32 merkleRoot, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain);
event ExternalAnchorConfirmed(uint256 indexed anchorId, bytes32 anchorChain, bytes32 anchorTxHash);
```

Your role needs `ANCHOR_ROLE` to call `recordAnchor`. Grant it via `GovernanceContract` or directly by the admin during setup.

### 7.2 PQAnchorRegistry — quantum-safe anchoring (recommended)

For long-lived audit anchors (RSPO certificates, halal certifications, DID operation batches that need to remain unforgeable in 10–20 years), use the post-quantum version. It records the Merkle root **plus** a commitment hash to a separate ML-DSA-65 signature stored off-chain.

**Contract**: `contracts/src/PQAnchorRegistry.sol`
**ABI**:

```solidity
function recordAnchor(
    bytes32 merkleRoot,        // Keccak256
    bytes32 sha3Root,          // SHA3-256 of the SAME data (hash agility)
    uint64 blockFrom,
    uint64 blockTo,
    uint64 eventCount,
    bytes32 anchorChain,
    bytes32 pqSignatureHash    // Keccak256(ML-DSA-65 signature bytes)
) external returns (uint256 anchorId);

function rotatePQKey(bytes32 newKeyHash, string calldata newAlgorithm) external;

event AnchorRecorded(uint256 indexed anchorId, bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 pqSignatureHash, bytes32 pqKeyHash, bytes32 anchorChain);
event PQKeyRotated(bytes32 indexed oldKeyHash, bytes32 indexed newKeyHash, string newAlgorithm);
```

**Flow**:

1. hara-did's Sidetree batcher produces a Merkle root over a batch of DID operations.
2. The batcher signs the Merkle root with both:
   - ECDSA (for standard EVM clients)
   - ML-DSA-65 (NIST FIPS 204, post-quantum)
3. The ML-DSA signature blob (~3 KB) is stored in MinIO.
4. The batcher submits a tx to `PQAnchorRegistry.recordAnchor()` with the Merkle root + sha3Root + ECDSA tx signature (automatic) + hash of the ML-DSA signature.
5. Auditors fetch the ML-DSA signature blob from MinIO, recompute its Keccak256, compare to the on-chain commitment, then verify with the published ML-DSA public key.

This gives you **harvest-now-decrypt-later** protection: even when a CRQC arrives in 2030–2040 and ECDSA gets broken, the ML-DSA-side of the commitment remains unforgeable.

Pre-rotation ceremony: before recording your first PQ anchor, generate an ML-DSA-65 keypair (e.g. via `@noble/post-quantum`), publish the public key, and call `PQAnchorRegistry.rotatePQKey(keccak256(pubKey), "ML-DSA-65")`.

### 7.3 GovernanceContract — permissioned admin

For permissioned actions like registering a new IssuerDID, you can:

1. Implement governance directly in your contract (custom `AccessControl` roles)
2. Or delegate to the shared `GovernanceContract` (M-of-N multi-sig with proposal lifecycle)

Option 2 is recommended when the action requires multi-party approval (e.g. "BPJPH + MUI + 2 LPHs must agree to add this issuer"):

```solidity
function propose(address target, bytes calldata callData, uint256 value, string calldata description) external returns (uint256 id);
function approve(uint256 id) external;
function execute(uint256 id) external;
```

Set the `target` to your IssuerRegistry contract, the `callData` to the `addIssuer(...)` encoded call. After M approvals, anyone can call `execute(id)` and the IssuerRegistry call fires.

### 7.4 Other contracts (not relevant for hara-did unless integrating with palm-oil supply chain)

- `HaraPalmOil` (ERC-1155) — palm-oil batch tokens
- `TraceabilityBatchRelay` — batched custody transfers
- `ContractRegistry` — versioned contract address registry (you may want to register your own contracts here for discoverability)
- `TestToken` — for load testing only, ignore in prod

---

## 8. Service architecture — patterns to mirror

Our service tier is structured as a **pnpm workspace** at `services/`. Each service is independent but shares common utilities via `@hara/shared`. You should adopt the same pattern for hara-did to keep the operational story consistent.

### 8.1 Workspace structure

```
hara-did/services/
├── package.json                  workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── shared/                       common: Vault client, DB pool, Redis, logger, types
├── batcher/                       Sidetree batcher service
├── resolver/                      DID resolver REST API
├── witness/                       ZK witness service (for proofs)
├── wallet-api/                    Wallet backend
├── issuer-portal/                 Next.js issuer UI
├── admin-console/                 Next.js admin UI
└── migrate/                       Postgres migration runner (clone ours)
```

### 8.2 Service contract — what every service exposes

```
GET /healthz                 → { ok: true }            Liveness probe
GET /metrics                 → Prometheus exposition   For monitoring
[POST] /v1/...               → REST API                Your service's actual endpoints
```

We use **Fastify** for all our HTTP services — fast, type-safe, plays well with Prometheus. Consistent choice across the platform makes shared middleware possible.

### 8.3 Reference: signer service architecture

The hara-registry signer (`services/signer/src/index.ts`) is the model service. It:

1. Receives `POST /v1/tx { from, to, data, value, gasLimit? }`
2. Resolves the wallet → Vault key path lookup from `wallets` table in Postgres
3. Reserves a nonce atomically via `SELECT ... FOR UPDATE` on `wallet_nonces`
4. Signs the tx with the key fetched from Vault (cached in memory)
5. Inserts the signed tx into Postgres `transactions` table
6. Pushes to Redis Stream `hara:tx:outbound` for the broadcaster to pick up
7. Returns `{ txId, status: "QUEUED" }`

You don't have to use hara-registry's signer for hara-did — but you can. If hara-did issues thousands of transactions per day on behalf of issuers, plug into our signer:

```typescript
// hara-did service uses hara-registry's signer
async function submitDidOperation(from: Address, to: Address, data: Hex) {
  const res = await fetch("http://signer:7000/v1/tx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, data }),
  });
  return res.json();   // { txId, status }
}
```

Alternative: hara-did runs its own signer for full control. Either is fine; the pattern is the same.

### 8.4 Reference: indexer service architecture

The indexer (`services/indexer/src/`) polls the chain via `eth_getLogs`, decodes events against an ABI registry, and writes to Postgres. Same pattern works for hara-did's DID-event indexing:

- Maintain a cursor (`indexer_state.last_indexed_block`)
- Pull logs in batches of ~500 blocks
- Decode against a per-contract ABI registry (`abis.ts`)
- Insert in one DB transaction (block + events + cursor advance)
- Expose `/v1/...` REST endpoints over the indexed data

Critically: **add your contract addresses to the `watched_contracts` table** in the indexer's DB. The hara-registry indexer will then index your events too — or you can run a separate hara-did-only indexer if you want isolation.

To add your contract to the shared indexer:

1. Add the ABI to `services/indexer/src/abis.ts` (an entry in `AbiRegistry`).
2. Add a row to `watched_contracts`:
   ```sql
   INSERT INTO watched_contracts (contract_address, name)
   VALUES ('0x<your-contract-address>', 'YourContractName');
   ```
3. Restart the indexer.

It'll backfill events from genesis on next start.

### 8.5 Reference: rpc-cache service

`services/rpc-cache/` is a Fastify proxy in front of read RPC. Caches `eth_*` results in Redis with method-specific TTLs. **hara-did should use this for all read-heavy clients** (wallet APIs, verifier UIs, public resolvers).

Connection:
```typescript
const RPC_CACHE = "http://rpc-cache:8080";
const publicClient = createPublicClient({ transport: http(RPC_CACHE) });
```

99% hit rate measured on our pilot benchmark. Cuts validator load by ~75% on read-heavy traffic.

---

## 9. Deploying your own smart contracts

### 9.1 Foundry project setup

Use the same Foundry conventions as hara-registry:

```toml
# hara-did/contracts/foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc_version = "0.8.26"
evm_version = "london"               # CRITICAL — see §4.2
optimizer = true
optimizer_runs = 200
via_ir = false
chain_id = 131216

[rpc_endpoints]
local = "http://localhost:8545/rpc/write"
```

Install OpenZeppelin + forge-std the same way:

```bash
mkdir -p lib
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
```

### 9.2 Deploying a contract

```bash
forge script script/DeployIssuerRegistry.s.sol:DeployIssuerRegistry \
  --rpc-url http://localhost:8545/rpc/write \
  --broadcast \
  --legacy \
  --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Notes:
- `--legacy` is required (we don't have EIP-1559)
- `--skip-simulation` because our LB doesn't always cooperate with simulation
- The private key shown is the Foundry anvil default deployer; it's pre-funded in genesis. For real production use a deployer key from Vault.

### 9.3 Registering your contract for discoverability

Once deployed, register in `ContractRegistry` so other services can look up the canonical address by name:

```solidity
ContractRegistry.register(
  keccak256("IssuerRegistry"),   // name
  1,                              // version
  address(newIssuerRegistry)
);
```

Then anyone can call `ContractRegistry.getActive(keccak256("IssuerRegistry"))` to get the current address. Useful when you upgrade — old version stays registered for historical reads, new version becomes active.

### 9.4 Verifying contracts on Blockscout

After deploy, verify the source so anyone can read the ABI and decoded values in Blockscout:

```bash
forge verify-contract \
  <DEPLOYED_ADDRESS> \
  src/IssuerRegistry.sol:IssuerRegistry \
  --verifier blockscout \
  --verifier-url http://localhost:4000/api \
  --constructor-args $(cast abi-encode "constructor(address)" 0x<admin>)
```

The Blockscout UI at `http://localhost:4010/address/<addr>` will then show source + ABI + read/write methods.

---

## 10. Indexing hara-did events

You have three options for indexing your DID events:

### 10.1 Option A — Use hara-registry's indexer (recommended for shared events)

If your DID events are simple (mints, transfers, status changes) and don't need a custom projection, just add them to hara-registry's indexer:

1. Edit `services/indexer/src/abis.ts` and add your contract:
   ```typescript
   IssuerRegistry: parseAbi([
     "event IssuerRegistered(bytes32 indexed issuerId, uint8 role, address controller)",
     "event IssuerUpdated(bytes32 indexed issuerId, bytes32 publicKeyHash)",
     "event IssuerStatusChanged(bytes32 indexed issuerId, uint8 newStatus)",
     "event IssuerKeyRotated(bytes32 indexed issuerId, bytes32 oldKeyHash, bytes32 newKeyHash)",
   ]),
   ```
2. Insert into `watched_contracts` (see §8.4)
3. Restart the indexer
4. Your events appear in `indexed_events` table, decoded into JSONB

Pro: zero new services. Con: tight coupling between hara-registry and hara-did codebases.

### 10.2 Option B — Run a separate hara-did indexer

Clone `services/indexer/` into hara-did, change its connection to a separate Postgres DB (`hara_did`), point at hara-registry's RPC. Two indexer instances, fully independent.

Pro: full isolation, your team owns its indexer. Con: 2× memory cost, separate observability.

### 10.3 Option C — Subscribe to WebSocket events (real-time)

For latency-sensitive use cases (e.g. wallet shows "your VC has been issued!" within milliseconds), subscribe via WebSocket:

```typescript
import { createPublicClient, webSocket, parseAbi } from "viem";

const wsClient = createPublicClient({ transport: webSocket("ws://lb:8546/rpc/read") });

const unwatch = wsClient.watchContractEvent({
  address: ISSUER_REGISTRY_ADDR,
  abi: ISSUER_REGISTRY_ABI,
  eventName: "IssuerRegistered",
  onLogs(logs) {
    // logs[0].args = { issuerId, role, controller }
    // Push to UI via SSE/WebSocket/etc.
  },
});
```

WebSocket subscriptions are LB-routed (`/ws` → `rpc-read-1/2` with leastconn balancing). Tolerates one read node failing.

### 10.4 Derived views (custody_hops pattern)

The hara-registry indexer has SQL views layered on `indexed_events`:

- `custody_hops` — flat normalized hop view for traceability queries
- `batch_summary` — current state per batch

For hara-did you'd build similar views, e.g.:

- `did_operations` — flat history of every DID op (create, update, recover, deactivate)
- `did_state` — current state per DID
- `credential_status` — current revocation state per credential

Keep these as `CREATE VIEW` until ~1M events. Promote to `MATERIALIZED VIEW` at 1M+. Move to ClickHouse at 100M+ (L9 in roadmap).

---

## 11. Observability — metrics, logs, alerts

### 11.1 Prometheus metrics

Every hara-did service should expose `/metrics` in Prometheus exposition format. Use `prom-client` (Node) or equivalent.

**Metric naming convention** — prefix with `hara_did_`:

```typescript
import { Counter, Histogram, Gauge } from "prom-client";

export const didOpsTotal = new Counter({
  name: "hara_did_operations_total",
  help: "Total Sidetree operations processed",
  labelNames: ["op_type", "outcome"],   // create|update|recover|deactivate × success|fail
});

export const anchorLatency = new Histogram({
  name: "hara_did_anchor_latency_seconds",
  help: "Time from batch close to anchor confirmation",
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

export const watchedDids = new Gauge({
  name: "hara_did_resolver_cache_dids",
  help: "Number of cached DID documents in resolver",
});
```

### 11.2 Wire scrape config

Add your service to Prometheus's scrape targets at `_platform/prometheus/prometheus.yml`:

```yaml
scrape_configs:
  # ... existing jobs ...

  - job_name: hara-did
    metrics_path: /metrics
    static_configs:
      - targets:
          - did-batcher:9201
          - did-resolver:9202
          - did-witness:9203
          - did-wallet-api:9204
        labels:
          project: hara-did
          tier: services
```

Then `curl -X POST http://localhost:9090/-/reload` to apply.

### 11.3 Loki logs

If your service writes to stdout (JSON or plain), Promtail picks it up automatically via Docker discovery. Logs are queryable by:

```logql
{project="hara-did"}                        # all hara-did containers
{project="hara-did", service="batcher"}     # specific service
{project="hara-did"} |~ "(?i)error|fail"    # errors
```

**Recommendation**: use structured JSON logs (Pino in Node):

```typescript
import pino from "pino";
export const logger = pino({
  base: { service: process.env.SERVICE_NAME ?? "hara-did" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
logger.info({ op: "anchor", batchId: 123, root: "0x..." }, "anchored Sidetree batch");
```

This makes structured queries in Loki / Grafana trivial.

### 11.4 Grafana dashboards

Drop your dashboards as JSON files into `_platform/grafana/provisioning/dashboards/`. They auto-load on Grafana restart. Reference our existing ones (`besu-overview.json`, `rpc-cache.json`, `indexer.json`) for the patterns.

### 11.5 Alerts

Add alert rules to `_platform/prometheus/alert_rules.yml`. Example:

```yaml
- name: did.rules
  rules:
    - alert: DIDBatcherLag
      expr: hara_did_pending_operations > 10000
      for: 5m
      labels:
        severity: warning
        tier: services
        project: hara-did
      annotations:
        summary: "did-batcher has {{ $value }} pending operations, not anchoring fast enough"
        runbook: "ops/runbooks/alerts/DIDBatcherLag.md"

    - alert: DIDAnchorFailing
      expr: increase(hara_did_anchor_failures_total[10m]) > 3
      for: 5m
      labels:
        severity: critical
        tier: services
        project: hara-did
      annotations:
        summary: "DID anchor txs failing — check signer/chain/Vault"
```

Alerts fire to the shared alert-sink (or production Slack/PagerDuty).

---

## 12. Performance — using rpc-cache and JSON-RPC batching

### 12.1 When to use rpc-cache vs LB directly

| Client | Use |
|---|---|
| Read-heavy public APIs (wallet, verifier UI, public resolver) | `http://rpc-cache:8080` — 99% hit rate, sub-ms responses |
| Batch operations (Sidetree anchor batcher, mass issuance) | `http://lb:8545/rpc/write` — bypass cache (writes shouldn't be cached anyway) |
| Internal infrastructure (indexer, broadcaster) | `http://lb:8545/rpc/read` — cache TTLs would mask race conditions |
| WebSocket subscriptions | `ws://lb:8546/rpc/read` — cache doesn't apply |

### 12.2 Connection settings (every Node service)

Use `undici` agent for HTTP keep-alive (5–10× lower TCP setup overhead):

```typescript
import { setGlobalDispatcher, Agent } from "undici";
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  connections: 100,
  pipelining: 1,
}));
```

Put this at the top of every service that makes outbound HTTP. viem's `http()` transport picks it up automatically.

### 12.3 Submitting in bulk

Sidetree anchor batches need to submit thousands of operations cheaply. Two patterns:

**Pattern A — Single relay tx per batch (recommended)**

Mirror hara-registry's `TraceabilityBatchRelay.executeChain()`:

```solidity
contract SidetreeBatchAnchorRelay {
    function recordBatch(
        IPQAnchorRegistry registry,
        bytes32 merkleRoot,
        bytes32 sha3Root,
        bytes32 anchorChain,
        bytes32 pqSignatureHash,
        // ...
    ) external {
        registry.recordAnchor(merkleRoot, sha3Root, 0, 0, 0, anchorChain, pqSignatureHash);
        emit BatchAnchored(merkleRoot, msg.sender);
    }
}
```

One tx per Sidetree batch (which itself contains thousands of DID ops). Very efficient.

**Pattern B — JSON-RPC batched submission**

If you have many independent transactions (e.g. mass DID-method-document publishes), use JSON-RPC batching (§4.4). 1000 txs in 1 HTTP POST.

---

## 13. Production deployment — joining deploy/

When hara-did is ready for production, mirror hara-registry's `deploy/` structure:

```
hara-did/deploy/
├── README.md
├── services/                  All hara-did app services (batcher, resolver, witness, wallet-api)
│   ├── docker-compose.yml
│   └── .env.example
├── frontend/                  Next.js apps (issuer-portal, admin-console, verifier-demo)
│   ├── docker-compose.yml
│   └── .env.example
└── ops/
    └── secrets-bootstrap.sh   Mirrors ours
```

### 13.1 Compose file conventions

```yaml
# hara-did/deploy/services/docker-compose.yml
name: hara-did-services

services:
  did-batcher:
    build:
      context: ../../services
      dockerfile: batcher/Dockerfile
    image: hara-did-batcher:latest
    container_name: hara-did-batcher
    restart: unless-stopped
    networks:
      hara-platform:
        ipv4_address: 10.42.0.50    # from your reserved range 50-69
    environment:
      SERVICE_NAME: did-batcher
      VAULT_ADDR: http://vault:8200
      VAULT_TOKEN: ${VAULT_TOKEN:?required}
      POSTGRES_HOST: postgres
      POSTGRES_USER: ${POSTGRES_USER:?required}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: hara_did
      REDIS_HOST: redis
      REDIS_DB: 6
      RPC_WRITE_URL: http://lb:8545/rpc/write
      RPC_READ_URL: http://rpc-cache:8080
      LOG_LEVEL: info

# hara-platform created by hara-registry's platform stack — external
networks:
  hara-platform:
    name: hara-platform
    external: true
```

### 13.2 Required environment variables

`${VAULT_TOKEN}` and `${POSTGRES_PASSWORD}` should be **inherited from the platform's .env** (because they have to match what the platform created). hara-did's `secrets-bootstrap.sh` should read those values from hara-registry's `.env` files or directly from Vault.

### 13.3 VPS sizing (from `doc/nevacloud-proposal.md`)

For Indonesian pilot scale, hara-did needs **2 VPS**:

| Hostname | Role | Spec | Cost |
|---|---|---|---:|
| did-services | batcher + resolver + witness + wallet-api + zk-prover | 8 vCPU / 16 GB / 500 GB NVMe | Rp 1.5M/mo |
| did-frontend | issuer-portal + admin-console + verifier-demo | 4 vCPU / 8 GB / 100 GB NVMe | Rp 700K/mo |
| Object Storage | Sidetree CAS, ZK trusted-setup artifacts | 200 GB | Rp 200K/mo |

Total: ~Rp 2.5M/mo for hara-did (P1a phase). See `doc/nevacloud-proposal.md` for full proposal.

### 13.4 Cloud-init pattern

Same as hara-registry's `deploy/ops/cloud-init.yaml` — clone hara-did repo, install Docker, set up WireGuard mesh node, then bring up compose.

---

## 14. Security checklist

Before going to production, verify:

### 14.1 Secrets

- [ ] No `.env` file committed (use `.gitignore` from hara-registry as template)
- [ ] Vault is in production mode (Raft HA + AppRole auth, not dev/root-token)
- [ ] Each hara-did service has its own Vault AppRole with minimal scope
- [ ] Issuer signing keys live in Vault, never on disk or in env vars
- [ ] Postgres credentials rotated per environment

### 14.2 Network

- [ ] hara-did services don't expose internal ports to public internet directly
- [ ] All user-facing endpoints (issuer-portal, verifier-demo) go through TLS termination (Caddy/Nginx)
- [ ] CORS allowlist is explicit (not `*`)
- [ ] HAProxy / cache rate limits configured for public-facing routes

### 14.3 Smart contracts

- [ ] All contracts have Foundry tests with > 80% coverage
- [ ] Slither static analysis in CI (mirror `.github/workflows/slither.yml`)
- [ ] External audit performed before P2 (regulator-facing) launch
- [ ] Critical functions guarded by `AccessControl`, not just `onlyOwner`
- [ ] Upgradeable contracts use `UUPSUpgradeable` pattern + timelock

### 14.4 Quantum-readiness

- [ ] Long-lived audit anchors use `PQAnchorRegistry` (hybrid ECDSA + ML-DSA-65)
- [ ] DID documents include both classical (Ed25519) and PQ (ML-DSA) public keys per W3C VC Data Integrity spec
- [ ] Holder wallets use hybrid key generation (see `haradid-pathway.md` Decision 10)
- [ ] TLS uses hybrid X25519MLKEM768 KEM where supported (Caddy 2.7+, OpenSSL 3.5+)

### 14.5 Observability

- [ ] Every service exposes `/metrics` and `/healthz`
- [ ] Loki captures all container logs (`project="hara-did"` label set automatically)
- [ ] Alert rules defined for service-down, queue-lag, anchor-failure (§11.5)
- [ ] Alerts route to a real notification channel (Slack/PagerDuty/email) — not the dev alert-sink

See `SECURITY.md` at the repo root for the full responsible-disclosure policy.

---

## 15. API contracts you may need

### 15.1 hara-registry's signer API

```
POST /v1/tx
Content-Type: application/json
Body: { "from": "0x...", "to": "0x...", "data": "0x...", "value": "0", "gasLimit": 200000 }
→ 200 OK { "txId": "uuid", "status": "QUEUED" }

GET /v1/tx/:txId
→ 200 OK { "tx_id": "uuid", "status": "CONFIRMED", "tx_hash": "0x...", "block_number": "1234", ... }
```

Status progression: DRAFT → QUEUED → BROADCASTED → CONFIRMED (or REVERTED / FAILED / RETRYING).

### 15.2 hara-registry's indexer API (traceability)

```
GET /v1/batches?limit=50&offset=0
→ { items: [...] }

GET /v1/batches/:batchId
→ { batch_id, initial_liters, first_owner, current_holder, hop_count, rspo_hash, plantation_id, ... }

GET /v1/batches/:batchId/hops
→ { hops: [{ liters, from_addr, to_addr, operator_addr, tx_hash, block_number, occurred_at }, ...] }

GET /v1/batches/:batchId/graph?aggregate=true
→ { batch, nodes: [...], edges: [...], aggregated: true }

GET /v1/holders/:address/batches
→ { address, batches: [batchId, ...] }
```

These are for palm-oil traceability. hara-did would mirror this pattern for DID lookups:

```
GET /v1/dids                    → list issuer DIDs
GET /v1/dids/:did               → resolve DID document
GET /v1/dids/:did/operations    → history of DID operations
GET /v1/credentials/:vcId       → credential status (revoked/active/expired)
GET /v1/holders/:did/credentials → all credentials issued to this DID
```

### 15.3 hara-registry's rpc-cache

```
POST /                           Same body as Besu JSON-RPC, returns cached or proxied
GET /metrics                     Prometheus exposition
GET /cache/stats                 { keyCount, memory: [...] }
GET /healthz
```

---

## 16. Versioning + migration strategy

### 16.1 Chain migrations (P3+)

hara-registry plans to migrate from Besu QBFT to Avalanche Subnet around P3 (per `doc/hara-registry-roadmap.md`). For your contracts to survive that:

1. **Never use chain-id-specific assumptions** (chainId from a runtime call, not a constant)
2. **Use UUPS upgradeable pattern** for any long-lived contract — you'll redeploy on the new chain and point a proxy at fresh logic
3. **Store all hara-did state as events**, not just storage slots — events are easily replayed on a new chain
4. **Test against both Besu and a local Anvil** in CI to catch any divergence early

### 16.2 Contract versioning via ContractRegistry

When you deploy a new IssuerRegistry version:

```solidity
contractRegistry.register(keccak256("IssuerRegistry"), 2, address(newIssuerRegistry));
contractRegistry.setActiveVersion(keccak256("IssuerRegistry"), 2);
```

Old version stays registered for historical reads. Services that look up by name automatically pick up v2.

### 16.3 Database schema migrations

Use the migration runner pattern from `services/migrate/`. Files in `services/migrations/` are applied in lexical order; each run records what's applied in a `_migrations` table.

Naming: `0XX_description.sql`. Examples for hara-did: `001_did_schema.sql`, `002_credential_status.sql`, `003_zk_witness_index.sql`.

### 16.4 RPC API changes

If you change an API endpoint, version it: `/v1/...` → `/v2/...`. Don't break existing clients. Document deprecation timeline.

---

## 17. Troubleshooting

### 17.1 "Network hara-platform not found"

You started hara-did before hara-registry's platform stack. Run `make platform-up` in hara-registry first. The network is created by `_platform/docker-compose.yml`.

### 17.2 "Transaction reverted with no reason"

Most likely cause: contract compiled with Shanghai EVM (uses PUSH0 opcode) — our chain only supports London. Fix: set `evm_version = "london"` in `foundry.toml`.

### 17.3 "eth_sendRawTransaction returns nonce too low"

Your local nonce is behind the chain. Either restart your service (it'll re-fetch from chain) or use hara-registry's signer service which manages this automatically via Postgres.

### 17.4 "Tx submitted but never confirmed"

Most likely the sender wallet has 0 native HARA balance. Besu silently skips zero-balance senders even at gasPrice=0. Fix: have the deployer (Foundry anvil #0, pre-funded in genesis) send 1 wei to each of your operational wallets first. See `ops/load-tests/scenario-palm-oil-batch-relay.ts` Phase 2a for the priming pattern.

### 17.5 "Vault key not found after restart"

Vault is in dev mode (`-dev` flag). Restart = all keys lost. Fix: re-run your service's bootstrap that pushes keys back to Vault. For production, switch to Raft HA mode.

### 17.6 "WebSocket connection drops every 60 seconds"

HAProxy has a `timeout client` of 1h for WS but some upstream proxies might enforce shorter idle timeouts. Send a no-op subscribe call every 30s as keepalive.

### 17.7 "Indexer doesn't see my contract's events"

Did you (a) add the ABI to `services/indexer/src/abis.ts`, (b) insert into `watched_contracts`, (c) restart the indexer? All three are required. After restart, the indexer will backfill from `from_block` configured in the row (default 0).

### 17.8 Useful debugging commands

```bash
# Chain alive?
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545/rpc/read

# Tx in mempool?
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"txpool_status","params":[],"id":1}' \
  http://localhost:8545/rpc/read

# Contract code deployed?
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x<addr>","latest"],"id":1}' \
  http://localhost:8545/rpc/read

# Container logs
docker logs hara-validator1 --tail 50
docker logs hara-signer --tail 50

# Postgres direct query
docker exec hara-postgres psql -U hara -d hara_indexer -c "SELECT * FROM transactions ORDER BY created_at DESC LIMIT 5"
```

---

## 18. Reference: every endpoint, port, IP, address

### 18.1 Host-side URLs (from outside Docker, e.g. your laptop)

| Service | URL |
|---|---|
| Chain RPC HTTP (read) | http://localhost:8545/rpc/read |
| Chain RPC HTTP (write) | http://localhost:8545/rpc/write |
| Chain RPC WebSocket | ws://localhost:8546/rpc/read |
| HAProxy stats | http://localhost:8404/stats |
| Signer API | http://localhost:7000 |
| Indexer / traceability API | http://localhost:9100 |
| Indexer Prometheus metrics | http://localhost:9100/metrics |
| RPC cache | http://localhost:8088 |
| Blockscout API | http://localhost:4000/api/v2 |
| Blockscout UI | http://localhost:4010 |
| Vault UI | http://localhost:8200 (token: `haraledger-dev-root`) |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| Loki HTTP API | http://localhost:3201 |
| Grafana | http://localhost:3200 (admin/admin) |
| Postgres | localhost:5432 (user `hara`, password `hara_dev_password`) |
| Redis | localhost:6379 |

### 18.2 In-network DNS names (from inside a container on hara-platform)

| Service | URL |
|---|---|
| RPC HTTP read | http://lb:8545/rpc/read |
| RPC HTTP write | http://lb:8545/rpc/write |
| RPC WebSocket | ws://lb:8546/rpc/read |
| RPC direct read | http://rpc-read-1:8545, http://rpc-read-2:8545 |
| RPC direct write | http://rpc-write:8545 |
| RPC cache | http://rpc-cache:8080 |
| Signer | http://signer:7000 |
| Indexer | http://indexer:9100 |
| Vault | http://vault:8200 |
| Postgres | postgres:5432 |
| Redis | redis:6379 |
| Prometheus | http://prometheus:9090 |
| Alertmanager | http://alertmanager:9093 |
| Loki | http://loki:3100 |
| Grafana | http://grafana:3000 |

### 18.3 Static IPs in 10.42.0.0/24

| IP | Container |
|---|---|
| 10.42.0.1 | gateway (Docker bridge) |
| 10.42.0.2 | vault |
| 10.42.0.3 | prometheus |
| 10.42.0.4 | alertmanager |
| 10.42.0.5 | alert-sink |
| 10.42.0.6 | loki |
| 10.42.0.7 | grafana |
| 10.42.0.8 | promtail |
| 10.42.0.11–14 | validator1, validator2, validator3, validator4 |
| 10.42.0.21–22 | rpc-read-1, rpc-read-2 |
| 10.42.0.23 | rpc-write |
| 10.42.0.30 | lb (HAProxy) |
| 10.42.0.40 | signer |
| 10.42.0.41 | broadcaster |
| 10.42.0.42 | indexer |
| 10.42.0.43 | blockscout |
| 10.42.0.44 | blockscout-fe |
| 10.42.0.45 | postgres |
| 10.42.0.46 | redis |
| 10.42.0.47 | rpc-cache |
| **10.42.0.50–69** | **hara-did (reserved for you)** |
| 10.42.0.70–89 | hara-xchange (reserved) |
| 10.42.0.100–119 | hara-halal-passport (reserved) |

### 18.4 Chain identity

```
Chain ID:        131216
Block time:      2 seconds
Consensus:       QBFT (Hyperledger Besu 26.4.0)
Validators:      4
EVM hardfork:    London
Native currency: HARA
Gas price:       0 (free-gas chain for whitelisted senders)
```

### 18.5 Useful contract addresses (current dev chain)

Verify by reading `contracts/broadcast/*.s.sol/131216/run-latest.json` after each deployment — addresses change per chain reset because they're deployer-nonce-deterministic. Currently (commit `f843fb5`):

```
HaraPalmOil:               0xa31f4c0ef2935af25370d9ae275169ccd9793da3
TraceabilityBatchRelay:    0xf9c0bf1cfaab883adb95fed4cfd60133bffab18a
```

If `ContractRegistry`, `AnchorRegistry`, `PQAnchorRegistry`, `GovernanceContract` are deployed on your chain, look them up via:

```
cast call <ContractRegistry-addr> "getActive(bytes32)(address)" \
  $(cast keccak "AnchorRegistry") \
  --rpc-url http://localhost:8545/rpc/read
```

### 18.6 Vault secret paths

```
secret/haraledger/validators/1            Validator 1 private key
secret/haraledger/validators/2            Validator 2 private key
secret/haraledger/validators/3            Validator 3 private key
secret/haraledger/validators/4            Validator 4 private key
secret/haraledger/signer-keys/deployer    Foundry anvil #0 (dev only)

secret/haradid/...                         RESERVED FOR YOU — see §5.2
```

### 18.7 Redis logical DBs

```
db 0    broadcaster tx queue
db 3    Blockscout cache
db 5    rpc-cache
db 6    RESERVED for hara-did
db 7    RESERVED for hara-did
db 8    RESERVED for hara-did
```

### 18.8 Postgres databases

```
hara_indexer           hara-registry's indexer + signer + blockscout app schemas
blockscout             Blockscout's own DB
hara_did               RESERVED — create this for hara-did
hara_passport          RESERVED for hara-passport
hara_xchange           RESERVED for hara-xchange
```

---

## Closing

This manual is the integration contract between hara-registry and hara-did. If something in here is wrong, ambiguous, or missing, **open an issue or PR against hara-registry** — keep the manual living.

For deeper context:

- `doc/hara-registry-roadmap.md` — phases P0–P3 deployment plan
- `doc/haradid-pathway.md` — hara-did architecture decisions
- `doc/haradid-roadmap.md` — hara-did development roadmap
- `doc/haraledger_ecosystem_development_blueprint.md` — overall blueprint
- `doc/audit-security-quantum-performance.md` — security + quantum strategy
- `doc/nevacloud-proposal.md` — VPS proposal across hara-registry + hara-did + hara-passport
- `deploy/README.md` — production deployment layout
- `SECURITY.md` — responsible disclosure policy

**Welcome to the platform. Let's ship.**
