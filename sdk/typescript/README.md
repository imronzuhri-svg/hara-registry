# @hara/registry-sdk

Official TypeScript/Node SDK for the **Hara Registry** — a permissioned Hyperledger Besu (QBFT) chain (**chain id 131216**) for palm-oil supply-chain traceability with post-quantum audit anchoring.

Built on [viem](https://viem.sh). ESM-only, strict TypeScript.

## Install

```bash
npm install @hara/registry-sdk viem
# optional, only if you build/verify post-quantum anchor signatures yourself:
npm install @noble/post-quantum
```

## The three rules that bite every integrator

This chain has a free gas market (`zeroBaseFee`) and a quirky Besu mempool. The SDK bakes all three in, but you must understand them:

1. **Legacy txs, `gasPrice 0`, `chainId 131216` — always.** EIP-1559 (type-2) fields are rejected. `HaraChainClient.sendLegacyTx()` sets `type: "legacy", gasPrice: 0n` and pins the chain for you.
2. **Pre-fund ≥ 1 wei native HARA before a wallet's first tx.** Besu silently drops zero-balance senders even at gasPrice 0 — the tx sits unmined and your tool hangs. Call `ensureFunded(addr)` first (it warns on zero balance).
3. **Verify `receipt.status === "success"`.** A mined tx can still have reverted. `waitForReceipt(hash)` **throws** if the status is not `"success"`.

Other conventions: reads go to `/read/` (cached LB), writes to `/write/`; the trailing slash matters. For chained/dependent transfers use `TraceabilityBatchRelay` — do **not** pre-sign N dependent transfers and flood the mempool (QBFT doesn't preserve order; most revert).

## Endpoints & addresses

```ts
import { CHAIN_ID, ENDPOINTS, ADDRESSES, haraChain } from "@hara/registry-sdk";

CHAIN_ID;            // 131216
ENDPOINTS.read;      // https://rpc.ledger.haratrust.io/read/
ENDPOINTS.write;     // https://rpc.ledger.haratrust.io/write/
ENDPOINTS.ws;        // wss://rpc.ledger.haratrust.io/ws
ENDPOINTS.trace;     // https://trace.ledger.haratrust.io/   (HTTP Basic)
ENDPOINTS.explorer;  // https://explorer.ledger.haratrust.io/
ADDRESSES.HaraPalmOil;            // 0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
ADDRESSES.TraceabilityBatchRelay; // 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
ADDRESSES.ContractRegistry;       // 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
ADDRESSES.PQAnchorRegistry;       // 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
```

## Examples

### 1. Read on-chain balance (no wallet)

```ts
import { createReadClient, HaraPalmOil } from "@hara/registry-sdk";

const client = createReadClient();
const palmOil = new HaraPalmOil(client);

const liters = await palmOil.balanceOf("0xPlantation…", 42n);
console.log(`${liters} litres of batch 42`);
```

### 2. Read batch traceability (REST, HTTP Basic)

```ts
import { TraceClient } from "@hara/registry-sdk";

const trace = new TraceClient({ user: process.env.TRACE_USER, pass: process.env.TRACE_PASS });

const batches = await trace.listBatches({ limit: 10 });
const hops    = await trace.getHops("42");
const graph   = await trace.getGraph("42", { aggregate: true }); // Cytoscape/React-Flow ready
```

### 3. Mint → approve → relay a custody chain (write)

```ts
import { HaraChainClient, HaraPalmOil, TraceabilityBatchRelay, ADDRESSES } from "@hara/registry-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";

const minter = privateKeyToAccount(process.env.MINTER_PK as `0x${string}`);
const client = new HaraChainClient({ account: minter });

await client.ensureFunded(minter.address);            // rule 2

const palmOil = new HaraPalmOil(client);
const relay   = new TraceabilityBatchRelay(client);

const mintHash = await palmOil.mintBatch({
  batchId: 42n, firstOwner: minter.address, liters: 1000n,
  rspoCertificateHash: keccak256(toBytes("RSPO-CERT")),
  plantationId: keccak256(toBytes("PLANTATION-1")),
  productionDate: BigInt(Math.floor(Date.now() / 1000)),
});
await client.waitForReceipt(mintHash);                // rule 3 (throws on revert)

await client.waitForReceipt(
  await palmOil.setApprovalForAll(ADDRESSES.TraceabilityBatchRelay, true),
);

const chainHash = await relay.executeChain(
  ADDRESSES.HaraPalmOil, 42n, 1000n,
  [minter.address, "0xMill…", "0xRefinery…"],         // holders[0] = current owner
);
await client.waitForReceipt(chainHash);
```

### 4. Subscribe to new blocks (WebSocket)

```ts
import { createPublicClient, webSocket } from "viem";
import { ENDPOINTS, haraChain } from "@hara/registry-sdk";

const client = createPublicClient({ chain: haraChain, transport: webSocket(ENDPOINTS.ws) });
const unwatch = client.watchBlocks({ onBlock: (b) => console.log("block", b.number) });
```

Runnable versions of all four live in [`examples/`](./examples).

## ContractRegistry — name encoding gotcha

`name` is keyed as **`keccak256(utf8(name))`** (not `format-bytes32-string`), and `version` is a **`uint64`** (`bigint`). The SDK handles the hashing — pass the human-readable string:

```ts
import { ContractRegistry } from "@hara/registry-sdk";

const reg = new ContractRegistry(client);
const addr = await reg.getActive("IssuerRegistry");           // hashes internally
await reg.register("IssuerRegistry", 1n, "0xNewImpl…");        // version is bigint
```

## Post-quantum anchoring

`PQAnchorRegistry` commits `keccak256(ML-DSA-65 signature)` on-chain; the signature blob lives off-chain. **ML-DSA signing is done by the caller** — use the optional `@noble/post-quantum` (`ml_dsa65`):

```ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { PQAnchorRegistry, pqSignatureHashFromSig } from "@hara/registry-sdk";

const sig = ml_dsa65.sign(secretKey, merkleRootBytes);
const pq  = new PQAnchorRegistry(client);
await client.waitForReceipt(await pq.recordAnchor({
  merkleRoot, sha3Root, blockFrom: 1000n, blockTo: 2000n, eventCount: 512n,
  anchorChain, pqSignatureHash: pqSignatureHashFromSig(sig),
}));
```

`pqSignatureHash` must be non-zero — the contract reverts `MissingPQCommitment()` otherwise.

## Build

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```

## License

Apache-2.0 · [hara-registry](https://github.com/imronzuhri-svg/hara-registry) · `ops@haratrust.io`
