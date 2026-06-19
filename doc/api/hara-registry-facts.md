# Hara Registry — Canonical Facts (single source of truth)

> **Purpose:** every developer-facing artifact (manuals, OpenAPI spec, API console,
> and the TypeScript/Python/Go SDKs) MUST agree with this file. If something here
> is wrong, fix it here first, then propagate. Verified against the live chain +
> repo on 2026-06-08.

Hara Registry (formerly *HaraLedger* / *hara-ledger*) is a permissioned Hyperledger
Besu (QBFT) blockchain for **palm-oil supply-chain traceability** with
**post-quantum (PQ) audit anchoring**, plus the services around it (indexer + trace
API, explorer, RPC cache, observability, and the Strata operations console).

---

## 1. Chain identity (INVARIANTS — never change)

| Property | Value |
|---|---|
| Chain ID | **131216** |
| Consensus | QBFT (Hyperledger Besu), 4 validators, tolerates 1 fault (quorum 3/4) |
| Block time | ~2 seconds, instant finality |
| Gas price | **0** (`zeroBaseFee` genesis) — free chain |
| Tx type | **legacy (type 0)** only, `gasPrice: 0` — EIP-1559 type-2 is NOT accepted |
| EVM target | **London** — Shanghai `PUSH0` is NOT supported (compile with `evm_version="london"`) |
| Native token | HARA (used only for gas accounting; gas is free) |
| Client | Besu 26.4.0 (Bonsai storage) |
| RPC namespaces | `eth, net, web3, qbft, txpool, debug, trace` (`admin` disabled) |
| Max JSON-RPC batch | 200 (public LB); Besu nodes accept up to 4096 |
| Rate limit | HAProxy ~5,000 requests / 10 s per source IP; 32k concurrent |

**Three rules that bite every integrator:**
1. **Legacy txs, `gasPrice 0`, `chainId 131216`.** Always. EIP-1559 fields are rejected.
2. **Pre-fund ≥ 1 wei native HARA to any wallet before its first tx.** Besu silently
   skips zero-balance senders even at gasPrice 0 — the tx sits unmined and your tool hangs.
3. **Verify `receipt.status == 0x1`.** A mined tx can still have reverted.

---

## 2. Public endpoints

| URL | What | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC reads (via rpc-cache + LB) | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC writes (`eth_sendRawTransaction`) | none |
| `https://rpc.ledger.haratrust.io/ws` | JSON-RPC WebSocket (subscriptions) | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout explorer (+ `/api/v2/*`) | none |
| `https://trace.ledger.haratrust.io/` | Traceability REST API (`/v1/*`) + DAG viewer | **HTTP Basic** |

> **The trailing slash matters** on `/read/` and `/write/` — `…/read` (no slash)
> returns `404 Route not found`.
> **Reads → `/read/`** (cached); **writes → `/write/`** (`eth_sendRawTransaction`).
> WebSocket subscriptions and live reads use the LB directly.

WG-mesh internal equivalents (for services on the WireGuard mesh, not for external use):
RPC `http://10.43.0.21:8545/rpc/{read,write}`, WS `ws://10.43.0.21:8546/rpc/read`.

---

## 3. Smart contracts (deployed on chain 131216)

| Contract | Address | Standard / role |
|---|---|---|
| **HaraPalmOil** | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | ERC-1155; 1 token = 1 **litre**; each `TransferSingle` = a custody hop |
| **TraceabilityBatchRelay** | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | executes N custody hops in one tx |
| **PQAnchorRegistry** | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | post-quantum (ML-DSA-65) audit anchors |
| **ContractRegistry** | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | name → address registry for platform contracts |
| **GovernanceContract** | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | role-gated governance (N-of-M) |
| **AnchorRegistry** (legacy) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | legacy ECDSA-only anchoring (compat) |

Full ABIs live in the repo at `contracts/out/<Name>.sol/<Name>.json` (`.abi`) and the
Solidity sources at `contracts/src/<Name>.sol`.

