# HaraLedger → hara-did Integration Information

Handoff document for the hara-did team. Contains everything hara-did needs to deploy against the actual production HaraLedger chain.

Last updated: 2026-05-27. Chain state: ~12K blocks, all systems live.

---

## 1. Network reachability

**Recommendation: WireGuard mesh (option b in your list)**. Public-internet over TLS works for testing but adds latency on every chain query.

HaraLedger is on its own WireGuard mesh at **10.43.0.0/24**. Hosts:

| Role | WG IP | Public IP |
|---|---|---|
| hara-stateful (Vault, Postgres, Redis, MinIO) | 10.43.0.40 | 103.67.244.250 |
| hara-stateless (RPC, services, edge) | 10.43.0.20 | 202.155.91.66 |
| hara-v1..v4 (validators, no user RPC) | 10.43.0.11..14 | — |

**To onboard `hara-did-stg` to the mesh:**

1. Operator (us) generates a new WG keypair for `hara-did-stg` and adds it as a peer to all 5 existing hosts.
2. We assign you a WG IP from the same /24 (suggested: `10.43.0.50`).
3. We send you the `wg0.conf` snippet with `[Interface]` private key + `[Peer]` entries for all 5 endpoints.
4. You install WireGuard on the hara-did VPS, drop in the config, `wg-quick up wg0`.
5. From hara-did-stg you can then reach `10.43.0.20:8545` (chain LB), `10.43.0.40:8200` (Vault), `10.43.0.40:5432` (Postgres) directly.

If WG isn't an option, use the public endpoints in §2 over TLS. Latency cost is ~80-200ms RTT per chain call from Indonesia (vs <2ms over WG).

**Action needed from hara-did**: confirm whether you'll use WG, and provide a public IP for the hara-did-stg VPS so we can add it as a WG peer.

---

## 2. Chain RPC endpoints

### Via public TLS (Caddy → HAProxy → Besu)
```
HARALEDGER_RPC_READ_URL=https://rpc.ledger.haratrust.io/read/
HARALEDGER_RPC_WRITE_URL=https://rpc.ledger.haratrust.io/write/
HARALEDGER_RPC_WS_URL=wss://rpc.ledger.haratrust.io/ws
HARALEDGER_CHAIN_ID=131216
```

### Via WG mesh (preferred, lower latency)
```
HARALEDGER_RPC_READ_URL=http://10.43.0.20:8545/rpc/read
HARALEDGER_RPC_WRITE_URL=http://10.43.0.20:8545/rpc/write
HARALEDGER_RPC_WS_URL=ws://10.43.0.20:8545/ws
HARALEDGER_CHAIN_ID=131216
```

**Chain config:**
- Consensus: QBFT, 2s block period, 4 validators
- Gas price: **0** (zeroBaseFee, `gasPrice=0` in all txs)
- Block gas limit: `0x1fffffffffffff` (effectively unbounded)
- HAProxy rate limit: 5000 requests / 10s per source IP

### Known caveat
**Use `/write/` for both reads and writes until further notice.** A null-receipt caching bug in `rpc-cache` (fix in commit `f46d2be`, not yet deployed to hara-stateless) means `/read/` can briefly return null receipts for newly-mined txs. `/write/` bypasses the cache. We'll deploy the fix soon; you'll get a heads-up when it's safe to use `/read/`.

---

## 3. Platform contract addresses

All deployed on chain 131216. Verified live on-chain as of 2026-05-27.

```
CONTRACT_REGISTRY_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
GOVERNANCE_CONTRACT_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
PQ_ANCHOR_REGISTRY_ADDRESS=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
ANCHOR_REGISTRY_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
```

`ANCHOR_REGISTRY` is the legacy ECDSA-only anchor; `PQ_ANCHOR_REGISTRY` is the ML-DSA-65 (FIPS 204) production one. Hara-did should use `PQ_ANCHOR_REGISTRY` for anything new; the legacy one is kept for backwards compatibility only.

**IssuerRegistry** is not centrally deployed — hara-did deploys its own and registers it in `ContractRegistry`.

Other contracts on-chain that hara-did probably doesn't need but for completeness:
- HaraPalmOil (ERC-1155): `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`
- TraceabilityBatchRelay: `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`

---

## 4. Vault access for hara-did

