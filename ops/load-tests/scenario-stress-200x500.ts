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
  "function isApprovedForAll(address account, address operator) view returns (bool)",
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

// Chunked submit: sends txs in groups of CHUNK_SIZE and waits for each chunk's
// last receipt before moving on. Avoids Besu's broadcast rate-limit piling up
// hundreds of pending txs from different senders (each with nonce=0) which
// causes long propagation delays. Found 2026-05-27 when 500-wallet approval
// phase stuck at 300 pending for >60s.
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 50);

async function batchSendChunked(
  url: string,
  publicClient: ReturnType<typeof createPublicClient>,
  txs: Hex[],
  label: string,
  opts: { waitBetweenChunks?: boolean; receiptTimeoutMs?: number; chunkSize?: number } = {},
): Promise<Hex[]> {
  const waitBetween = opts.waitBetweenChunks ?? true;
  const receiptTimeout = opts.receiptTimeoutMs ?? 180_000;
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const allHashes: Hex[] = [];
  const totalChunks = Math.ceil(txs.length / chunkSize);
  for (let c = 0; c < totalChunks; c++) {
    const chunk = txs.slice(c * chunkSize, (c + 1) * chunkSize);
    const t0 = Date.now();
    const results = await batchSendRawTxs(url, chunk);
    const errors = results.filter((r): r is Error => r instanceof Error);
    if (errors.length) {
      console.warn(`    chunk ${c + 1}/${totalChunks}: ${errors.length} errors:`, errors.slice(0, 2).map(e => e.message));
    }
    const hashes = results.filter((r): r is Hex => !(r instanceof Error));
    allHashes.push(...hashes);
    if (waitBetween) {
      const lastHash = hashes[hashes.length - 1];
      if (lastHash) {
        await publicClient.waitForTransactionReceipt({ hash: lastHash, timeout: receiptTimeout });
      }
      process.stderr.write(`    ${label} chunk ${c + 1}/${totalChunks} (${chunk.length} txs) confirmed in ${Date.now() - t0}ms\n`);
    } else {
      process.stderr.write(`    ${label} chunk ${c + 1}/${totalChunks} (${chunk.length} txs) submitted in ${Date.now() - t0}ms\n`);
    }
  }
  if (!waitBetween && allHashes.length) {
    const finalT0 = Date.now();
    const lastHash = allHashes[allHashes.length - 1];
    process.stderr.write(`    ${label}: waiting for final receipt (${lastHash.slice(0, 10)}...)\n`);
    await publicClient.waitForTransactionReceipt({ hash: lastHash, timeout: receiptTimeout });
    process.stderr.write(`    ${label} all ${allHashes.length} txs final receipt in ${Date.now() - finalT0}ms\n`);
  }
  return allHashes;
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

  // ── Phase A — Prime wallets (chunked + verified) ─────────────────────────
  // Priming materializes each wallet's account in world state. If any wallet
  // is missed, Phase B's approval tx for that sender becomes a permanent zombie
  // — SenderBalanceChecker throws on the missing account and the validator
  // pool keeps the tx forever, blocking the chain until all 4 validators are
  // simultaneously restarted. See validator-pool-zombies (memory) / 2026-05-27.
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
  await batchSendChunked(RPC_WRITE, publicClient, primeRaws, "prime");
  depNonce += HOPS;

  process.stderr.write(`  verifying ${HOPS} wallet balances...\n`);
  const unfunded: number[] = [];
  for (let i = 0; i < HOPS; i++) {
    const bal = await publicClient.getBalance({ address: wallets[i].address });
    if (bal < 1n) unfunded.push(i);
  }
  if (unfunded.length) {
    throw new Error(
      `Phase A incomplete: ${unfunded.length}/${HOPS} wallets unfunded ` +
      `(indices ${unfunded.slice(0, 10).join(",")}${unfunded.length > 10 ? "..." : ""}). ` +
      `Abort before Phase B to avoid creating validator pool zombies.`,
    );
  }
  console.log(`  ✔ ${HOPS} primed and verified in ${Date.now() - primeStart}ms`);

  // ── Phase B — Approve relay (each wallet nonce=0, parallel + verified) ──
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
  await batchSendChunked(RPC_WRITE, publicClient, apprRaws, "approvals");

  process.stderr.write(`  verifying ${HOPS} approvals...\n`);
  const notApproved: number[] = [];
  for (let i = 0; i < HOPS; i++) {
    const ok = await publicClient.readContract({
      address: TOKEN, abi: ERC1155_ABI, functionName: "isApprovedForAll",
      args: [wallets[i].address, RELAY],
    });
    if (!ok) notApproved.push(i);
  }
  if (notApproved.length) {
    throw new Error(
      `Phase B incomplete: ${notApproved.length}/${HOPS} approvals missing ` +
      `(indices ${notApproved.slice(0, 10).join(",")}${notApproved.length > 10 ? "..." : ""}). ` +
      `Phase C would revert mid-chain — fix before retrying.`,
    );
  }
  console.log(`  ✔ ${HOPS} approvals confirmed in ${Date.now() - apprStart}ms`);

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

  // Phase C uses chunks of 25 with per-chunk receipt wait. Heavy executeChain txs
  // (250+ hops) hit a per-sender ~200-deep wall in Besu's pool when submitted en
  // masse — pool maintenance can't validate them all and the higher-nonce txs get
  // silently dropped. Keeping pool depth <200 from any one sender at all times
  // works around this. Confirmed during 2026-05-27 investigation.
  const submitStart = Date.now();
  const successHashes = await batchSendChunked(RPC_WRITE, publicClient, allRaws, "chains", {
    waitBetweenChunks: true,
    chunkSize: 25,
    receiptTimeoutMs: 600_000,
  });
  if (successHashes.length !== allRaws.length) {
    throw new Error(`Phase C: only ${successHashes.length}/${allRaws.length} txs accepted at submission`);
  }
  console.log(`  ✔ All ${successHashes.length}/${allRaws.length} txs confirmed in ${Date.now() - submitStart}ms`);

  // Get the LAST executeChain receipt for block info
  const lastExec = successHashes[successHashes.length - 1];
  const lastReceipt = await publicClient.getTransactionReceipt({ hash: lastExec });
  console.log(`  Last tx in block ${lastReceipt.blockNumber}, gas ${lastReceipt.gasUsed}`);

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