### 3.1 HaraPalmOil (ERC-1155) — key interface
Standard ERC-1155: `balanceOf(address account, uint256 id) → uint256` (litres held of a
batch), `isApprovedForAll(address,address)`, `setApprovalForAll(address operator, bool)`,
events `TransferSingle(operator,from,to,id,value)`, `ApprovalForAll`.
Custom:
- `mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)` — mint (MINTER_ROLE gated). (Param names per the deployed source; `firstOwner` receives `liters` of `batchId`.)
- event `BatchMinted(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)`.
Roles (OpenZeppelin AccessControl): `MINTER_ROLE`, `DEFAULT_ADMIN_ROLE`.

### 3.2 TraceabilityBatchRelay — key interface
Moves an ERC-1155 batch through N+1 holders in ONE atomic tx (works around Besu QBFT
mempool ordering; each hop emits the canonical `TransferSingle`). **Each intermediate
holder must `setApprovalForAll(relay, true)` once** before they can be a hop (trusted-relay model).
- `executeChain(IERC1155 token, uint256 batchId, uint256 amount, address[] holders)` — uniform amount down a line; `holders[0]` is current owner, last is final custodian.
- `executeChainVariable(IERC1155 token, uint256 batchId, address[] holders, uint256[] amounts)` — per-leg amounts (`amounts.length == holders.length-1`).
- `executeHops(IERC1155 token, uint256 batchId, address[] froms, address[] tos, uint256[] amounts)` — arbitrary DAG (splits/merges), must be topologically ordered.
- event `ChainExecuted(IERC1155 indexed token, uint256 indexed batchId, address indexed initiator, uint16 hopCount, address firstHolder, address finalHolder)`.
- reverts: `EmptyChain()` (<2 holders / 0 hops), `LengthMismatch()`.

### 3.3 ContractRegistry — key interface (⚠ name = keccak256, version = uint64)
- `register(bytes32 name, uint64 version, address addr)` — first version auto-activates. **Selector sig: `register(bytes32,uint64,address)`.** Reverts `ZeroAddress()`, `AlreadyRegistered(name,version)`. REGISTRAR_ROLE.
- `getActive(bytes32 name) → address` · `setActiveVersion(bytes32 name, uint64 version)` · `deactivate(bytes32 name, uint64 version)` · `getEntry(bytes32 name, uint64 version) → Entry`.
- **`name` is `keccak256(utf8("ContractName"))`** (e.g. `cast keccak "IssuerRegistry"`) — NOT `format-bytes32-string`. That is how every on-chain entry and `getActive` lookup is keyed.
- `REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE")`.

### 3.4 PQAnchorRegistry — key interface
Hybrid ECDSA + ML-DSA-65 (NIST FIPS 204) anchoring; commits `keccak256(ML-DSA signature)`
on-chain, the signature blob lives off-chain (MinIO bucket `hara-pq-anchors`).
- `recordAnchor(bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain, bytes32 pqSignatureHash) → uint256 anchorId` — reverts `EmptyRange`, `MissingPQCommitment`.
- `confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)` · `rotatePQKey(bytes32 newKeyHash, string newAlgorithm)`.
- events `AnchorRecorded(...)`, `PQKeyRotated(...)`. Roles `ANCHOR_ROLE`, `KEY_ROTATOR_ROLE`.

---

## 4. Traceability REST API (`https://trace.ledger.haratrust.io`, HTTP Basic)

