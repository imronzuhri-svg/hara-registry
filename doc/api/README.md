# Hara Registry — Developer Platform

The complete, current developer & third-party surface for **Hara Registry** — the
permissioned Hyperledger Besu (QBFT) chain for palm-oil traceability + post-quantum
audit anchoring. Everything below is built from one source of truth:
[`hara-registry-facts.md`](hara-registry-facts.md) (chain config, endpoints,
contract addresses, conventions). If a fact is wrong, fix it there first.

---

## The set (what's here, by audience)

| You are… | Start here |
|---|---|
| A partner / regulator / user evaluating the platform | **[Product & Users Manual](../product/hara-registry-product-manual.md)** — plain-language, what it is, who uses it, how to verify a QR |
| An engineer / auditor needing the full picture | **[Technical Manual](../technical/hara-registry-technical-manual.md)** — architecture, all contracts (verified signatures), APIs, security |
| A developer writing integration code | **[Developer & Integration Manual](../guides/hara-registry-developer-integration-manual.md)** — quickstart + tasks with TS/Python/curl, deploy, mint, relay, anchor, index |
| Anyone who wants to *try* the API live | **[Interactive API Console](../../api-console/index.html)** — fill params, hit the live endpoints, copy code in curl/TS/Python/Go |
| A developer who wants a library | **SDKs:** [TypeScript](../../sdk/typescript) · [Python](../../sdk/python) · [Go](../../sdk/go) |

### Reference specs
- **[`openapi-trace.yaml`](openapi-trace.yaml)** — OpenAPI 3.1 for the Traceability REST API (load in Swagger UI / RapiDoc / Postman).
- **[`jsonrpc-reference.md`](jsonrpc-reference.md)** — the chain JSON-RPC surface + key contract calls, with `curl` examples.
- **[`hara-registry-facts.md`](hara-registry-facts.md)** — canonical chain config, endpoints, addresses, conventions (the source of truth).

---

## Public endpoints

| URL | What | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC reads | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC writes (`eth_sendRawTransaction`) | none |
| `https://rpc.ledger.haratrust.io/ws` | JSON-RPC WebSocket subscriptions | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout explorer (+ `/api/v2/*`) | none |
| `https://trace.ledger.haratrust.io/` | Traceability REST API (`/v1/*`) + DAG viewer | HTTP Basic |

**Chain ID `131216` · gas price `0` · legacy txs only · EVM London.** The trailing
slash on `/read/` and `/write/` matters. Reads → `/read/`, writes → `/write/`.

## Contracts (chain 131216)
HaraPalmOil (ERC-1155) `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` ·
TraceabilityBatchRelay `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` ·
PQAnchorRegistry `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` ·
ContractRegistry `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` ·
GovernanceContract `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` ·
AnchorRegistry (legacy) `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`.

---

## 30-second quickstart

**curl — current block height**
```bash
curl -s -X POST https://rpc.ledger.haratrust.io/read/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
```

**curl — trace a batch** (HTTP Basic; ask ops for credentials)
```bash
curl -s -u "$U:$P" "https://trace.ledger.haratrust.io/v1/batches?limit=1"
```

**TypeScript** (`sdk/typescript`)
```ts
import { HaraChainClient, TraceClient } from "@hara/registry-sdk";
console.log(await new HaraChainClient().getBlockNumber());
const trace = new TraceClient({ username: U, password: P });
console.log(await trace.listBatches({ limit: 1 }));
```

**Python** (`sdk/python`)
```python
from hara_registry import HaraRegistry
hr = HaraRegistry(trace_auth=(U, P))
print(hr.chain.get_block_number())
print(hr.trace.list_batches(limit=1))
```

**Go** (`sdk/go`)
```go
c, _ := hararegistry.NewChainClient(context.Background(), "")
n, _ := c.BlockNumber(context.Background())
fmt.Println(n)
```

---

## The three rules that bite everyone
1. **Legacy txs, `gasPrice 0`, `chainId 131216`.** EIP-1559 fields are rejected.
2. **Pre-fund ≥ 1 wei** to a wallet before its first tx — Besu silently drops zero-balance senders even at gas price 0.
3. **Check `receipt.status == 0x1`** — a mined tx can still have reverted.

See the [Developer Manual](../guides/hara-registry-developer-integration-manual.md) for
the rest (the `TraceabilityBatchRelay` for chained custody hops, PQ anchoring, indexing).

Contact: `ops@haratrust.io` · Repo: https://github.com/imronzuhri-svg/hara-registry
