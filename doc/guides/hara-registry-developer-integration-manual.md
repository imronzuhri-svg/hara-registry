# Hara Registry Developer & Third-Party Integration Manual

> **Audience**: developers and integrators writing code against Hara Registry.
> **Goal**: connect your application, deploy contracts, move batches, anchor audit trails, and index events.

**Hara Registry GitHub**: https://github.com/imronzuhri-svg/hara-registry  
**Contact**: `ops@haratrust.io`

---

## Table of Contents

1. [Quickstart](#quickstart)
2. [Non-Negotiable Conventions](#conventions)
3. [Deployer Key & Funding](#deployer)
4. [Deploy Your Own Contract](#deploy)
5. [HaraPalmOil (ERC-1155)](#harapalmoil)
6. [TraceabilityBatchRelay](#relay)
7. [Post-Quantum Anchoring](#pq-anchor)
8. [Indexing Events](#indexing)
9. [Traceability REST API](#rest-api)
10. [Official SDKs](#sdks)
11. [Security & Troubleshooting](#security)

---

## Quickstart

### Connect to the Chain

**TypeScript (viem)**

```typescript
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_READ = "https://rpc.ledger.haratrust.io/read/";
const RPC_WRITE = "https://rpc.ledger.haratrust.io/write/";
const CHAIN_ID = 131216;

const publicClient = createPublicClient({ transport: http(RPC_READ) });
const wallet = privateKeyToAccount("0x...");
const writeClient = createWalletClient({
  account: wallet,
  chain: { id: CHAIN_ID, name: "Hara Registry" },
  transport: http(RPC_WRITE),
});
```

**Python (web3.py)**

```python
from web3 import Web3
w3 = Web3(Web3.HTTPProvider("https://rpc.ledger.haratrust.io/read/"))
assert w3.is_connected()
print(w3.eth.chain_id)  # 131216
```

**cURL**

```bash
curl -X POST https://rpc.ledger.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}"
```

### Verify You Have a Funded Wallet

```typescript
const balance = await publicClient.getBalance({ address: wallet.address });
console.log(`Balance: ${balance} wei`);  // Must be >= 1 wei
```

### Read Batch Balance

```typescript
const balance = await publicClient.readContract({
  address: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  abi: parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)"]),
  functionName: "balanceOf",
  args: ["0x<holder>", BigInt(123)],
});
console.log(`${balance} litres`);
```

---

## Non-Negotiable Conventions

### 1. Legacy Transactions Only

Always use:
- Type: `0x00` (legacy), never `0x02` (EIP-1559)
- ChainId: **131216**
- gasPrice: **0n**

### 2. Pre-Fund with >= 1 Wei

Every wallet must hold >= 1 wei HARA before first transaction. Besu silently rejects zero-balance senders.

### 3. Always Verify Receipt Status

```typescript
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== "0x1") throw new Error("Tx reverted");
```

### 4. EVM London Only

```toml
[profile.default]
evm_version = "london"    # Required, no PUSH0
```

### 5. Trailing Slash Required

- `/read/` ← correct
- `/write/` ← correct
- `/read` ← 404 error

---

## Deployer Key & Funding

### Generate Key

```typescript
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const privateKey = generatePrivateKey();
const deployer = privateKeyToAccount(privateKey);
console.log(deployer.address);
```

### Fund from HARA Ops

Contact `ops@haratrust.io` with your address for initial funding.

---

## Deploy Your Own Contract

### Setup Foundry

```bash
mkdir my-contracts && cd my-contracts
cat > foundry.toml << EOF
[profile.default]
solc_version = "0.8.26"
evm_version = "london"
chain_id = 131216
[rpc_endpoints]
hara = "https://rpc.ledger.haratrust.io/write/"
EOF

mkdir -p lib
git clone --depth 1 --branch v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
```

### Deploy

```bash
export DEPLOYER_PRIVATE_KEY="0x..."
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.ledger.haratrust.io/write/ \
  --broadcast --legacy --skip-simulation \
  --private-key $DEPLOYER_PRIVATE_KEY
```

### Register in ContractRegistry

**Important**: name = keccak256(utf8("ContractName")), NOT format-bytes32-string.

```typescript
const REGISTRY = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const nameHash = keccak256(toHex("IssuerRegistry"));

const registerData = encodeFunctionData({
  abi: parseAbi(["function register(bytes32 name, uint64 version, address addr) external"]),
  functionName: "register",
  args: [nameHash, 1n, "0x..."],
});

await writeClient.sendTransaction({
  to: REGISTRY,
  data: registerData,
  gas: 150_000n,
  gasPrice: 0n,
  type: "legacy",
});
```

---

## HaraPalmOil (ERC-1155)

**Address**: `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`

ERC-1155 where token ID = batch, amount = litres.

### Mint a Batch

```typescript
const mintData = encodeFunctionData({
  abi: parseAbi(["function mintBatch(uint256 batchId, address to, uint256 amount, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate) external"]),
  functionName: "mintBatch",
  args: [BigInt(Date.now()), "0xPlantation", 5000n, keccak256(toHex("rspo")), keccak256(toHex("plantation")), BigInt(Date.now() / 1000)],
});

await writeClient.sendTransaction({
  to: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  data: mintData,
  gas: 250_000n,
  gasPrice: 0n,
  type: "legacy",
});
```

### Approve the Relay (Required)

```typescript
const RELAY = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6";
const approvalData = encodeFunctionData({
  abi: parseAbi(["function setApprovalForAll(address operator, bool approved)"]),
  functionName: "setApprovalForAll",
  args: [RELAY, true],
});

await writeClient.sendTransaction({
  to: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  data: approvalData,
  gas: 60_000n,
  gasPrice: 0n,
  type: "legacy",
});
```

### Listen for Transfers

```typescript
const logs = await publicClient.getLogs({
  address: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  event: parseAbi(["event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"])[0],
  fromBlock: 100_000n,
  toBlock: 100_500n,
});
```

---

## TraceabilityBatchRelay

**Address**: `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`

Executes N custody hops atomically. Why: Besu QBFT doesn't preserve mempool order.

### executeChain (uniform amount)

```typescript
const chainData = encodeFunctionData({
  abi: parseAbi(["function executeChain(address token, uint256 batchId, uint256 amount, address[] holders) external"]),
  functionName: "executeChain",
  args: ["0xa513E6E4b8f2a923D98304ec87F64353C4D5C853", BigInt(123), 1000n, ["0xPlantation", "0xMill", "0xPort"]],
});

await writeClient.sendTransaction({
  to: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  data: chainData,
  gas: 30_000_000n,
  gasPrice: 0n,
  type: "legacy",
});
```

### executeChainVariable (per-leg amounts)

For chains where each custodian takes a split or loss.

### executeHops (arbitrary DAG)

For complex refinery flows with splits and merges.

---

## Post-Quantum Anchoring

**Address**: `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`

Hybrid ECDSA + ML-DSA-65 for long-lived audit trails.

### Pre-Ceremony: Rotate PQ Key

```typescript
import { mlDsa65 } from "@noble/post-quantum/ml-dsa";

const { publicKey, secretKey } = mlDsa65.keygen();
const pubKeyHash = keccak256(publicKey);

const rotateData = encodeFunctionData({
  abi: parseAbi(["function rotatePQKey(bytes32 newKeyHash, string calldata newAlgorithm) external"]),
  functionName: "rotatePQKey",
  args: [pubKeyHash, "ML-DSA-65"],
});

await writeClient.sendTransaction({
  to: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  data: rotateData,
  gas: 100_000n,
  gasPrice: 0n,
  type: "legacy",
});
```

---

## Indexing Events

### Option A: Shared Indexer (Recommended)

```sql
INSERT INTO watched_contracts (contract_address, name, from_block)
VALUES ('0x...', 'YourContractName', 0);
```

### Option B: Chunked getLogs

Query in ~500-block chunks to avoid RPC limits.

### Option C: WebSocket Subscriptions

```typescript
const wsClient = createPublicClient({
  transport: webSocket("wss://rpc.ledger.haratrust.io/ws"),
});

wsClient.watchContractEvent({
  address: CONTRACT,
  abi: [...],
  eventName: "TransferSingle",
  onLogs(logs) {
    for (const log of logs) console.log(log.args);
  },
});
```

---

## Traceability REST API

**URL**: `https://trace.ledger.haratrust.io/v1`  
**Auth**: HTTP Basic

### Endpoints

- GET /batches?limit=50 — list batches
- GET /batches/:batchId — batch details
- GET /batches/:batchId/hops — custody chain
- GET /batches/:batchId/graph?aggregate=true — DAG
- GET /holders/:address/batches — find holder's batches

---

## Official SDKs

- **TypeScript**: `@hara/sdk-typescript` (in `sdk/typescript/`)
- **Python**: `hara-sdk-python` (in `sdk/python/`)
- **Go**: `github.com/imronzuhri-svg/hara-registry/sdk/go`

---

## Security & Troubleshooting

### Pre-Production Checklist

- [ ] Secrets in Vault, never committed
- [ ] Solidity: `evm_version = "london"`
- [ ] Tests: >80% coverage
- [ ] Pre-fund wallets with >= 1 wei
- [ ] Always verify `receipt.status == 0x1`

### Common Issues

| Symptom | Fix |
|---|---|
| "404 Route not found" | Add trailing slash: `/read/` not `/read` |
| Tx never confirmed | Pre-fund wallet with 1 wei |
| "Invalid opcode" on deploy | Use `evm_version = "london"` |
| "nonce too low" | Restart service or use signer |
| getLogs timeout | Chunk by ~500 blocks |
| WebSocket drops | Send keepalive every 30s |

### Debug Commands

```bash
# Check chain alive
curl -X POST https://rpc.ledger.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}"

# Check balance
curl -X POST https://rpc.ledger.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"0x...\",\"latest\"],\"id\":1}"

# Get receipt
curl -X POST https://rpc.ledger.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionReceipt\",\"params\":[\"0x...\"],\"id\":1}"
```

---

## Getting Help

- **GitHub**: https://github.com/imronzuhri-svg/hara-registry
- **Email**: `ops@haratrust.io`
- **API Reference**: `doc/api/hara-registry-facts.md`
- **Explorer**: https://explorer.ledger.haratrust.io

**Welcome to Hara Registry.**