All amounts in **litres**. JSON responses, same-origin to the indexer.

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/batches?limit=50&offset=0` | `{ items: BatchSummary[] }` (ordered by `minted_at` desc) |
| GET | `/v1/batches/:batchId` | one `BatchSummary` (404 `{"error":"batch not found"}`) |
| GET | `/v1/batches/:batchId/hops` | `{ hops: Hop[] }` in custody order (block, then log index) |
| GET | `/v1/batches/:batchId/graph?aggregate=true` | `{ batch, nodes[], edges[], aggregated }` (Cytoscape/React-Flow ready) |
| GET | `/v1/holders/:address/batches` | `{ address, batches: string[] }` |
| GET | `/healthz` | `200` when the indexer is up |
| GET | `/metrics` | Prometheus exposition (`hara_indexer_*`) |

`?aggregate=true` on `/graph` collapses parallel A→B transfers into one weighted edge
(best for DAG view); omit it for one edge per transfer (linear traceability).

### Schemas
**BatchSummary:** `batch_id` (string, ERC-1155 token id), `initial_liters` (string),
`first_owner` (address, plantation/origin), `current_holder` (address), `hop_count` (string),
`rspo_hash` (bytes32 hex), `plantation_id` (bytes32 hex), `production_date`, `minted_at`,
`last_hop_at` (all ISO-8601 UTC).
**Hop:** `batch_id`, `liters` (string), `from_addr`, `to_addr`, `operator_addr` (the relay/operator),
`tx_hash`, `block_number` (string), `log_index` (number), `occurred_at` (ISO).
**Graph node:** `{ id (address), label, hopIndex, receivedLiters, sentLiters, currentLiters,
isFirstOwner, isCurrentHolder, isPassThrough }`. **Graph edge:** `{ id, source, target, label,
liters, txCount, firstAt, lastAt, sampleTxHash }`.

Addresses are returned checksummed (mixed-case); the holder lookup matches case-sensitively.

---

## 5. Explorer (Blockscout) API

`https://explorer.ledger.haratrust.io/api/v2/*` (no auth). Examples:
`/api/v2/stats`, `/api/v2/main-page/blocks`, `/api/v2/blocks`, `/api/v2/tokens/<addr>`,
`/api/v2/addresses/<addr>`, `/api/v2/transactions/<hash>`. Standard Blockscout v2 REST.

---

## 6. Common JSON-RPC recipes

- **Block height:** `eth_blockNumber` → `/read/`.
- **Holder balance for a batch:** `eth_call` `balanceOf(account,id)` (selector `0x00fdd58e`) on HaraPalmOil → `/read/`.
- **Custody hops directly from chain:** `eth_getLogs` for `address = HaraPalmOil`, decode `TransferSingle(operator,from,to,id,value)` (`id`=batchId, `value`=litres). NB: full-range `getLogs` exceeds the RPC range limit — chunk by block range.
- **Submit a tx:** build legacy `{type:"legacy", chainId:131216, nonce, to, data, value:0, gasPrice:0, gas}`, sign locally, POST `eth_sendRawTransaction` to `/write/`, then poll `eth_getTransactionReceipt` and check `status==0x1`.
- **Subscribe:** `wss://rpc.ledger.haratrust.io/ws` → `eth_subscribe newHeads` / logs.

---

## 7. Conventions an integrator must follow

1. Legacy txs, `gasPrice 0`, `chainId 131216` — always.
2. Pre-fund ≥1 wei before a wallet's first tx (zero-balance drop). On a fresh wallet you
   ask HARA ops to fund the address, or send 1 wei from a funded account.
3. Verify `receipt.status == 0x1`.
4. Compile contracts with `evm_version = "london"` (no PUSH0).
5. For chained/dependent transfers, use `TraceabilityBatchRelay` — do NOT pre-sign N
   dependent `safeTransferFrom` txs and flood the mempool (most revert; QBFT doesn't
   preserve mempool order).
6. Reads via `/read/` (cached); writes via `/write/`. For exact, never-stale reads
   (indexers) you can append `?bypass=1` semantics is handled server-side; otherwise the
   cache TTLs are short (1–3 s for dynamic methods).
7. JSON-RPC batching: up to 200 calls per POST on the public LB.
8. ContractRegistry `name` = `keccak256(utf8(name))`, `version` is `uint64`.

---

## 8. Branding

Product name: **Hara Registry** (chain often referred to as "the registry").
Companion products (separate): **hara-did** (`did:hara` identity), **hara-halal-passport**
(soulbound ERC-721 halal certificates), **hara-xchange** (market layer). Operations UI:
**Strata Console** (`console.platform.haratrust.io`). Brand assets in `doc/design/`.

Repo: https://github.com/imronzuhri-svg/hara-registry · Maintainer `@imronzuhri-svg` ·
Contact `ops@haratrust.io`.
