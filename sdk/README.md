# Hara Registry SDKs

Official client libraries for the **Hara Registry** core services — the permissioned
Besu/QBFT chain (chain ID **131216**), the `HaraPalmOil` ERC-1155 token + custody
relay, the post-quantum anchor registry, and the Traceability REST API.

All three wrap the same surface and bake in the chain's non-negotiable conventions
(legacy txs, `gasPrice 0`, `chainId 131216`, pre-fund guard, receipt-status check).
They share one source of truth: [`../doc/api/hara-registry-facts.md`](../doc/api/hara-registry-facts.md).

| SDK | Path | Built on | Install |
|---|---|---|---|
| **TypeScript / Node** | [`typescript/`](typescript) | [viem](https://viem.sh) | `npm i @hara/registry-sdk` |
| **Python** | [`python/`](python) | [web3.py](https://web3py.readthedocs.io) + requests | `pip install hara-registry` |
| **Go** | [`go/`](go) | [go-ethereum](https://geth.ethereum.org) | `go get github.com/imronzuhri-svg/hara-registry/sdk/go` |

> The packages are not yet published to npm/PyPI/pkg.go.dev — install from this repo
> for now (`npm install` in `typescript/`, `pip install -e .` in `python/`,
> `go mod tidy` in `go/`).

## What each SDK gives you
- **Chain client** — `getBlockNumber`, `getChainId`, `getBalance`; a legacy-tx sender
  (gasPrice 0 / chainId 131216 baked in), `waitForReceipt` that **errors on a reverted
  tx**, and an `ensureFunded` guard for the zero-balance drop.
- **Contracts** — typed wrappers for `HaraPalmOil` (balanceOf / mintBatch /
  setApprovalForAll), `TraceabilityBatchRelay` (executeChain / Variable / Hops),
  `ContractRegistry` (getActive / register — `name = keccak256(utf8(name))`,
  `version` is `uint64`), and `PQAnchorRegistry` (recordAnchor).
- **Trace REST client** — `listBatches`, `getBatch`, `getHops`, `getGraph`,
  `holderBatches` (HTTP Basic auth for `trace.ledger.haratrust.io`).
- **Anchor helper** — builds the `recordAnchor` calldata; ML-DSA-65 signing is the
  caller's responsibility (e.g. `@noble/post-quantum`).

Each SDK ships runnable `examples/` including the **mint → approve → executeChain**
custody pattern. For end-to-end guidance see the
[Developer & Integration Manual](../doc/guides/hara-registry-developer-integration-manual.md)
and try requests live in the [API Console](../api-console/index.html).
