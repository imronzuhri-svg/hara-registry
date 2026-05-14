#!/usr/bin/env -S npx tsx
// Scenario — Traceability chain transfer
//
// Models a halal-supply-chain hand-off: tokens move through N successive holders,
// each receiving from the previous and forwarding to the next.
//
//   A (1000 tokens) → B (900) → C (900) → D (900) → ... → Z
//
// The ordering is a HARD constraint: wallet i+1 cannot transfer until wallet i has
// received tokens. So this can't be parallelized across the chain.
//
// To minimize wall-clock time, we exploit:
//   1. Each intermediate wallet only ever does ONE outbound tx (nonce 0 always)
//   2. Besu's QBFT mines txs in the same block in MEMPOOL ARRIVAL ORDER when gas
//      prices are equal (we use gasPrice=0 — free gas chain)
//   3. Within a block, Besu's executor applies txs in order, so by the time it
//      evaluates wallet[i+1]'s tx, wallet[i+1] already has the tokens from
//      wallet[i]'s tx earlier in the same block
//
// Strategy:
//   Phase 1: derive N wallets deterministically
//   Phase 2: deployer sends INITIAL_AMOUNT tokens to wallet[0]  (1 tx, wait)
//   Phase 3: pre-sign N-1 transfer ops offline (~5ms each)
//   Phase 4: submit them to /rpc/write IN ORDER (don't wait for receipts)
//   Phase 5: wait for the LAST tx's receipt only — all the rest are mined by then
//   Phase 6: verify the final wallet has the expected balance
//
// Why this is the fastest possible:
//   - Pre-signing avoids any per-tx round-trip to a remote signer (~10ms each saved)
//   - Submitting all at once means Besu sees the full chain in its mempool in <1s
//   - All N-1 transfers can land in 1 block if block gas allows. Our block gas
//     limit is 0x1fffffffffffff — ~250 ERC-20 transfers per block is the realistic
//     ceiling with current Besu config, so 100 fits trivially. 10K = ~40 blocks =
//     ~80 seconds of mining.
//
// Usage: ./scenario-traceability.ts [HOPS]   (default 100, e.g. 10000 for full run)

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  keccak256,
  toHex,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HOPS = Number(process.argv[2] ?? 100);
const INITIAL_AMOUNT = BigInt(process.env.INITIAL_AMOUNT ?? 1000) * 10n ** 18n;
const TRANSFER_AMOUNT = BigInt(process.env.TRANSFER_AMOUNT ?? 900) * 10n ** 18n;
const SUBMIT_CONCURRENCY = Number(process.env.SUBMIT_CONCURRENCY ?? 1); // 1 = strict order
const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://localhost:8545/rpc/write";
const RPC_READ = process.env.RPC_READ_URL ?? "http://localhost:8545/rpc/read";
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const TOKEN = (process.env.TOKEN_ADDRESS ?? "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0") as Address;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const SEED = process.env.SEED ?? "hara-trace";

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const writeClient = createWalletClient({ account: deployer, transport: http(RPC_WRITE) });

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

