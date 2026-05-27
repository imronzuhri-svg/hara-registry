#!/usr/bin/env -S npx tsx
// scenario-stress-200x500.ts — stress test: 200 chains of 500 hops each.
//
// Total: 100,000 ERC-1155 TransferSingle events, in ~200 transactions.
//
// Strategy (key insight: REUSE wallets across chains):
//   Phase 1: derive 500 deterministic wallets (used by ALL 200 chains)
//   Phase 2a: prime 500 wallets with 1 wei native HARA (batched JSON-RPC)
//   Phase 2b: each wallet calls setApprovalForAll(relay, true)   (batched, parallel)
//
//   Phase 3: for each of 200 batchIds:
//     • mint INITIAL_LITERS to wallet[0] with that batchId
//     • executeChain(token, batchId, amount, holders[0..499]) — 499 hops in 1 tx
//
//   Phase 3 mint + executeChain pairs are submitted CONCURRENTLY using
//   the deployer's sequential nonces. Besu's QBFT orders them; blocks
//   fit many per block thanks to the huge gas limit (0x1fffffffffffff).
//
// Expected timing on a healthy 4-validator QBFT chain (2s blocks):
//   • Setup (priming + approvals): ~10-15 sec
//   • All 200 chains submit:        ~5-10 sec
//   • Block confirmation:           ~10-30 sec (depending on how Besu batches)
//   • TOTAL WALL CLOCK:             ~30-60 sec
//
// Gas budget: ~6.4M per chain × 200 = ~1.28B total. Free chain (gas price 0).
//
// Usage: ./scenario-stress-200x500.ts [CHAINS] [HOPS]
//   Defaults: 200 chains, 500 hops each.

