# hara-registry — Python SDK

Official Python SDK for **Hara Registry**, a permissioned Hyperledger Besu
(QBFT) chain for palm-oil supply-chain traceability with post-quantum audit
anchoring.

- Package: `hara_registry`
- Chain ID: **131216**
- Python: 3.10+
- License: Apache-2.0

## Install

```bash
cd sdk/python
pip install -e .
```

Dependencies: `web3>=6`, `requests`. (The `subscribe.py` example also needs
WebSocket support: `pip install 'web3[ws]'`.)

## Conventions this SDK enforces

Three rules bite every integrator on this chain — the SDK bakes them in so you
don't have to:

1. **Legacy (type-0) txs, `gasPrice 0`, `chainId 131216`.** Always. EIP-1559
   type-2 transactions are rejected by the Besu nodes. `ChainClient.send_legacy_tx`
   builds exactly this shape.
2. **Pre-fund every wallet with ≥ 1 wei native HARA before its first tx.** Besu
   silently drops zero-balance senders *even though gas is free* — the tx sits
   unmined and your tool hangs. `ChainClient.ensure_funded(addr)` warns you
   (`ZeroBalanceWarning`) and is called automatically before every send.
3. **Verify `receipt.status == 0x1`.** A mined tx can still have reverted.
   `ChainClient.wait_for_receipt(tx_hash)` **raises `ReceiptStatusError`** if it did.

Reads go to the cached `/read/` endpoint; raw signed writes go to `/write/`
(`eth_sendRawTransaction`). The trailing slash on those paths is required.

## Quick start

```python
from hara_registry import HaraRegistry

reg = HaraRegistry()                       # public read endpoint, no key needed

# Reads
print(reg.chain.get_chain_id())            # 131216
print(reg.chain.get_block_number())
print(reg.palm_oil.balance_of(account, batch_id))   # litres held

# Resolve a contract by name (keccak256(utf8(name)) keyed)
addr = reg.registry.get_active("IssuerRegistry")

# Writes (need a funded wallet + private key)
txh = reg.palm_oil.set_approval_for_all(PRIVATE_KEY, reg.relay.address, True)
reg.chain.wait_for_receipt(txh)            # raises on revert
```

### Trace API (HTTP Basic auth)

```python
reg = HaraRegistry(trace_user="...", trace_pass="...")
for b in reg.trace.list_batches(limit=10):
    print(b.batch_id, b.initial_liters, b.current_holder)

hops  = reg.trace.get_hops(batch_id)       # custody trail
graph = reg.trace.get_graph(batch_id, aggregate=True)   # DAG view
held  = reg.trace.holder_batches(address)
```

### Custody chain (mint → approve → relay)

Use `TraceabilityBatchRelay` for chained transfers — do **not** pre-sign N
dependent `safeTransferFrom` txs (QBFT doesn't preserve mempool order, so most
revert). Each intermediate holder must `setApprovalForAll(relay, True)` once.

```python
reg.palm_oil.mint_batch(MINTER_KEY, batch_id, origin, 1000, rspo, plantation, prod_date)
reg.palm_oil.set_approval_for_all(ORIGIN_KEY, reg.relay.address, True)
txh = reg.relay.execute_chain(ORIGIN_KEY, reg.palm_oil.address, batch_id, 1000,
                              [origin, mill, refinery])
reg.chain.wait_for_receipt(txh)
```

### Post-quantum anchoring

ML-DSA-65 signing is **the caller's job** — produce the signature with your own
PQ toolchain, then commit its hash on-chain:

```python
from hara_registry import AnchorPayload

payload = AnchorPayload.build(merkle_root, sha3_root, block_from, block_to,
                              event_count, ml_dsa_signature=sig_bytes)
txh = payload.submit(reg.chain, ANCHOR_KEY)
reg.chain.wait_for_receipt(txh)
```

## Examples

Runnable scripts in [`examples/`](examples/):

| File | What it shows |
|---|---|
| `read_batch.py` | Read a batch + its custody hops from the trace API |
| `balance.py` | Chain height + an on-chain ERC-1155 batch balance |
| `execute_chain.py` | Full write flow: mint + approve + relay a custody chain |
| `subscribe.py` | Subscribe to `newHeads` over the WebSocket endpoint |

## Public endpoints

| URL | Purpose | Auth |
|---|---|---|
| `https://rpc.ledger.haratrust.io/read/` | JSON-RPC reads (cached) | none |
| `https://rpc.ledger.haratrust.io/write/` | JSON-RPC writes | none |
| `wss://rpc.ledger.haratrust.io/ws` | Subscriptions | none |
| `https://explorer.ledger.haratrust.io/` | Blockscout explorer | none |
| `https://trace.ledger.haratrust.io/` | Traceability REST API | HTTP Basic |

## Deployed contracts (chain 131216)

| Contract | Address |
|---|---|
| HaraPalmOil (ERC-1155) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` |
| TraceabilityBatchRelay | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| PQAnchorRegistry | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` |
| ContractRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| GovernanceContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| AnchorRegistry (legacy) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |

Canonical reference: `doc/api/hara-registry-facts.md`.

---

Maintainer `@imronzuhri-svg` · `ops@haratrust.io` ·
<https://github.com/imronzuhri-svg/hara-registry>
