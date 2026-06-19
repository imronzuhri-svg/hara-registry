# Hara Registry — API Console

A self-contained, dependency-free interactive API console for Hara Registry
(permissioned Hyperledger Besu / QBFT chain, ID **131216**, palm-oil
supply-chain traceability with post-quantum anchoring).

Open `index.html` and you can hit the **live production** API from your browser:
chain JSON-RPC, contract reads, and the Traceability REST API. Every operation
has a request form, a live **Send** button (status + timing + pretty JSON), and
a **Code** tab generating equivalent **curl / TypeScript / Python / Go** snippets.

All facts (endpoints, addresses, selectors, conventions) mirror the canonical
[`doc/api/hara-registry-facts.md`](../doc/api/hara-registry-facts.md). Companion
docs: [`openapi-trace.yaml`](../doc/api/openapi-trace.yaml) (OpenAPI 3.1 for the
trace REST API) and [`jsonrpc-reference.md`](../doc/api/jsonrpc-reference.md).

## Files

| File | Purpose |
|---|---|
| `index.html` | SPA shell + header + catalog/main containers |
| `app.js` | Operation catalog, live fetch, ABI encoding (pure-JS keccak-256), code generation |
| `style.css` | Strata/Hara dark theme (bg `#070B18`, panels `#0C1226`, teal `#2BD4C0`, blue `#3B6BFF`) |
| `README.md` | This file |

No build step, no external CDNs — everything is inline or in this folder.
`app.js` ships a tiny pure-JS keccak-256 (verified: `balanceOf` selector =
`0x00fdd58e`, `getActive` = `0x3f3a5c8a`) so contract-read `eth_call` data is
ABI-encoded in the browser.

## Operations

- **Chain JSON-RPC** — `eth_blockNumber`, `eth_chainId`, `eth_getBalance`,
  `eth_getLogs` (TransferSingle hops), `eth_getTransactionReceipt`,
  `eth_sendRawTransaction` (writes → `/write/`). Read/write endpoint selector.
- **Contract reads** — `HaraPalmOil.balanceOf(account,id)` (litres held) and
  `ContractRegistry.getActive(name)` (`name = keccak256(utf8(name))`). The
  console ABI-encodes the call, POSTs `eth_call` to `/read/`, and decodes the
  uint256 / address result inline.
- **Traceability REST API** — `/v1/batches`, `/v1/batches/:id`,
  `/v1/batches/:id/hops`, `/v1/batches/:id/graph?aggregate=`,
  `/v1/holders/:address/batches`, `/healthz`, `/metrics`. The gated `/v1/*` ops
  expose **username/password** fields and send the HTTP Basic `Authorization`
  header (credentials from `ops@haratrust.io`).

## Running

Just open `index.html` — it is a static file. To serve it (recommended, so
relative asset paths and `fetch` behave consistently):

```bash
cd api-console
python -m http.server 8080
# open http://localhost:8080
```

Behind Caddy, serve the folder as static files (e.g. `file_server` on a
`console.platform.haratrust.io` route).

## Notes & caveats

- **Live endpoints.** Reads are safe; `eth_sendRawTransaction` submits real
  transactions (sign locally — the console never holds keys).
- **CORS.** Production endpoints may not send `Access-Control-Allow-Origin` for
  arbitrary browser origins. When a call fails with a fetch/CORS error, the
  console surfaces the raw error and you can copy the **Code** snippet to run
  the identical request from a terminal or server (no CORS there).
- **Conventions enforced by the chain** (see the facts file): legacy txs only,
  `gasPrice 0`, `chainId 131216`; pre-fund ≥ 1 wei before a wallet's first tx;
  always verify `receipt.status == 0x1`; chunk `eth_getLogs` block ranges.
