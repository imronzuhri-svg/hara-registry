# Hara Registry — Go SDK

Official Go SDK for **Hara Registry**, a permissioned Hyperledger Besu (QBFT)
blockchain for palm-oil supply-chain traceability with post-quantum (ML-DSA-65)
audit anchoring.

- Chain ID **131216**, ~2s blocks, instant finality, **gas price 0** (free chain).
- ERC-1155 batches (1 token = 1 litre), a custody-hop relay, a contract registry,
  and a PQ anchor registry.
- A traceability REST API (`/v1/*`) for batch / hop / DAG queries.

Source of truth for all addresses, endpoints and interfaces:
`doc/api/hara-registry-facts.md` in the repo.

## Install

```sh
go get github.com/imronzuhri-svg/hara-registry/sdk/go@latest
```

```go
import hararegistry "github.com/imronzuhri-svg/hara-registry/sdk/go"
```

## The three rules that bite every integrator

This SDK enforces all three so you don't have to remember them — but know them:

1. **Legacy txs only, `gasPrice 0`, `chainId 131216`.** EIP-1559 (type-2) txs are
   rejected. `SendLegacyTx` always builds a `types.LegacyTx` with `GasPrice = 0`
   and signs with `EIP155Signer(131216)`.
2. **Pre-fund ≥ 1 wei native HARA before a wallet's first tx.** Besu silently
   drops txs from zero-balance senders even at gas price 0. `EnsureFunded` checks
   this and `SendLegacyTx` calls it automatically, returning a clear error.
3. **Verify `receipt.status == 0x1`.** A mined tx can still have reverted.
   `WaitReceipt` returns an error when `status != 1`.

Other conventions: reads go to `/read/` (cached), writes to `/write/`
(`eth_sendRawTransaction`); the trailing slash matters. The trace API requires
HTTP Basic auth. ContractRegistry names are `keccak256(utf8(name))` and versions
are real `uint64` (not padded ASCII).

## Endpoints & addresses

All exported as constants/vars in `config.go`:

| | |
|---|---|
| Read RPC | `https://rpc.ledger.haratrust.io/read/` |
| Write RPC | `https://rpc.ledger.haratrust.io/write/` |
| WebSocket | `wss://rpc.ledger.haratrust.io/ws` |
| Explorer | `https://explorer.ledger.haratrust.io/` |
| Trace API | `https://trace.ledger.haratrust.io` (HTTP Basic) |

Contracts: `AddrHaraPalmOil`, `AddrTraceabilityBatchRelay`, `AddrPQAnchorRegistry`,
`AddrContractRegistry`, `AddrGovernanceContract`, `AddrAnchorRegistryLegacy`
(as `common.Address`, with `*Hex` string twins).

## Quick start — read on-chain balance

```go
ctx := context.Background()
chain, _ := hararegistry.NewChainClient(ctx)
defer chain.Close()

bal, _ := chain.PalmOil().BalanceOf(ctx, account, big.NewInt(batchID))
fmt.Printf("%s litres held\n", bal)
```

## Quick start — query the trace API

```go
trace := hararegistry.NewTraceClient(
    hararegistry.WithBasicAuth(user, pass),
)
batch, _ := trace.GetBatch(ctx, "12345")
hops, _ := trace.GetHops(ctx, "12345")
graph, _ := trace.GetGraph(ctx, "12345", true) // aggregate=true => weighted DAG
```

## Quick start — write a tx (mint → approve → relay)

```go
chain, _ := hararegistry.NewChainClient(ctx)
palmOil := chain.PalmOil()
relay := chain.Relay()

// 1. mint (MINTER_ROLE) — receipt status checked for you
_, err := palmOil.MintBatch(ctx, minterKey, batchID, firstOwner, liters,
    rspoHash, plantationID, productionDate)

// 2. each intermediate holder approves the relay ONCE
_, err = palmOil.SetApprovalForAll(ctx, holderKey, relay.Address(), true)

// 3. relay moves the batch down the chain of holders in ONE atomic tx
_, err = relay.ExecuteChain(ctx, initiatorKey, palmOil.Address(),
    batchID, liters, holders) // holders[0]=owner ... last=final custodian
```

Use the relay (`ExecuteChain` / `ExecuteChainVariable` / `ExecuteHops`) for
chained transfers — do **not** pre-sign N dependent `safeTransferFrom` txs; QBFT
does not preserve mempool order and most will revert.

## Contract registry

```go
reg := chain.Registry()
addr, _ := reg.GetActive(ctx, "IssuerRegistry") // keccak256(utf8(name)) keying
_, err := reg.Register(ctx, registrarKey, "IssuerRegistry", 1, newAddr) // version uint64
```

## PQ anchoring

`PQAnchorRegistry.RecordAnchor` commits `keccak256(ML-DSA signature)` on-chain.
The ML-DSA-65 (Dilithium-3) signing is **the caller's responsibility** and runs
off-chain; this SDK only packs/sends the commitment. `PackRecordAnchor` gives you
the raw calldata if you manage signing/nonce yourself.

```go
rec := hararegistry.AnchorRecord{
    MerkleRoot: root, Sha3Root: sha3, BlockFrom: 1000, BlockTo: 2000,
    EventCount: 512, PQSignatureHash: hararegistry.PQSignatureHash(sigBytes),
}
_, err := chain.PQAnchors().RecordAnchor(ctx, anchorKey, rec)
```

## Examples

Runnable programs under `examples/`:

- `examples/read_batch` — trace API batch + hops, and chain height.
- `examples/balance` — on-chain ERC-1155 balance via `eth_call` (no key).
- `examples/execute_chain` — full mint + approve + relay flow.

```sh
go run ./examples/balance 0xYourAddress 12345
TRACE_USER=u TRACE_PASS=p go run ./examples/read_batch 12345
MINTER_KEY=.. HOLDER0_KEY=.. HOLDER1_KEY=.. go run ./examples/execute_chain
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
