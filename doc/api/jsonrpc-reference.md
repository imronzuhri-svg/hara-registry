# Hara Registry — Chain JSON-RPC Reference

Standard Ethereum JSON-RPC over HTTPS for the Hara Registry permissioned chain
(Hyperledger Besu 26.4.0, QBFT). This reference is derived from the canonical
[`hara-registry-facts.md`](./hara-registry-facts.md) — if anything here disagrees,
the facts file wins.

---

## 1. Endpoints

| URL | Use | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC **reads** (cached, via rpc-cache + LB) | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC **writes** (`eth_sendRawTransaction`) | none |
| `https://rpc.ledger.haratrust.io/ws` | WebSocket subscriptions (`eth_subscribe`) | none |

> **The trailing slash matters.** `…/read/` works; `…/read` returns `404 Route not found`.
> **Reads → `/read/`** (short 1–3 s cache TTL on dynamic methods); **writes → `/write/`**.

WG-mesh internal equivalents (services only, not external):
`http://10.43.0.21:8545/rpc/{read,write}`, WS `ws://10.43.0.21:8546/rpc/read`.

---

## 2. Enabled namespaces

`eth`, `net`, `web3`, `qbft`, `txpool`, `debug`, `trace`. **`admin` is disabled.**

---

## 3. Conventions that bite every integrator

| Rule | Detail |
|---|---|
| **Chain ID** | `131216` (`0x20070`). |
| **Tx type** | **Legacy (type 0) only.** EIP-1559 type-2 fields (`maxFeePerGas`, …) are rejected. |
| **Gas price** | `0` always (`zeroBaseFee` genesis — the chain is free). |
| **Pre-fund rule** | Send ≥ 1 wei native HARA to a wallet **before its first tx**. Besu silently skips zero-balance senders even at `gasPrice 0`; your tx sits unmined and your tooling hangs. |
| **Receipt check** | A mined tx can still revert — always verify `receipt.status == 0x1`. |
| **EVM target** | London. No `PUSH0` — compile contracts with `evm_version = "london"`. |
| **Batch limit** | Up to **200** calls per JSON-RPC POST on the public LB (Besu nodes themselves accept 4096). |
| **`eth_getLogs` range** | Full-range `getLogs` exceeds the RPC range limit — **chunk by block range**. |
| **Rate limit** | HAProxy ~5,000 requests / 10 s per source IP; 32k concurrent. |

A canonical legacy tx object to sign locally:

```json
{ "type": "legacy", "chainId": 131216, "nonce": 0,
  "to": "0x...", "data": "0x...", "value": 0, "gasPrice": 0, "gas": 200000 }
```

---

## 4. Most-used methods

All examples POST to `/read/` unless noted. Replace ids/addresses as needed.

| Method | Purpose | Endpoint |
|---|---|---|
| `eth_blockNumber` | Current block height | `/read/` |
| `eth_chainId` | Chain id (expect `0x20070` = 131216) | `/read/` |
| `eth_getBalance` | Native HARA balance (check pre-funding) | `/read/` |
| `eth_call` | Read contract state (e.g. `balanceOf`) | `/read/` |
| `eth_getLogs` | Custody hops via `TransferSingle` | `/read/` |
| `eth_sendRawTransaction` | Submit a signed legacy tx | **`/write/`** |
| `eth_getTransactionReceipt` | Poll a tx outcome, check `status` | `/read/` |

### 4.1 `eth_blockNumber`
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x2f06f"}
```

### 4.2 `eth_chainId`
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x20070"}   (131216)
```

### 4.3 `eth_getBalance`
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance",
       "params":["0xa513E6E4b8f2a923D98304ec87F64353C4D5C853","latest"]}'
```
A `0x0` result means the wallet is unfunded — it must receive ≥ 1 wei before its first tx.

### 4.4 `eth_call` — `balanceOf` (ERC-1155 litres held)
See [§5.1](#51-harapalmoilbalanceofaccount-id). Selector `0x00fdd58e`.

### 4.5 `eth_getLogs` — `TransferSingle` (custody hops)
`TransferSingle(operator, from, to, id, value)` topic0 =
`0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62`.
Chunk the block range to stay under the range limit.
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
        "address":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
        "topics":["0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"],
        "fromBlock":"0x0","toBlock":"0x3e8"}]}'
```
In each log: `id` = batchId, `value` = litres (both in `data`); `from`/`to` are indexed topics.

### 4.6 `eth_sendRawTransaction` (writes → `/write/`)
Build a legacy tx (`chainId 131216`, `gasPrice 0`), sign locally, then:
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/write/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xf86c..."]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x<txHash>"}
```

### 4.7 `eth_getTransactionReceipt`
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0x<txHash>"]}'
```
**Verify `result.status == "0x1"`.** `0x0` = mined-but-reverted.

---

## 5. Key contract calls (`eth_call` → `/read/`)

ABI-encode `data` as `selector || 32-byte-padded args`, POST `eth_call` with
`{ to, data }` and `"latest"`.

### 5.1 `HaraPalmOil.balanceOf(account, id)`
- Contract: `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`
- Signature: `balanceOf(address,uint256)` → **selector `0x00fdd58e`**
- `data` = `0x00fdd58e` + `account` (left-padded to 32 bytes) + `id` (32 bytes)

Example — litres of batch `1001` held by `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`:
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
        "to":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
        "data":"0x00fdd58e00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000003e9"
      },"latest"]}'
# result is uint256 litres, hex-encoded (e.g. 0x...0bb8 = 3000)
```
(`0x3e9` = 1001; `0xbb8` = 3000.)

### 5.2 `ContractRegistry.getActive(name)`
- Contract: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
- Signature: `getActive(bytes32)` → **selector `0x3f3a5c8a`**
  (first 4 bytes of `keccak256("getActive(bytes32)")`)
- **`name` is `keccak256(utf8("ContractName"))`** — NOT `formatBytes32String`.
  E.g. `keccak256("IssuerRegistry")` =
  `0xfa936a8de36c4ef0bcce695122e37a1defc99ebd9ef457ee7aeea82c29d76d7b`.
- `data` = `0x3f3a5c8a` + `name` (32 bytes)

Example — active address registered under name `IssuerRegistry`:
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
        "to":"0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        "data":"0x3f3a5c8afa936a8de36c4ef0bcce695122e37a1defc99ebd9ef457ee7aeea82c29d76d7b"
      },"latest"]}'
# result is a 32-byte word; the active address is its low 20 bytes.
```

### Reference: deployed contracts (chain 131216)

| Contract | Address | Role |
|---|---|---|
| HaraPalmOil | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` | ERC-1155; 1 token = 1 litre |
| TraceabilityBatchRelay | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` | N custody hops in one tx |
| PQAnchorRegistry | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` | ML-DSA-65 audit anchors |
| ContractRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | name → address registry |
| GovernanceContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | role-gated governance |
| AnchorRegistry (legacy) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | legacy ECDSA anchoring |

---

## 6. Subscriptions (WebSocket)

```text
wss://rpc.ledger.haratrust.io/ws
{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}
{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["logs",
  {"address":"0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"}]}
```
