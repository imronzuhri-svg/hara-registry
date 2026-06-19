# Hara Registry — Technical Manual

**Version:** 2.0 · 2026-06-19
**Audience:** engineers, integration partners, and auditors building on, consuming, or reviewing Hara Registry.
**Status:** production-final. Verified against the live chain + repo (`doc/api/hara-registry-facts.md`, the Solidity sources in `contracts/src/`).

> **Canonical source of truth:** [`doc/api/hara-registry-facts.md`](../api/hara-registry-facts.md). Every value below agrees with that file; if the two ever disagree, the facts file wins.
> **Companion docs:** the integration manual [`doc/guides/hara-registry-integration-manual.md`](../guides/hara-registry-integration-manual.md) (local bring-up + connecting a product as a trust anchor), the deep internal reference [`doc/technical/TECHNICAL.md`](./TECHNICAL.md) (architecture, services, data model, operations), and the **Strata Console** (`console.platform.haratrust.io`) operations UI.

---

## Table of contents

1. [Overview & chain identity](#1-overview--chain-identity)
2. [Public endpoints](#2-public-endpoints)
3. [JSON-RPC API](#3-json-rpc-api)
4. [Smart contracts](#4-smart-contracts)
5. [Traceability REST API](#5-traceability-rest-api)
6. [Block explorer (Blockscout v2)](#6-block-explorer-blockscout-v2)
7. [Data model — the custody DAG](#7-data-model--the-custody-dag)
8. [Post-quantum anchoring](#8-post-quantum-anchoring)
9. [Security model](#9-security-model)
10. [Conventions & gotchas](#10-conventions--gotchas)
11. [Quickstart recipes & reference card](#11-quickstart-recipes--reference-card)

---

## 1. Overview & chain identity

Hara Registry (formerly *HaraLedger* / *hara-ledger*) is a permissioned **Hyperledger Besu (QBFT)** blockchain for **palm-oil supply-chain traceability** with **post-quantum (PQ) audit anchoring**. It records the full chain of custody of palm-oil batches as on-chain ERC-1155 events and exposes them through a JSON-RPC node interface, a REST traceability API, a Blockscout explorer, and a visual custody-DAG viewer. Around the chain sit the services that make it usable: an indexer + trace API, an RPC cache, a block explorer, observability, and the Strata operations console.

### 1.1 Chain identity — the INVARIANTS (never change)

| Property | Value |
|---|---|
| **Chain ID** | **131216** |
| **Consensus** | QBFT (Hyperledger Besu), 4 validators, tolerates 1 fault (quorum 3/4) |
| **Block time** | ~2 seconds, **instant finality** (no probabilistic confirmation) |
| **Gas price** | **0** (`zeroBaseFee` genesis) — free chain |
| **Tx type** | **legacy (type 0)** only, `gasPrice: 0`. EIP-1559 type-2 txs are **NOT** accepted |
| **EVM target** | **London**. Shanghai `PUSH0` is **NOT** supported — compile with `evm_version = "london"` |
| **Native token** | HARA (used only for gas accounting; gas is free) |
| **Client** | Besu 26.4.0 (Bonsai storage) |
| **RPC namespaces** | `eth, net, web3, qbft, txpool, debug, trace` (`admin` is disabled) |
| **Max JSON-RPC batch** | 200 (public LB); Besu nodes accept up to 4096 |
| **Rate limit** | HAProxy ~5,000 requests / 10 s per source IP; 32k concurrent connections |

### 1.2 The three rules that bite every integrator

1. **Legacy txs, `gasPrice 0`, `chainId 131216`. Always.** EIP-1559 fields (`maxFeePerGas`, `maxPriorityFeePerGas`) are rejected.
2. **Pre-fund ≥ 1 wei native HARA to any wallet before its first tx.** Besu silently skips zero-balance senders *even at gasPrice 0* — the tx sits unmined and your tool hangs.
3. **Verify `receipt.status == 0x1`.** A mined tx can still have reverted (`0x0`).

---

## 2. Public endpoints

| URL | What | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC **reads** (via rpc-cache + load balancer) | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC **writes** (`eth_sendRawTransaction`) | none |
| `https://rpc.ledger.haratrust.io/ws` | JSON-RPC WebSocket (subscriptions) | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout explorer (+ `/api/v2/*`) | none |
| `https://trace.ledger.haratrust.io/` | Traceability REST API (`/v1/*`) + custody-DAG viewer | **HTTP Basic** |

All endpoints are HTTPS (Let's Encrypt, terminated at the Caddy edge).

> **Routing & trailing-slash rules — read carefully:**
> - **The trailing slash matters** on `/read/` and `/write/`. `…/read` (no slash) returns `404 Route not found`.
> - **Reads → `/read/`** (cached; short TTLs, 1–3 s for dynamic methods).
> - **Writes → `/write/`** (`eth_sendRawTransaction`). Sending a write to `/read/` may succeed but bypasses write-affinity and can race nonces — always use `/write/`.
> - WebSocket subscriptions and live reads use the load balancer directly via `/ws`.

WG-mesh internal equivalents (for services *on the WireGuard mesh* only — not for external use):
RPC `http://10.43.0.21:8545/rpc/{read,write}`, WS `ws://10.43.0.21:8546/rpc/read`.

---

## 3. JSON-RPC API

Standard Ethereum JSON-RPC over HTTPS POST. Enabled namespaces: **`eth, net, web3, qbft, txpool, debug, trace`** (`admin` disabled).

**Conventions**
- All transactions are **legacy type** with `gasPrice: 0` and `chainId: 131216`.
- Reads → `/read/` (cached); writes (`eth_sendRawTransaction`) → `/write/`.
- Max JSON-RPC batch size: 200 calls per POST on the public LB.
- `eth_getLogs` has a server-side block-range limit — a full-range query exceeds it. **Chunk by block range.**

### 3.1 Current block height (`eth_blockNumber`)

```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x2f06f"}
```

### 3.2 Read contract state (`eth_call`) — `balanceOf`

`balanceOf(address account, uint256 id)` (selector `0x00fdd58e`) on HaraPalmOil returns the **litres** an address holds of a given batch. Encode `account` (32-byte left-padded) then `id` (32-byte):

```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","method":"eth_call","id":1,
  "params":[{"to":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
             "data":"0x00fdd58e
                     000000000000000000000000BFC3d8457A14B4eDf861B24544Bea243114FA3B5
                     000000000000000000000000000000000000000000000000000001becb1f2add"},
            "latest"]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x00000000000000000000000000000000000000000000000000000000000003e8"}
```
(`0x3e8` = 1000 litres). Whitespace shown for readability only — send the `data` field as one unbroken hex string.

### 3.3 Custody hops directly from chain (`eth_getLogs`)

Every custody hop is an ERC-1155 `TransferSingle(operator, from, to, id, value)` log on HaraPalmOil (`id` = batchId, `value` = litres). The event signature topic is
`keccak256("TransferSingle(address,address,address,uint256,uint256)")` =
`0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62`.

```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","method":"eth_getLogs","id":1,
  "params":[{"address":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
             "topics":["0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"],
             "fromBlock":"0x33A6A","toBlock":"0x33A6B"}]}'
```

For each log: `topics[1]` = operator, `topics[2]` = from, `topics[3]` = to; `data` = `id` (litres batch) ‖ `value` (litres). **Caveat:** a full-range `getLogs` exceeds the RPC range limit — iterate in block-range chunks (e.g. 2,000 blocks at a time). For convenience, prefer the [Traceability REST API](#5-traceability-rest-api), which has already indexed these.

### 3.4 Submit a transaction (`eth_sendRawTransaction`)

1. Build a **legacy** tx: `{ type:"legacy", chainId:131216, nonce, to, data, value:0, gasPrice:0, gas }`.
2. Sign locally (the chain has no unlocked accounts), then POST the raw tx to **`/write/`**:

```bash
curl -s -X POST https://rpc.ledger.haratrust.io/write/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","id":1,"params":["0x<signed-raw-tx>"]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x544096810acf16485fe0213131762a4f007e3ec4e1cbef3590e373d71aed3f74"}
```

3. Poll `eth_getTransactionReceipt` and **check `status`**:

```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","id":1,
       "params":["0x544096810acf16485fe0213131762a4f007e3ec4e1cbef3590e373d71aed3f74"]}'
```
A `status` of `0x1` means success; **`0x0` means the call reverted even though it was mined.** Always check this.

### 3.5 Subscribe (WebSocket)

```bash
wscat -c wss://rpc.ledger.haratrust.io/ws
> {"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}
> {"jsonrpc":"2.0","id":2,"method":"eth_subscribe","params":["logs",{"address":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"}]}
```

---

## 4. Smart contracts

Deployed on chain **131216**. Full ABIs live in the repo at `contracts/out/<Name>.sol/<Name>.json` (`.abi`); Solidity sources at `contracts/src/<Name>.sol`. Discover any contract's active address at runtime via `ContractRegistry` rather than hardcoding.

| Contract | Address | Standard / role |
|---|---|---|
| **HaraPalmOil** | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | ERC-1155; 1 token = 1 **litre**; each `TransferSingle` = a custody hop |
| **TraceabilityBatchRelay** | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | executes N custody hops atomically in one tx |
| **PQAnchorRegistry** | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | post-quantum (ML-DSA-65) audit anchors |
| **ContractRegistry** | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | name → address registry for platform contracts |
| **GovernanceContract** | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | role-gated N-of-M governance |
| **AnchorRegistry** (legacy) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | legacy ECDSA-only anchoring (compat) |

All contracts use OpenZeppelin v5 `AccessControl`. Common role admin: `hasRole(bytes32,address)`, `grantRole`, `revokeRole`, `DEFAULT_ADMIN_ROLE`.

---

### 4.1 HaraPalmOil — ERC-1155 batch token

**Address:** `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`
**Purpose:** an ERC-1155 where each **token ID is a distinct production batch** and **token amount = litres** in that batch. Per-batch RSPO/plantation metadata is stored on-chain so every `TransferSingle` can be audited against the certified batch identity. Designed for RSPO Segregated / Identity-Preserved supply chains.

**Standard ERC-1155 interface**

| Function | Notes |
|---|---|
| `balanceOf(address account, uint256 id) → uint256` | litres held of a batch (selector `0x00fdd58e`) |
| `balanceOfBatch(address[] accounts, uint256[] ids) → uint256[]` | batched read |
| `isApprovedForAll(address account, address operator) → bool` | approval check |
| `setApprovalForAll(address operator, bool approved)` | **required before a holder can be a relay hop** (see §4.2) |
| `safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)` | one custody hop |
| `supportsInterface(bytes4) → bool` | ERC-1155 id `0xd9b67a26`; AccessControl |

**Custom functions**

| Function | Role | Notes |
|---|---|---|
| `mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)` | `MINTER_ROLE` | creates a batch; `firstOwner` receives the full volume. Reverts `BatchAlreadyExists(batchId)` if the id was already minted. |
| `updateRspoCertificate(uint256 batchId, bytes32 newHash)` | `CERTIFIER_ROLE` | re-audit produced a new VC. Reverts `UnknownBatch(batchId)`. |
| `batchMeta(uint256) → (bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate, uint64 mintedAt, address mintedBy)` | view | per-batch certified metadata. `totalSupply(id)` is the authoritative volume. |

**Events**

| Event | Fields |
|---|---|
| `BatchMinted` | `uint256 indexed batchId, address indexed firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate` |
| `BatchMetadataUpdated` | `uint256 indexed batchId, bytes32 newRspoCertificateHash` |
| `TransferSingle` | `address operator, address from, address to, uint256 id, uint256 value` — the canonical custody-of-record hop |
| `ApprovalForAll` | `address account, address operator, bool approved` |

**Roles:** `MINTER_ROLE = keccak256("MINTER_ROLE")`, `CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE")`, `DEFAULT_ADMIN_ROLE`. The constructor grants all three to `admin`.
**Reverts:** `BatchAlreadyExists(uint256)`, `UnknownBatch(uint256)`, plus OZ AccessControl/ERC-1155 (e.g. insufficient balance, missing approval) reverts.

---

### 4.2 TraceabilityBatchRelay — atomic multi-hop custody

**Address:** `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`
**Purpose:** moves an ERC-1155 batch through N custody hops in **one atomic transaction**, each hop emitting the canonical `TransferSingle` from the token contract.

**Why it exists (mempool-ordering rationale).** Besu QBFT's block builder does **not** preserve strict mempool insertion order across blocks. Pre-signing N dependent `safeTransferFrom` txs and flooding the mempool results in most of them reverting (verified). Forcing each hop to wait for its receipt is correct but slow (~4 s/hop on a 2 s-block chain). The relay does all N hops in **one tx, in one block** — execution within a single tx is deterministic (~50 ms for 100 hops vs ~7 minutes sequential). **Anyone writing chained/dependent transfer flows MUST use this relay.**

**Trust model (`setApprovalForAll`).** Each intermediate holder must call `HaraPalmOil.setApprovalForAll(relay, true)` **once** before they can be a custody hop. After that, the relay can move tokens *from* that holder. This is a **trusted-relay** model — appropriate for permissioned consortia where the relay's caller is an accredited body (RSPO auditor, BPJPH-licensed traceability operator). A trustless EIP-712 signed-permit variant is on the roadmap, not deployed.

**Methods**

| Function | Use |
|---|---|
| `executeChain(IERC1155 token, uint256 batchId, uint256 amount, address[] holders)` | uniform `amount` down a line. `holders[0]` is the current owner, last element is the final custodian. Most palm-oil flows (full volume moves at each hop). |
| `executeChainVariable(IERC1155 token, uint256 batchId, address[] holders, uint256[] amounts)` | per-leg amounts (each custodian takes a cut). Requires `amounts.length == holders.length - 1`. |
| `executeHops(IERC1155 token, uint256 batchId, address[] froms, address[] tos, uint256[] amounts)` | arbitrary DAG — splits/merges (refinery/blending). Hops **must be topologically ordered**: every intermediate node must have received enough volume before its outgoing hops. Requires `tos.length == froms.length == amounts.length`. |

**Mass balance** is enforced automatically by ERC-1155 balance semantics: any node that hasn't received enough volume causes the whole tx to revert.

**Event:** `ChainExecuted(IERC1155 indexed token, uint256 indexed batchId, address indexed initiator, uint16 hopCount, address firstHolder, address finalHolder)` — a single path-summary event for fast off-chain indexing, in addition to one `TransferSingle` per hop.
**Reverts:** `EmptyChain()` (< 2 holders, or 0 hops for `executeHops`), `LengthMismatch()`.

---

### 4.3 ContractRegistry — name → address discovery

**Address:** `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
**Purpose:** canonical registry mapping `bytes32 name → (uint64 version → address)` with a single active version per name, so services and clients discover the current address without hardcoding. Old versions remain queryable for historical reads and audit.

> **⚠ Two encoding gotchas:**
> - **`name` is `keccak256(utf8("ContractName"))`** — e.g. `cast keccak "IssuerRegistry"`. **NOT** `cast format-bytes32-string`. Every on-chain entry and `getActive` lookup is keyed this way.
> - **`version` is `uint64`** (not uint16). The exact selector signature is **`register(bytes32,uint64,address)`**.

**Functions**

| Function | Role | Notes |
|---|---|---|
| `register(bytes32 name, uint64 version, address addr)` | `REGISTRAR_ROLE` | adds a version; the **first** registration for a name auto-activates. Reverts `ZeroAddress()`, `AlreadyRegistered(name, version)`. |
| `getActive(bytes32 name) → address` | view | current active address for a name |
| `setActiveVersion(bytes32 name, uint64 version)` | `REGISTRAR_ROLE` | switch active pointer. Reverts `NotRegistered(name, version)`. |
| `deactivate(bytes32 name, uint64 version)` | `REGISTRAR_ROLE` | mark a version inactive (active pointer unchanged). Reverts `NotRegistered`. |
| `getEntry(bytes32 name, uint64 version) → Entry{addr, version, registeredAt, active}` | view | full entry |
| `activeVersion(bytes32 name) → uint64` | view | currently active version number |

**Events:** `ContractRegistered(name, version, addr)`, `ActiveVersionChanged(name, version, addr)`, `ContractDeactivated(name, version)`.
**Roles:** `REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE")`, `DEFAULT_ADMIN_ROLE`.
**Reverts:** `ZeroAddress()`, `AlreadyRegistered(bytes32, uint64)`, `NotRegistered(bytes32, uint64)`.

---

### 4.4 PQAnchorRegistry — post-quantum audit anchors

**Address:** `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`
**Purpose:** records Merkle roots of on-chain event ranges **plus** a parallel post-quantum signature commitment. Hybrid ECDSA + **ML-DSA-65 (Dilithium 3, NIST FIPS 204)**: commits `keccak256(ML-DSA signature)` on-chain; the ~3 KB signature blob lives off-chain in MinIO bucket `hara-pq-anchors`. See §8 for the full model.

**Functions**

| Function | Role | Notes |
|---|---|---|
| `recordAnchor(bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain, bytes32 pqSignatureHash) → uint256 anchorId` | `ANCHOR_ROLE` | records an anchor; tags it with the current `pqKeyHash`. Reverts `EmptyRange()` (`blockTo < blockFrom`) and `MissingPQCommitment()` (`pqSignatureHash == 0`). |
| `confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)` | `ANCHOR_ROLE` | fills in the external-chain (IOTA/Ethereum L1) tx hash once mined. Reverts `AnchorNotFound(anchorId)`. |
| `rotatePQKey(bytes32 newKeyHash, string newAlgorithm)` | `KEY_ROTATOR_ROLE` | rotate the PQ signing key. Existing anchors keep their original frozen `pqKeyHash`. |
| `anchors(uint256) → Anchor` | view | full anchor struct (see §8) |
| `currentPQKeyHash() → bytes32`, `currentPQAlgorithm() → string`, `anchorCount() → uint256` | view | |

**Events:** `AnchorRecorded(anchorId, merkleRoot, sha3Root, blockFrom, blockTo, eventCount, pqSignatureHash, pqKeyHash, anchorChain)`, `ExternalAnchorConfirmed(anchorId, anchorChain, anchorTxHash)`, `PQKeyRotated(oldKeyHash, newKeyHash, newAlgorithm)`.
**Roles:** `ANCHOR_ROLE = keccak256("ANCHOR_ROLE")`, `KEY_ROTATOR_ROLE = keccak256("KEY_ROTATOR_ROLE")`, `DEFAULT_ADMIN_ROLE`. Constructor: `(address admin, bytes32 initialPQKeyHash, string initialAlgorithm)`.
**Reverts:** `EmptyRange()`, `AnchorNotFound(uint256)`, `MissingPQCommitment()`.

---

### 4.5 AnchorRegistry (legacy) — classical ECDSA anchoring

**Address:** `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`
**Purpose:** classical-only audit anchors (kept for backward compatibility). Records Merkle roots of event ranges with optional external-chain confirmation; lets any third party verify a Hara Registry event independently against an externally-anchored root. Use **PQAnchorRegistry** for new anchors.

**Functions**

| Function | Role | Notes |
|---|---|---|
| `recordAnchor(bytes32 merkleRoot, uint64 blockFrom, uint64 blockTo, uint64 eventCount, bytes32 anchorChain) → uint256 anchorId` | `ANCHOR_ROLE` | reverts `EmptyRange()` |
| `confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash)` | `ANCHOR_ROLE` | reverts `AnchorNotFound(anchorId)` |
| `anchors(uint256) → Anchor`, `anchorCount() → uint256` | view | |

**Events:** `AnchorRecorded(anchorId, merkleRoot, blockFrom, blockTo, eventCount, anchorChain)`, `ExternalAnchorConfirmed(anchorId, anchorChain, anchorTxHash)`.
**Roles:** `ANCHOR_ROLE`, `DEFAULT_ADMIN_ROLE`. **Reverts:** `EmptyRange()`, `AnchorNotFound(uint256)`.

---

### 4.6 GovernanceContract — N-of-M governance

**Address:** `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`
**Purpose:** permissioned, multisig-friendly governance. Any `GOVERNANCE_ROLE` holder can propose; an M-of-N approval threshold marks a proposal Approved; then any governor executes it (`target.call{value}(callData)`). Covers validator add/remove coordination, contract-upgrade approvals, emergency-pause flags read by downstream contracts, and admin role transfers. Proposal lifecycle: `propose() → approve()×threshold → execute()`.

**Functions**

| Function | Role | Notes |
|---|---|---|
| `propose(address target, bytes callData, uint256 value, string description) → uint256 id` | `GOVERNANCE_ROLE` | proposer auto-approves |
| `approve(uint256 id)` | `GOVERNANCE_ROLE` | reaching `approvalThreshold` sets state Approved. Reverts `AlreadyApproved()`, `WrongState(state)`. |
| `execute(uint256 id)` | `GOVERNANCE_ROLE` | runs the call. Reverts `WrongState(state)`, `ExecutionFailed(returnData)`. |
| `cancel(uint256 id)` | `GOVERNANCE_ROLE` | cancel Pending/Approved. Reverts `WrongState(state)`. |
| `setEmergencyPause(bool paused)` | `DEFAULT_ADMIN_ROLE` | toggle `emergencyPaused` flag |
| `setApprovalThreshold(uint32 newThreshold)` | `DEFAULT_ADMIN_ROLE` | reverts `InvalidThreshold()` |
| `proposals(uint256)`, `approvals(uint256, address)`, `approvalThreshold()`, `emergencyPaused()` | view | |

**Events:** `ProposalCreated`, `ProposalApproved`, `ProposalExecuted`, `ProposalCancelled`, `EmergencyPauseChanged`, `ApprovalThresholdChanged`.
**Roles:** `GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE")`, `DEFAULT_ADMIN_ROLE`. Constructor: `(address[] initialGovernors, uint32 initialThreshold)`.
**Reverts:** `AlreadyApproved()`, `NotApproved()`, `WrongState(ProposalState)`, `ExecutionFailed(bytes)`, `InvalidThreshold()`.

---

## 5. Traceability REST API

Base URL **`https://trace.ledger.haratrust.io`** (HTTP Basic auth — request credentials from operations). Same-origin to the indexer; JSON responses. **All amounts are in litres.**

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/batches?limit=50&offset=0` | `{ items: BatchSummary[] }`, ordered by `minted_at` desc |
| GET | `/v1/batches/:batchId` | one `BatchSummary` (404 `{"error":"batch not found"}`) |
| GET | `/v1/batches/:batchId/hops` | `{ hops: Hop[] }` in custody order (block, then log index) |
| GET | `/v1/batches/:batchId/graph?aggregate=true` | `{ batch, nodes[], edges[], aggregated }` (Cytoscape / React-Flow ready) |
| GET | `/v1/holders/:address/batches` | `{ address, batches: string[] }` |
| GET | `/healthz` | `200` when the indexer is up |
| GET | `/metrics` | Prometheus exposition (`hara_indexer_*`) |

`?aggregate=true` on `/graph` collapses parallel A→B transfers into **one weighted edge** (best for DAG view). Omit it for **one edge per transfer** (linear traceability).
Addresses are returned **checksummed (mixed-case)**; the holder lookup matches **case-sensitively** — pass the checksummed form.

### 5.1 Example — list batches

```bash
curl -s -u "$U:$P" "https://trace.ledger.haratrust.io/v1/batches?limit=1"
```
```json
{
  "items": [
    {
      "batch_id": "1780285655133",
      "initial_liters": "1000",
      "first_owner": "0x1481A1c803d433277fA82F1E607144f79B76FB55",
      "current_holder": "0xBFC3d8457A14B4eDf861B24544Bea243114FA3B5",
      "hop_count": "499",
      "rspo_hash": "0x529a8675a81c19da17862d50609904e7662b1691bb542acc81ccc485a466c93d",
      "plantation_id": "0xc4ba158eb699c0e473cd2aec33c61161af992b774e34513a48e635bb0bd479bd",
      "production_date": "2026-06-01T03:49:04.000Z",
      "minted_at": "2026-06-01T03:49:07.000Z",
      "last_hop_at": "2026-06-01T03:49:07.000Z"
    }
  ]
}
```

### 5.2 Example — full custody chain

`GET /v1/batches/1780285655133/hops`:
```json
{
  "hops": [
    {
      "batch_id": "1780285655133",
      "liters": "1000",
      "from_addr": "0x1481A1c803d433277fA82F1E607144f79B76FB55",
      "to_addr": "0x2Efd1Ca38d6CD228155216c6c0D1a2196A28Fd6B",
      "operator_addr": "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
      "tx_hash": "0x544096810acf16485fe0213131762a4f007e3ec4e1cbef3590e373d71aed3f74",
      "block_number": "211690",
      "log_index": 2,
      "occurred_at": "2026-06-01T03:49:07.000Z"
    }
  ]
}
```
`operator_addr` is the relay/operator that executed the transfer (here the TraceabilityBatchRelay).

### 5.3 Example — custody graph

`GET /v1/batches/:batchId/graph?aggregate=true` returns `{ batch, nodes[], edges[], aggregated }`:
```json
{
  "batch": { "batch_id": "1780285655133", "...": "(summary as in 5.1)" },
  "nodes": [
    {
      "id": "0x1481A1c803d433277fA82F1E607144f79B76FB55",
      "label": "0x1481…FB55",
      "hopIndex": 0,
      "receivedLiters": 0, "sentLiters": 1000, "currentLiters": -1000,
      "isFirstOwner": true, "isCurrentHolder": false, "isPassThrough": false
    }
  ],
  "edges": [
    {
      "id": "agg-0",
      "source": "0x1481A1c803d433277fA82F1E607144f79B76FB55",
      "target": "0x2Efd1Ca38d6CD228155216c6c0D1a2196A28Fd6B",
      "label": "1000 L", "liters": 1000, "txCount": 1,
      "firstAt": "2026-06-01T03:49:07.000Z", "lastAt": "2026-06-01T03:49:07.000Z",
      "sampleTxHash": "0x544096810acf16485fe0213131762a4f007e3ec4e1cbef3590e373d71aed3f74"
    }
  ],
  "aggregated": true
}
```

### 5.4 Schema & field reference

**BatchSummary**

| Field | Type | Meaning |
|---|---|---|
| `batch_id` | string | ERC-1155 token id of the batch |
| `initial_liters` | string | volume minted at origin |
| `first_owner` | address | wallet that received the minted volume (plantation / origin) |
| `current_holder` | address | latest holder |
| `hop_count` | string | number of custody transfers |
| `rspo_hash` | bytes32 hex | RSPO certificate hash |
| `plantation_id` | bytes32 hex | source plantation identifier hash |
| `production_date`, `minted_at`, `last_hop_at` | ISO-8601 UTC | timestamps |

**Hop:** `batch_id`, `liters` (string), `from_addr`, `to_addr`, `operator_addr` (relay/operator), `tx_hash`, `block_number` (string), `log_index` (number), `occurred_at` (ISO).

**Graph node:** `{ id (address), label, hopIndex, receivedLiters, sentLiters, currentLiters, isFirstOwner, isCurrentHolder, isPassThrough }`. Flags: `isFirstOwner` = plantation/origin; `isCurrentHolder` = terminal holder with positive balance; `isPassThrough` = everything received was forwarded on.

**Graph edge:** `{ id, source, target, label, liters, txCount, firstAt, lastAt, sampleTxHash }`.

---

## 6. Block explorer (Blockscout v2)

`https://explorer.ledger.haratrust.io/` — standard Blockscout, no auth. Browse blocks, transactions, addresses, and the HaraPalmOil token. Programmatic access via the Blockscout v2 REST API under `/api/v2/*`:

| Endpoint | Returns |
|---|---|
| `/api/v2/stats` | chain stats |
| `/api/v2/main-page/blocks` | recent blocks (main page) |
| `/api/v2/blocks` | block list |
| `/api/v2/tokens/<addr>` | token info (e.g. HaraPalmOil) |
| `/api/v2/addresses/<addr>` | address overview |
| `/api/v2/transactions/<hash>` | transaction detail |

```bash
curl -s https://explorer.ledger.haratrust.io/api/v2/tokens/0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
```

---

## 7. Data model — the custody DAG

### 7.1 On-chain events that form the DAG

The chain of custody is reconstructed entirely from on-chain events on **HaraPalmOil**:

| Event | Role in the DAG |
|---|---|
| `BatchMinted(batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate)` | the **root** node — origin (plantation), initial volume, and certified identity |
| `TransferSingle(operator, from, to, id, value)` | one **edge** — `from → to`, carrying `value` litres of batch `id`; `operator` is the relay/operator |
| `ChainExecuted(...)` (from the relay) | a path-summary marker for fast indexing — not required to reconstruct custody |

The indexer follows `newHeads`, decodes these logs against the watched-contract ABIs, and projects them into `BatchSummary` / `Hop` / graph structures exposed by the REST API. Reads can be done directly from chain via `eth_getLogs` (chunked) or — preferably — through the indexed REST API.

### 7.2 One token = one litre, and mass balance

Token **amount = litres**: minting `liters` of a batch creates exactly that many ERC-1155 units of token id `batchId`; `totalSupply(batchId)` is the authoritative volume. Because custody hops are real `safeTransferFrom` calls, **mass balance is enforced by ERC-1155 itself** — you cannot transfer more litres than you hold, and the sum of balances across all holders of a batch always equals the minted volume (no burn path in normal operation). For DAG flows (splits, merges, blending) via `executeHops`, any node that hasn't received enough volume before its outgoing hop reverts the entire transaction, so the recorded graph is always mass-consistent.

The graph node fields make this explicit per holder: `receivedLiters`, `sentLiters`, and `currentLiters = received − sent` (the running balance).

---

## 8. Post-quantum anchoring

### 8.1 Threat model

EVM consensus signatures (SECP256K1/ECDSA) are vulnerable to Shor's algorithm. An attacker who later acquires a cryptographically-relevant quantum computer (CRQC, ~2030–2040 est.) could forge historical anchor signatures and **retroactively fabricate chain history** — the classic "harvest-now, decrypt-later" risk for long-lived audit records.

### 8.2 The hybrid model (ECDSA + ML-DSA-65)

At anchor time, the anchor worker signs the Merkle root of an event range with **both**:

- the standard **ECDSA** path (cheap, current Ethereum tooling), and
- a post-quantum scheme, **ML-DSA-65 (Dilithium 3, NIST FIPS 204)**.

**On-chain commit vs off-chain blob.** ML-DSA signatures are ~3 KB and verifying one in Solidity is gas-prohibitive today (~5 M gas). So the registry **commits `keccak256(ML-DSA signature)` on-chain** (PQAnchorRegistry, ~30 k gas) and stores the actual signature **off-chain** in MinIO bucket `hara-pq-anchors` (object key `ml-dsa-65/<hex>.sig`). The on-chain `Anchor` struct carries, per range:

| Field | Meaning |
|---|---|
| `merkleRoot` | Keccak256 root of the event range |
| `sha3Root` | SHA3-256 of the same data (hash-agility belt-and-suspenders) |
| `blockFrom`, `blockTo`, `eventCount` | the covered range |
| `timestamp` | anchor time |
| `anchorChain`, `anchorTxHash` | external-chain pointer (IOTA / Ethereum L1), filled by `confirmExternalAnchor` |
| `pqSignatureHash` | `keccak256(ML-DSA signature bytes)` — the PQ commitment |
| `pqKeyHash` | the PQ public-key hash **frozen at signing time** (not the current one) |

`recordAnchor` rejects an empty PQ commitment (`MissingPQCommitment`), so every anchor in this contract is PQ-protected. The PQ public-key bytes live off-chain (CAS/MinIO) at `pqKeyHash`. Keys can be rotated (`rotatePQKey`); old anchors keep their original `pqKeyHash`, so auditors always fetch the matching key.

### 8.3 Audit-time verification flow

**Today:**
1. Read the on-chain `Anchor` for the range; note `pqSignatureHash` and `pqKeyHash`.
2. Fetch the signature blob from MinIO (`hara-pq-anchors`) and verify `keccak256(blob)` matches the on-chain `pqSignatureHash`.
3. Fetch the PQ public key for `pqKeyHash` and **verify the ML-DSA-65 signature over the Merkle root**.
4. Independently recompute Merkle inclusion of any event against `merkleRoot`, and optionally cross-check the same root on the external chain at `anchorTxHash`. No HARA-operated service needs to be trusted.

**Post-2030 (after a CRQC exists):** classical ECDSA forgery becomes possible, so the **ML-DSA-65 signature is the authoritative proof** (lattice-based, CRQC-safe). The migration path is to add an on-chain `verifyPQ()` once EVMs gain ML-DSA precompiles (~2027–2029).

---

## 9. Security model

| Layer | Control |
|---|---|
| **TLS at the edge** | Caddy on the edge host terminates public TLS (auto-renewed Let's Encrypt). Upstream traffic runs plaintext over the **WireGuard mesh** — no per-service TLS. |
| **Permissioned access** | Public reads (RPC `/read/`, explorer) need no auth. The traceability API is **HTTP Basic**-gated. All state-changing contract calls are role-gated (see per-contract roles in §4). |
| **Key custody** | Validator, signer, and anchor-worker keys live in **HashiCorp Vault** (Raft), fetched via per-role AppRole at startup — never on disk. No Vault root token is distributed to any production host; Vault is never publicly exposed (operator access via SSH tunnel). |
| **Receipt verification** | A mined tx can still revert — clients **must** check `receipt.status == 0x1`. |
| **Rate limits** | HAProxy enforces ~5,000 requests / 10 s per source IP and 32k concurrent connections at the load balancer. |
| **Post-quantum** | Hybrid ECDSA + ML-DSA-65 anchoring (§8) protects historical audit records against future quantum forgery. |
| **Supply-chain / CI** | Slither on every `contracts/**` push (fails CI on high/critical), Gitleaks secret scanning, CodeQL (where GHAS available). |

---

## 10. Conventions & gotchas

Follow these or things break in subtle ways:

1. **Legacy txs, `gasPrice 0`, `chainId 131216` — always.** EIP-1559 type-2 fields are rejected.
2. **Pre-fund ≥ 1 wei native HARA before a wallet's first tx.** Besu silently drops zero-balance senders even at gasPrice 0 — your tool hangs on an unmined tx. Fund the address via HARA ops or send 1 wei from a funded account.
3. **Verify `receipt.status == 0x1`.** `0x0` = reverted-but-mined.
4. **Compile contracts with `evm_version = "london"`.** Shanghai `PUSH0` breaks Besu deploys.
5. **For chained/dependent transfers, use `TraceabilityBatchRelay`.** Do **not** pre-sign N dependent `safeTransferFrom` txs and flood the mempool — most revert; QBFT does not preserve mempool order. Intermediate holders must `setApprovalForAll(relay, true)` once.
6. **Reads → `/read/` (cached); writes → `/write/`.** Cache TTLs are short (1–3 s for dynamic methods); for never-stale indexer reads, server-side bypass semantics apply.
7. **The trailing slash on `/read/` and `/write/` is required** — `…/read` returns `404`.
8. **`eth_getLogs` has a block-range limit** — chunk full-history queries; or use the indexed REST API.
9. **JSON-RPC batching: up to 200 calls per POST** on the public LB.
10. **ContractRegistry: `name = keccak256(utf8(name))`, `version` is `uint64`, selector `register(bytes32,uint64,address)`.** Never `format-bytes32-string`.
11. **Addresses from the trace API are checksummed; holder lookups are case-sensitive** — pass the checksummed form.

---

## 11. Quickstart recipes & reference card

### 11.1 Trace one batch end-to-end (REST)

```bash
BASE=https://trace.ledger.haratrust.io
curl -s -u "$U:$P" "$BASE/v1/batches?limit=1"                        # find a batch id
curl -s -u "$U:$P" "$BASE/v1/batches/<id>"                           # summary
curl -s -u "$U:$P" "$BASE/v1/batches/<id>/hops"                      # full custody chain
curl -s -u "$U:$P" "$BASE/v1/batches/<id>/graph?aggregate=true"      # graph for visualisation
```

### 11.2 Verify a holder's balance for a batch (no auth, direct from chain)

`eth_call` `balanceOf(holder, batchId)` (selector `0x00fdd58e`) on HaraPalmOil via `/read/` — see §3.2.

### 11.3 Submit a write

Build legacy tx → sign locally → POST `eth_sendRawTransaction` to `/write/` → poll `eth_getTransactionReceipt` and check `status == 0x1` — see §3.4.

### 11.4 Watch new blocks

```bash
wscat -c wss://rpc.ledger.haratrust.io/ws    # then eth_subscribe newHeads
```

### 11.5 Reference card

```
Repo:               https://github.com/imronzuhri-svg/hara-registry
Chain ID:           131216
Consensus:          QBFT (Besu 26.4.0, Bonsai), 4 validators, quorum 3/4
Block time:         ~2 s, instant finality
Native token:       HARA (gas price 0)
Tx type:            legacy (type 0) only, gasPrice 0
EVM version:        london (no PUSH0)
Solidity:           ^0.8.26, OpenZeppelin v5
RPC namespaces:     eth, net, web3, qbft, txpool, debug, trace (admin off)
Max JSON-RPC batch: 200 (LB)
Rate limit:         ~5,000 req / 10 s per IP; 32k concurrent

RPC read:           https://rpc.ledger.haratrust.io/read/   (trailing slash!)
RPC write:          https://rpc.ledger.haratrust.io/write/  (trailing slash!)
WebSocket:          wss://rpc.ledger.haratrust.io/ws
Explorer:           https://explorer.ledger.haratrust.io/  (+ /api/v2/*)
Trace API:          https://trace.ledger.haratrust.io/v1/* (HTTP Basic)

Contracts (chain 131216):
  HaraPalmOil              0xa513E6E4b8f2a923D98304ec87F64353C4D5C853  (ERC-1155, 1 token = 1 L)
  TraceabilityBatchRelay   0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
  PQAnchorRegistry         0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
  ContractRegistry         0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
  GovernanceContract       0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
  AnchorRegistry (legacy)  0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0

Three rules: legacy/gasPrice0/chainId131216 · prefund 1 wei · check receipt.status==0x1

Maintainer:         @imronzuhri-svg   ·   Contact: ops@haratrust.io
```

### 11.6 Where to go next

- **Bring up locally + connect a product:** [`doc/guides/hara-registry-integration-manual.md`](../guides/hara-registry-integration-manual.md).
- **Architecture, services, data model, operations, CI/CD:** [`doc/technical/TECHNICAL.md`](./TECHNICAL.md).
- **Canonical facts (single source of truth):** [`doc/api/hara-registry-facts.md`](../api/hara-registry-facts.md).
- **Operations UI:** Strata Console, `console.platform.haratrust.io`.
- **Full ABIs:** `contracts/out/<Name>.sol/<Name>.json`. **Sources:** `contracts/src/<Name>.sol`.

*Companion products (separate repos): hara-did (`did:hara` identity), hara-halal-passport (soulbound ERC-721 halal certificates), hara-xchange (market layer). For credentials, ABIs, or integration support, contact `ops@haratrust.io`.*