import {
  createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi,
  keccak256, toHex, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAINS = Number(process.argv[2] ?? 200);
const HOPS = Number(process.argv[3] ?? 500);
const INITIAL_LITERS = BigInt(process.env.INITIAL_LITERS ?? 1000);
const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://localhost:8545/rpc/write";
const RPC_READ = process.env.RPC_READ_URL ?? "http://localhost:8545/rpc/read";
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const TOKEN = (process.env.TOKEN_ADDRESS ?? "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853") as Address;
const RELAY = (process.env.RELAY_ADDRESS ?? "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6") as Address;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const SEED = process.env.SEED ?? `stress-${Date.now()}`;
const BASE_BATCH_ID = BigInt(process.env.BASE_BATCH_ID ?? Date.now());

const ERC1155_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function mintBatch(uint256 batchId, address to, uint256 amount, bytes32 rspoHash, bytes32 plantationId, uint64 productionDate)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

const RELAY_ABI = parseAbi([
  "function executeChain(address token, uint256 batchId, uint256 amount, address[] holders) external",
]);

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const writeClient = createWalletClient({ account: deployer, transport: http(RPC_WRITE) });

// Derive HOPS deterministic wallets from the seed (reused across all chains)
const wallets = Array.from({ length: HOPS }, (_, i) =>
  privateKeyToAccount(keccak256(toHex(`${SEED}-w-${i}`)) as Hex),
);

async function batchSendRawTxs(url: string, txs: Hex[]): Promise<(Hex | Error)[]> {
  const body = txs.map((tx, i) => ({
    jsonrpc: "2.0", id: i,
    method: "eth_sendRawTransaction", params: [tx],
  }));
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const arr = await res.json() as any[];
  return arr.sort((a, b) => a.id - b.id).map(r => r.error ? new Error(r.error.message) : r.result as Hex);
}

(async () => {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  STRESS TEST — ${CHAINS} chains × ${HOPS} hops`);
  console.log(`  Total transfer events: ${CHAINS * (HOPS - 1)}`);
  console.log(`  Wallets reused: ${HOPS}`);
  console.log(`  Base batchId: ${BASE_BATCH_ID}`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  Relay: ${RELAY}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const startAll = Date.now();

  // ── Phase A — Prime wallets ──────────────────────────────────────────────
  console.log(`\n▶ A. Priming ${HOPS} wallets with 1 wei native HARA...`);
  let depNonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  const primeStart = Date.now();
  const primeRaws: Hex[] = [];
  for (let i = 0; i < HOPS; i++) {
    primeRaws.push(await deployer.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: depNonce + i,
      to: wallets[i].address, value: 1n, gasPrice: 0n, gas: 21_000n,
    }));
  }
  const primeResults = await batchSendRawTxs(RPC_WRITE, primeRaws);
  const lastPrime = primeResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastPrime, timeout: 180_000 });
  console.log(`  ✔ ${HOPS} primed in ${Date.now() - primeStart}ms`);
  depNonce += HOPS;

  // ── Phase B — Approve relay (each wallet nonce=0, parallel) ─────────────
  console.log(`\n▶ B. ${HOPS} senders setApprovalForAll(relay, true)...`);
  const apprStart = Date.now();
  const apprData = encodeFunctionData({ abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [RELAY, true] });
  const apprRaws: Hex[] = [];
  for (const w of wallets) {
    apprRaws.push(await w.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: 0,
      to: TOKEN, data: apprData, value: 0n, gasPrice: 0n, gas: 60_000n,
    }));
  }
  const apprResults = await batchSendRawTxs(RPC_WRITE, apprRaws);
  const lastAppr = apprResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastAppr, timeout: 240_000 });
  console.log(`  ✔ ${HOPS} approvals in ${Date.now() - apprStart}ms`);

  // ── Phase C — Submit all CHAINS mint+executeChain pairs concurrently ────
  console.log(`\n▶ C. ${CHAINS} chains: mint + executeChain(${HOPS - 1} hops)...`);
  const chainStart = Date.now();
  const holderAddrs = wallets.map(w => w.address);
  const allRaws: Hex[] = [];

  for (let c = 0; c < CHAINS; c++) {
    const batchId = BASE_BATCH_ID + BigInt(c);

    // Mint: deployer mints INITIAL_LITERS of batchId to wallet[0]
    const mintData = encodeFunctionData({
      abi: ERC1155_ABI, functionName: "mintBatch",
      args: [batchId, holderAddrs[0], INITIAL_LITERS,
        keccak256(toHex(`rspo-${SEED}-${c}`)),
        keccak256(toHex(`plantation-stress-${c}`)),
        BigInt(Math.floor(Date.now() / 1000))],
    });
    allRaws.push(await deployer.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: depNonce++,
      to: TOKEN, data: mintData, value: 0n, gasPrice: 0n, gas: 250_000n,
    }));

    // executeChain: deployer calls relay to move INITIAL_LITERS through holders[]
    const chainData = encodeFunctionData({
      abi: RELAY_ABI, functionName: "executeChain",
      args: [TOKEN, batchId, INITIAL_LITERS, holderAddrs],
    });
    allRaws.push(await deployer.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: depNonce++,
      to: RELAY, data: chainData, value: 0n, gasPrice: 0n,
      gas: 30_000_000n,    // generous — each hop ~15k, 500 hops ~7.5M, +overhead
    }));
  }
  console.log(`  Signed ${allRaws.length} txs in ${Date.now() - chainStart}ms`);

  const submitStart = Date.now();
  const chainResults = await batchSendRawTxs(RPC_WRITE, allRaws);
  const errors = chainResults.filter((r): r is Error => r instanceof Error);
  if (errors.length) {
    console.error(`  ⚠ ${errors.length} txs failed at submit:`);
    errors.slice(0, 5).forEach(e => console.error(`    ${e.message}`));
  }
  const successHashes = chainResults.filter((r): r is Hex => !(r instanceof Error));
  console.log(`  Submitted ${successHashes.length}/${allRaws.length} in ${Date.now() - submitStart}ms`);

  // Wait for the LAST executeChain receipt (highest nonce)
  const lastExec = successHashes[successHashes.length - 1];
  console.log(`  Waiting for last receipt (${lastExec.slice(0, 10)}…)…`);
  const lastReceipt = await publicClient.waitForTransactionReceipt({ hash: lastExec, timeout: 600_000 });
  const chainEnd = Date.now();
  console.log(`  ✔ All chains mined by block ${lastReceipt.blockNumber}, gas ${lastReceipt.gasUsed} (last tx)`);

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalElapsed = Date.now() - startAll;
  const totalTransfers = CHAINS * (HOPS - 1);

  // Sum gas across all executeChain receipts (every other tx)
  let totalGas = 0n;
  const sampleN = Math.min(20, successHashes.length);
  console.log(`\n▶ Fetching gas from first ${sampleN} sample receipts...`);
  for (let i = 0; i < sampleN; i++) {
    const r = await publicClient.getTransactionReceipt({ hash: successHashes[i] });
    totalGas += r.gasUsed;
  }
  const avgGasPerTx = totalGas / BigInt(sampleN);
  const estTotalGas = avgGasPerTx * BigInt(successHashes.length);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  STRESS TEST COMPLETE`);
  console.log(`  Chains:           ${CHAINS}`);
  console.log(`  Hops per chain:   ${HOPS} (${HOPS - 1} transfer events each)`);
  console.log(`  Total transfers:  ${totalTransfers}`);
  console.log(`  Wall clock:       ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log(`  Effective TPS:    ${(totalTransfers / (totalElapsed / 1000)).toFixed(0)} transfers/s`);
  console.log(`  Avg gas/tx:       ${avgGasPerTx}`);
  console.log(`  Est. total gas:   ${estTotalGas} (~${Number(estTotalGas) / 1e9}B)`);
  console.log(`  Last block:       ${lastReceipt.blockNumber}`);
  console.log(`  Base batchId:     ${BASE_BATCH_ID}  (chains: ${BASE_BATCH_ID}..${BASE_BATCH_ID + BigInt(CHAINS) - 1n})`);
  console.log("═══════════════════════════════════════════════════════════════");
})().catch(e => { console.error(e); process.exit(1); });
