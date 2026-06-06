# Hara Registry — Technical Manual

**Version:** 1.0 · 2026-06-01
**Audience:** developers, integration partners, auditors, and anyone consuming Hara Registry data or APIs.

Hara Registry is a permissioned **Hyperledger Besu (QBFT)** blockchain for **palm-oil supply-chain traceability** with **post-quantum (PQ) anchoring**. It records the full custody chain of palm-oil batches as on-chain events and exposes them through a REST traceability API, a JSON-RPC node interface, a block explorer, and a visual custody-DAG viewer.

| Property | Value |
|---|---|
| Chain ID | **131216** |
| Consensus | QBFT (4 validators) |
| Block time | ~2 seconds |
| Gas price | **0** (free; `zeroBaseFee` genesis) |
| Native token | HARA (used only for gas accounting; gas is free) |
| Client | Besu 26.4.0 (Bonsai storage) |

---

## 1. Public Endpoints

| URL | What it is | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC reads (via cache + load balancer) | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC writes (`eth_sendRawTransaction`) | none |
| `https://rpc.ledger.haratrust.io/ws` | JSON-RPC WebSocket (subscriptions) | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout block explorer (+ `/api/*`) | none |
| `https://trace.ledger.haratrust.io/` | Traceability DAG viewer + REST API (`/v1/*`) | **HTTP Basic** |
| `https://grafana.platform.haratrust.io/` | Operational dashboards | login |

> All endpoints are HTTPS (Let's Encrypt). The traceability site is gated with HTTP Basic auth — request credentials from operations.

---

## 2. Chain JSON-RPC API

Standard Ethereum JSON-RPC over HTTPS. Enabled namespaces: **`eth`, `net`, `web3`, `qbft`, `txpool`, `debug`, `trace`**. (`admin` is disabled.)

**Conventions**
- All transactions are **legacy type** with `gasPrice: 0` and `chainId: 131216`.
- Reads → `/read/`; writes (`eth_sendRawTransaction`) → `/write/`.
- Max JSON-RPC batch size: 200.

### 2.1 Current block height
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x2f06f"}
```

### 2.2 Read contract state (`eth_call`)
Example — check whether a contract implements ERC-1155 (`supportsInterface(0xd9b67a26)`):
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","method":"eth_call","id":1,
  "params":[{"to":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
             "data":"0x01ffc9a7d9b67a26000000000000000000000000000000000000000000000000000000 00"},"latest"]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000001"}
```
`balanceOf(account, id)` (selector `0x00fdd58e`) returns the liters an address holds for a given batch id.

### 2.3 Fetch traceability events directly (`eth_getLogs`)
Every custody hop is an ERC-1155 `TransferSingle` log on the HaraPalmOil token:
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","method":"eth_getLogs","id":1,
  "params":[{"address":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
             "fromBlock":"0x33A6A","toBlock":"0x33A6B"}]}'
```
Each returned log contains the `TransferSingle(operator, from, to, id, value)` fields (`id` = batch id, `value` = liters).

### 2.4 Submitting a transaction
1. Build a **legacy** tx: `{ type:"legacy", chainId:131216, nonce, to, data, value:0, gasPrice:0, gas }`.
2. Sign locally and submit the raw tx to `/write/`:
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/write/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","id":1,"params":["0x<signed-raw-tx>"]}'
```
3. Poll `eth_getTransactionReceipt`. **Check `status` = `0x1`** — a `0x0` status means the call reverted even though it was mined.

> Writing to most contracts requires a role (see §5). Open reads need nothing.

---

## 3. Traceability REST API

Base URL: **`https://trace.ledger.haratrust.io`** (HTTP Basic auth). Same-origin to the indexer; responses are JSON. All amounts are in **liters**.

### 3.1 `GET /v1/batches` — list batches
Query params: `limit` (default 50), `offset` (default 0). Ordered by `minted_at` desc.
```bash
curl -s -u <user>:<pass> "https://trace.ledger.haratrust.io/v1/batches?limit=2"
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

### 3.2 `GET /v1/batches/:batchId` — one batch summary
Returns the single object above. `404 {"error":"batch not found"}` if unknown.

### 3.3 `GET /v1/batches/:batchId/hops` — full custody chain
Every `TransferSingle`, in custody order (by block, then log index).
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
    // … one object per hop (e.g. 499)
  ]
}
```

### 3.4 `GET /v1/batches/:batchId/graph` — custody graph
Returns `{ batch, nodes[], edges[], aggregated }` ready for graph rendering (Cytoscape / React Flow).
Query param: `?aggregate=true` collapses parallel A→B transfers into one weighted edge (best for DAG views); omit it for one edge per transfer (linear traceability).