function deriveWallet(index: number) {
  const pk = keccak256(toHex(`${SEED}-${index}`));
  return privateKeyToAccount(pk);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Traceability chain — ${HOPS} hops`);
  console.log(`  Initial:  ${INITIAL_AMOUNT / 10n ** 18n} HTST to wallet[0]`);
  console.log(`  Each hop: ${TRANSFER_AMOUNT / 10n ** 18n} HTST forwarded`);
  console.log(`  Token:    ${TOKEN}`);
  console.log(`  Chain ID: ${CHAIN_ID}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Phase 1: derive wallets ────────────────────────────────────────────
  const t0 = Date.now();
  console.log(`▶ Phase 1: deriving ${HOPS} wallets...`);
  const wallets = Array.from({ length: HOPS }, (_, i) => deriveWallet(i));
  console.log(`  wallet[0]   = ${wallets[0].address}`);
  console.log(`  wallet[${HOPS - 1}] = ${wallets[HOPS - 1].address}`);
  console.log(`  ✔ ${Date.now() - t0}ms`);

  // ── Phase 2a: prime every hop wallet with 1 wei native HARA ────────────
  // Besu's block-selector excludes txs from senders with 0 native balance
  // even when gasPrice=0. We give each hop wallet a single wei so the selector
  // accepts them at block-build time. All txs share the deployer's sender with
  // sequential nonces, so they all mine within 1–2 blocks.
  console.log(`▶ Phase 2a: priming ${HOPS} wallets with 1 wei native HARA each...`);
  const t1a = Date.now();
  let depNonce = await publicClient.getTransactionCount({
    address: deployer.address,
    blockTag: "pending",
  });
  const primeTxs: Hex[] = [];
  for (let i = 0; i < HOPS; i++) {
    const raw = await deployer.signTransaction({
      type: "legacy",
      chainId: CHAIN_ID,
      nonce: depNonce + i,
      to: wallets[i].address,
      value: 1n,
      gasPrice: 0n,
      gas: 21_000n,
    });
    primeTxs.push(raw);
  }
  // Submit all priming txs in order
  let lastPrimeHash: Hex = primeTxs[0];
  for (const raw of primeTxs) {
    lastPrimeHash = await writeClient.sendRawTransaction({ serializedTransaction: raw });
  }
  await publicClient.waitForTransactionReceipt({ hash: lastPrimeHash, timeout: 120_000 });
  console.log(`  ✔ ${HOPS} primings landed in ${Date.now() - t1a}ms`);
  depNonce += HOPS;

  // ── Phase 2b: deployer sends INITIAL_AMOUNT tokens to wallet[0] ───────
  console.log(`▶ Phase 2b: deployer → wallet[0] (${INITIAL_AMOUNT / 10n ** 18n} HTST)...`);
  const t1 = Date.now();
  const fundingTx = await deployer.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce: depNonce,
    to: TOKEN,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [wallets[0].address, INITIAL_AMOUNT],
    }),
    value: 0n,
    gasPrice: 0n,
    gas: 100_000n,
  });
  const fundingHash = await writeClient.sendRawTransaction({ serializedTransaction: fundingTx });
  await publicClient.waitForTransactionReceipt({ hash: fundingHash });
  console.log(`  ✔ funded in ${Date.now() - t1}ms`);

  // ── Phase 3: pre-sign the chain ────────────────────────────────────────
  console.log(`▶ Phase 3: pre-signing ${HOPS - 1} transfer ops...`);
  const t2 = Date.now();
  const signedChain: Hex[] = [];
  for (let i = 0; i < HOPS - 1; i++) {
    const from = wallets[i];
    const to = wallets[i + 1].address;
    const raw = await from.signTransaction({
      type: "legacy",
      chainId: CHAIN_ID,
      nonce: 0, // each intermediate wallet has only ONE outbound tx
      to: TOKEN,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, TRANSFER_AMOUNT],
      }),
      value: 0n,
      gasPrice: 0n,
      gas: 100_000n,
    });
    signedChain.push(raw);
  }
  console.log(`  ✔ ${HOPS - 1} txs signed in ${Date.now() - t2}ms (${((Date.now() - t2) / (HOPS - 1)).toFixed(2)}ms/tx)`);

  // ── Phase 4: submit each hop and wait for its receipt before the next ──
  // Necessary because Besu's QBFT block builder does NOT preserve mempool insertion
  // order strictly enough for chain-dependent txs (we tested: pre-signed flood mode
  // ends up with ~98% revert rate due to intra-block reordering). For chained
  // traceability, sequential-with-receipt is the only safe pattern on Besu QBFT
  // without changing the consensus client.
  //
  // Optimization path (not implemented here, see README):
  //   - Use a BatchTransferRelay contract to do N transfers in 1 tx (atomic, 1 block)
  //   - Or EIP-2612 Permit signatures + relayer
  console.log(`▶ Phase 4: submitting + confirming each hop sequentially...`);
  const t3 = Date.now();
  const submittedHashes: Hex[] = [];
  let lastReceiptMs = 0;
  for (let i = 0; i < signedChain.length; i++) {
    const tHop = Date.now();
    try {
      const h = await writeClient.sendRawTransaction({ serializedTransaction: signedChain[i] });
      submittedHashes.push(h);
      const r = await publicClient.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
      if (r.status !== "success") {
        console.error(`\n  hop ${i} reverted at block ${r.blockNumber}`);
        break;
      }
      lastReceiptMs = Date.now() - tHop;
    } catch (e: any) {
      console.error(`\n  hop ${i} failed: ${e.shortMessage ?? e.message}`);
      break;
    }
    if ((i + 1) % 10 === 0 || i === signedChain.length - 1) {
      process.stdout.write(`\r  confirmed ${i + 1}/${signedChain.length} (~${lastReceiptMs}ms/hop)`);
    }
  }
  process.stdout.write("\n");
  const submitMs = Date.now() - t3;
  console.log(`  ✔ ${submittedHashes.length} hops confirmed in ${submitMs}ms`);

  // ── Phase 5: wait for the LAST hop's receipt ───────────────────────────
  console.log(`▶ Phase 5: waiting for final hop to mine...`);
  const t4 = Date.now();
  const lastHash = submittedHashes[submittedHashes.length - 1];
  if (!lastHash) {
    console.error("✗ Last tx was not submitted; cannot verify");
    process.exit(1);
  }
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: lastHash,
    timeout: 180_000,
  });
  const mineMs = Date.now() - t4;

  // ── Phase 6: verify final balance ──────────────────────────────────────
  console.log(`▶ Phase 6: verifying wallet[${HOPS - 1}] balance...`);
  const balance = (await publicClient.readContract({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallets[HOPS - 1].address],
  })) as bigint;
  const expected = TRANSFER_AMOUNT;
  const ok = balance === expected;
  console.log(`  wallet[${HOPS - 1}] balance = ${balance / 10n ** 18n} HTST  ${ok ? "✓" : `✗ expected ${expected / 10n ** 18n}`}`);

  // ── Summary ────────────────────────────────────────────────────────────
  const total = Date.now() - t0;
  const firstHashReceipt = submittedHashes[0]
    ? await publicClient.getTransactionReceipt({ hash: submittedHashes[0] }).catch(() => null)
    : null;
  const blockSpan =
    firstHashReceipt && receipt
      ? `${firstHashReceipt.blockNumber} → ${receipt.blockNumber} (${Number(receipt.blockNumber - firstHashReceipt.blockNumber) + 1} blocks)`
      : "n/a";

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  DONE — ${HOPS}-hop traceability chain`);
  console.log(`  Pre-sign:        ${Date.now() - t2 - submitMs - mineMs}ms`);
  console.log(`  Submit:          ${submitMs}ms`);
  console.log(`  Last-tx mine:    ${mineMs}ms`);
  console.log(`  Block range:     ${blockSpan}`);
  console.log(`  Total wall time: ${total}ms (${(total / 1000).toFixed(1)}s)`);
  console.log(`  Hops/second:     ${((HOPS - 1) / (total / 1000)).toFixed(1)}`);
  console.log(`  Final balance:   ${balance / 10n ** 18n} HTST  ${ok ? "✓" : "✗"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