**Vault address (over WG):** `http://10.43.0.40:8200`
**Vault address (over TLS, when WG isn't available):** TBD — we have not yet exposed Vault publicly. WG is the only path right now.

Vault is HashiCorp Vault 1.17, Raft backend, 5/3 unseal quorum.

### What we'll provide (action on hara-ledger side)

A scoped AppRole `haradid` with a policy granting:
- `read,create,update,delete` on `secret/data/haradid/signer-keys/*`
- `read,create,update,delete` on `secret/data/haradid/pq-keys/*`
- `read,create,update,delete` on `secret/data/haradid/issuer-bbs-keys/*`
- `read,list` on `secret/metadata/haradid/*`

The policy will be named `haradid-policy`. We'll send you:
```
VAULT_ADDR=http://10.43.0.40:8200
VAULT_ROLE_ID=<uuid>
VAULT_SECRET_ID=<uuid>
```

**Do not use direct VAULT_TOKEN.** AppRole is the production-supported path. Token lifecycle (renewal, rotation) is managed via the AppRole.

The `secret_id` is single-use by default; once you've used it to log in, your service should renew its own token on a schedule. Standard Vault AppRole flow.

### Action needed from hara-did

Confirm:
- The 3 secret paths above are the correct set (anything missing?).
- Whether you need any read access to platform secrets (e.g., the anchor-worker's address to whitelist as anchor signer). If yes, list the specific paths so we can add them to the policy.

---

## 5. Shared Postgres access

Postgres 16-alpine on hara-stateful. Schema `hara_indexer` contains:
- `watched_contracts` (which contracts the indexer is event-tailing)
- `pq_anchor_signatures` (ML-DSA signature blob index)
- Other indexer tables

**Connection (over WG):**
```
PQ_INDEX_DATABASE_URL=postgresql://haradid:<password>@10.43.0.40:5432/hara_indexer
```

### What we'll provide

A Postgres role `haradid` with:
- `INSERT, SELECT` on `hara_indexer.pq_anchor_signatures`
- `SELECT` on `hara_indexer.watched_contracts` (read-only)
- No access to other tables

We'll send the password out-of-band (1Password share or similar — not in this file).

### Schema reference for `pq_anchor_signatures`
```sql
commitment_hash bytea(32) PRIMARY KEY,
algo            text NOT NULL,         -- 'ml-dsa-65'
signer_did      text NOT NULL,
anchor_tx_hash  bytea(32) NOT NULL,
bucket          text DEFAULT 'hara-pq-anchors',
object_key      text NOT NULL,
size_bytes      integer NOT NULL,
created_at      timestamptz DEFAULT now()
```

The blob itself goes to MinIO bucket `hara-pq-anchors` (see §6 if you need MinIO too).

### Action needed from hara-did

- Confirm `pq_anchor_signatures` is the only table hara-did writes to.
- If hara-did wants to register its contracts in `watched_contracts` so they're auto-indexed by `services/indexer`, send us the addresses + names and we'll INSERT them (or grant you INSERT on that table too — your call).

---

## 6. MinIO (PQ anchor blob storage)

If hara-did's anchor-oracle uploads ML-DSA signature blobs to S3-compatible storage, we have MinIO ready:

```
MINIO_ENDPOINT=http://10.43.0.40:9000
MINIO_REGION=us-east-1
MINIO_BUCKET=hara-pq-anchors
MINIO_ACCESS_KEY=<we'll provision>
MINIO_SECRET_KEY=<we'll provision>
```

Public read access via Caddy is also available if you need blob URLs to be resolvable from outside: `https://anchors.ledger.haratrust.io/<object-key>` (if you need this, ask — not wired up yet).

---

## 7. Deployer key + role grants

This is the only piece that requires care — the deployer key has admin rights that touch live chain state.

### Current state (do not use)

The chain was bootstrapped with **anvil-0** (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`) as deployer and admin. This is the well-known anvil test key (`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`). It currently holds `DEFAULT_ADMIN_ROLE` on most platform contracts.

**It is on our priority list to rotate this out** before any external partner deploys against the chain. We can do that rotation in conjunction with onboarding hara-did.

### Proposed flow

1. **hara-did generates a fresh deployer key** locally. Sends us the address (NOT the private key).
2. **HaraLedger admin grants the new address** the minimum roles needed:
   - `REGISTRAR_ROLE` on `ContractRegistry` (so hara-did can register its DIDRegistry, RevocationRegistry, etc. by name)
   - `DEFAULT_ADMIN_ROLE` on `PQAnchorRegistry` (so hara-did can grant `ANCHOR_ROLE` and `KEY_ROTATOR_ROLE` to its own anchor-oracle signer)
3. **HaraLedger admin funds the new deployer** with ~100 HARA (more than enough for 10 deploys + 20 role-grants; chain is gasless but txs still need ≥1 wei).
4. hara-did uses that key in its `infra/scripts/deploy-staging-contracts.sh`.

### Action needed from hara-did

Send us the deployer **address** (not the key). We'll grant + fund it from the current admin key, and confirm to you that it's ready. ETA: same business day.

---

## 8. Summary `.env.staging` template (populated)

```bash
# Network (assuming WG)
HARADID_PUBLIC_DOMAIN=staging.haradid.id              # your choice
ACME_EMAIL=ops@haradid.id                              # your choice

# Chain
HARALEDGER_RPC_READ_URL=http://10.43.0.20:8545/rpc/write    # NOTE: /write/ on purpose, see §2 caveat
HARALEDGER_RPC_WRITE_URL=http://10.43.0.20:8545/rpc/write
HARALEDGER_RPC_WS_URL=ws://10.43.0.20:8545/ws
HARALEDGER_CHAIN_ID=131216

# Platform contracts
CONTRACT_REGISTRY_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
GOVERNANCE_CONTRACT_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
PQ_ANCHOR_REGISTRY_ADDRESS=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
ANCHOR_REGISTRY_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0

# Vault — AppRole (we provision; values sent separately)
VAULT_ADDR=http://10.43.0.40:8200
VAULT_ROLE_ID=<from us>
VAULT_SECRET_ID=<from us>

# Shared Postgres — password sent separately
PQ_INDEX_DATABASE_URL=postgresql://haradid:<password>@10.43.0.40:5432/hara_indexer

# MinIO (if used)
MINIO_ENDPOINT=http://10.43.0.40:9000
MINIO_REGION=us-east-1
MINIO_BUCKET=hara-pq-anchors
MINIO_ACCESS_KEY=<from us>
MINIO_SECRET_KEY=<from us>

# Deployer — hara-did generates locally, sends us the address; we fund + grant
DEPLOYER_PRIVATE_KEY=<your fresh key>

# hara-did internal — hara-did manages these itself
GOVERNANCE_PROPOSER_PRIVATE_KEY=<hara-did manages>
```

---

## 9. Known issues to be aware of

Production caveats from recent operations (so you don't spend an hour debugging the same things we did):

1. **`/read/` endpoint can return stale null receipts** during high write throughput because rpc-cache caches null results. Use `/write/` for receipt lookups until commit f46d2be is deployed. Should be deployed within the week.

2. **rpc-write tx pool can briefly disable itself during heavy load**. Symptom: `eth_sendRawTransaction` returns `"Transaction pool not enabled. (Either txpool explicitly disabled, or node not yet in sync)."` This happens when rpc-write falls 1+ block behind validators during high-gas-block import. **Mitigation in your code:** retry on this error message after a 3-5s delay. The pool re-enables automatically within a few seconds.

3. **Per-sender pool capacity is ~200 sequential txs** under sustained heavy load. If hara-did batches 400+ txs from one signer back-to-back, queue them with confirmation waits between groups of ~25 instead of submitting all at once. Above ~200 the chain rejects until the pool drains.

4. **Chain ID is 131216** (not 1 / 31337 / anything else). Always set explicitly in signed txs; some libraries default to 1 which causes signature rejection.

---

## 10. What we need from hara-did to provision your access

A short reply (or PR to this doc) with:

| Item | What we need |
|---|---|
| WG onboarding | Public IP of `hara-did-stg` VPS, your preferred WG IP (any free /24 host in 10.43.0.X) |
| Vault policy | Confirm the 3 secret paths in §4 cover hara-did's needs, or send the full list |
| Postgres | Confirm only `pq_anchor_signatures` is written, and whether you want `watched_contracts` INSERT too |
| MinIO | Whether you'll use it (yes/no) |
| Deployer | Deployer **address** (not key) for funding + role grants |

Turnaround on our side once we have those five answers: same business day for onboarding, plus one quick handover call to share the WG config + Vault secret_id + Postgres password out-of-band.

---

## Contact

Ops: HaraLedger team (this session). Drop questions / blockers in the project Slack or open an issue against the `hara-ledger` repo.

The HaraLedger source for everything above is in this repo:
- Contract addresses: deployed via [deploy/ops/](deploy/ops/) bring-up scripts
- Vault setup: [deploy/ops/vault-approle-bootstrap.sh](deploy/ops/vault-approle-bootstrap.sh)
- Network: [deploy/ops/wg-bootstrap.sh](deploy/ops/wg-bootstrap.sh)
- Schema: [services/indexer/](services/indexer/) (creates `pq_anchor_signatures` on startup)