```json
{
  "batch": { "batch_id": "1780285655133", "...": "(summary as in 3.1)" },
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
**Node flags:** `isFirstOwner` (plantation / origin), `isCurrentHolder` (terminal holder with positive balance), `isPassThrough` (everything received was forwarded on).

### 3.5 `GET /v1/holders/:address/batches` — batches an address touched
```json
{ "address": "0x1481a1…", "batches": ["1780285655133", "…"] }
```

### 3.6 Health & metrics
- `GET /healthz` → `200` when the indexer is up.
- `GET /metrics` → Prometheus metrics (`hara_indexer_last_indexed_block`, `hara_indexer_chain_head_block`, index lag, …).

### 3.7 Field reference
| Field | Meaning |
|---|---|
| `batch_id` | ERC-1155 token id of the palm-oil batch |
| `initial_liters` | volume minted at origin |
| `first_owner` | wallet that received the minted volume (plantation) |
| `current_holder` | latest holder |
| `hop_count` | number of custody transfers |
| `rspo_hash` | RSPO certificate hash (sustainability cert) |
| `plantation_id` | plantation identifier hash |
| `production_date` / `minted_at` / `last_hop_at` | timestamps (UTC) |
| `liters` | volume moved in a hop |
| `from_addr` / `to_addr` | sender / receiver wallet |
| `operator_addr` | contract/operator that executed the transfer (the relay) |

---

## 4. Traceability DAG Viewer

`https://trace.ledger.haratrust.io/` (Basic auth) is a browser tool that renders any batch's custody chain as a directed graph:
- **Left panel:** list of batches (id, hop count, current holder).
- **Canvas:** the custody DAG — green = plantation/first owner, blue = pass-through holders, red = current holder. Hover for hop details and tx hash.
- Backed by the `/v1/*` API above (same origin).

---

## 5. Smart Contracts (chain 131216)

| Contract | Address | Purpose |
|---|---|---|
| **HaraPalmOil** (ERC-1155) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | the palm-oil batch token; each `TransferSingle` is a custody hop; `BatchMinted` carries RSPO + plantation metadata |
| **TraceabilityBatchRelay** | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | executes multi-hop custody transfers in one tx (`executeChain`) |
| **PQAnchorRegistry** | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | anchors post-quantum (ML-DSA-65) signatures of event batches |
| **ContractRegistry** | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | name → address registry for all platform contracts |
| **GovernanceContract** | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | platform governance |
| **AnchorRegistry** (legacy ECDSA) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | legacy ECDSA anchoring (kept for compatibility) |

**Key interfaces**
- ERC-1155 standard: `balanceOf(address,uint256)`, `isApprovedForAll`, `setApprovalForAll`, events `TransferSingle`, `ApprovalForAll`.
- HaraPalmOil custom: `BatchMinted(batchId, firstOwner, liters, rspoCertificateHash, plantationId, productionDate)`.
- Access control (OpenZeppelin): `hasRole(bytes32,address)`, `grantRole`, `revokeRole`. Roles: `MINTER_ROLE` (HaraPalmOil), `ANCHOR_ROLE` + `KEY_ROTATOR_ROLE` (PQAnchorRegistry), `REGISTRAR_ROLE` (ContractRegistry), `DEFAULT_ADMIN_ROLE`.
- Discover any contract by name via `ContractRegistry`. Full ABIs live in the repo under `services/indexer/src/abis.ts` and `chain/`/`contracts`.

---

## 6. Post-Quantum Anchoring

To make the traceability record resilient against future quantum attacks, batches of events are signed with **ML-DSA-65 (FIPS 204)** and the signature commitments are anchored on-chain via **PQAnchorRegistry**. The signature blobs are stored in object storage; the on-chain anchor records the commitment hash, algorithm (`ml-dsa-65`), signer DID, and the storage object key. This lets anyone independently verify that a set of traceability events existed and was signed at a point in time, with a PQ-safe signature.

---

## 7. Block Explorer

`https://explorer.ledger.haratrust.io/` (Blockscout) — browse blocks, transactions, addresses, and the HaraPalmOil token (`/token/0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`). Programmatic access via the Blockscout REST/V2 API under `/api/*`, e.g.:
```bash
curl -s https://explorer.ledger.haratrust.io/api/v2/tokens/0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
```

---

## 8. Quickstart Recipes

**Trace one batch end-to-end**
```bash
BASE=https://trace.ledger.haratrust.io
curl -s -u $U:$P "$BASE/v1/batches?limit=1"            # find a batch id
curl -s -u $U:$P "$BASE/v1/batches/<id>"               # summary
curl -s -u $U:$P "$BASE/v1/batches/<id>/hops"          # full custody chain
curl -s -u $U:$P "$BASE/v1/batches/<id>/graph?aggregate=true"  # graph for visualisation
```

**Verify a holder's current balance for a batch (no auth, direct from chain)**
```bash
# balanceOf(holder, batchId) on HaraPalmOil via eth_call on /read/
```

**Watch new blocks**
```bash
wscat -c wss://rpc.ledger.haratrust.io/ws   # then eth_subscribe newHeads
```

---

## Appendix — Notes & Limits

- **Gas is free** (`gasPrice 0`); you still need a funded-enough account only for the 1-wei value transfers some flows use.
- **Receipts:** always verify `status: 0x1`; a mined tx can still have reverted.
- **Rate limits:** HAProxy enforces ~5,000 requests / 10s per IP and 32k concurrent connections at the LB.
- **Addresses** in the traceability API are returned as stored (mixed-case checksummed); the holder lookup matches case-sensitively.
- **Reads vs writes:** route reads to `/read/` (cached) and writes to `/write/`.

*For credentials, ABIs, or integration support, contact operations (ops@haratrust.io).*
