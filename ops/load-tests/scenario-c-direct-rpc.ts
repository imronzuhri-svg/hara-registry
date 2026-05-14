#!/usr/bin/env -S npx tsx
// Scenario C — Pre-signed batch, flooded directly to /rpc/write.
//
// Bypasses the signer service entirely. Pre-signs N transfer txs offline with viem
// (~10s for 10K), then submits them all via eth_sendRawTransaction with controlled
// concurrency, then polls for the final receipt to confirm full inclusion.
//
// Usage:  ./scenario-c-direct-rpc.ts [COUNT]   (default 100)
//
// What this tests:
//   - Maximum chain throughput (Besu mempool capacity, QBFT block production rate)
//   - Establishes upper bound that A/B scenarios can never beat
//
// Requires Node 20+. tsx + viem installed in services/shared (workspace).

import { createPublicClient, createWalletClient, http, keccak256, parseAbi, encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const COUNT = Number(process.argv[2] ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://localhost:8545/rpc/write";
const RPC_READ = process.env.RPC_READ_URL ?? "http://localhost:8545/rpc/read";
const PRIVATE_KEY = (process.env.PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const TOKEN = (process.env.TOKEN_ADDRESS ?? "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0") as `0x${string}`;
const RECIPIENT = (process.env.RECIPIENT_ADDRESS ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8") as `0x${string}`;

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const walletClient = createWalletClient({ account, transport: http(RPC_WRITE) });

const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Scenario C — Pre-signed batch, ${COUNT} transfers`);
  console.log(`  Sender:    ${account.address}`);
  console.log(`  Token:     ${TOKEN}`);
  console.log(`  Recipient: ${RECIPIENT}`);
  console.log(`  Write RPC: ${RPC_WRITE}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Phase 1: pre-sign all transactions offline ─────────────────────────
  const startNonce = Number(await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }));
  console.log(`▶ Phase 1: pre-signing ${COUNT} txs starting at nonce ${startNonce}...`);
  const t0 = Date.now();

  const data = encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: "transfer",
    args: [RECIPIENT, 10n ** 18n],
  });

  const signed: Hex[] = [];
  for (let i = 0; i < COUNT; i++) {
    const raw = await account.signTransaction({
      type: "legacy",
      chainId: CHAIN_ID,
      nonce: startNonce + i,
      to: TOKEN,
      data,
      value: 0n,
      gasPrice: 0n,
      gas: 100_000n,
    });
    signed.push(raw);
  }
  const signMs = Date.now() - t0;
  console.log(`  ✔ Signed ${COUNT} txs in ${signMs}ms`);

  // ── Phase 2: flood to /rpc/write with bounded concurrency ──────────────
  console.log(`▶ Phase 2: submitting via eth_sendRawTransaction (concurrency=${CONCURRENCY})...`);
  const t1 = Date.now();
  const hashes: Hex[] = [];
  let inFlight = 0;
  let nextIndex = 0;
  let submitted = 0;
  let submitErrors = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= COUNT) return;
      try {
        const h = await walletClient.sendRawTransaction({ serializedTransaction: signed[i] });
        hashes[i] = h;
        submitted++;
      } catch (e: any) {
        submitErrors++;
        if (submitErrors <= 5) console.warn(`  submit err [${i}]: ${e.shortMessage ?? e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const submitMs = Date.now() - t1;
  console.log(`  ✔ Submitted ${submitted} / ${COUNT} in ${submitMs}ms (${submitErrors} submit errors)`);

  // ── Phase 3: wait for last tx to confirm ───────────────────────────────
  console.log(`▶ Phase 3: waiting for inclusion (polling last hash)...`);
  const lastHash = hashes[hashes.length - 1] ?? hashes.filter(Boolean).pop();
  if (!lastHash) {
    console.error("✗ No txs were submitted successfully");
    process.exit(1);
  }

  const t2 = Date.now();
  let lastReceipt;
  while (Date.now() - t2 < 120_000) {
    try {
      lastReceipt = await publicClient.getTransactionReceipt({ hash: lastHash });
      if (lastReceipt) break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!lastReceipt) {
    console.error("✗ Last tx never confirmed within 2 min");
    process.exit(1);
  }

  const totalMs = Date.now() - t0;
  const includedMs = Date.now() - t1;
  const tps = (submitted / (includedMs / 1000)).toFixed(2);

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  DONE`);
  console.log(`  Pre-sign:        ${signMs}ms`);
  console.log(`  Submit:          ${submitMs}ms  (${(submitted / (submitMs / 1000)).toFixed(2)} POST/s)`);
  console.log(`  Until inclusion: ${includedMs}ms`);
  console.log(`  Last tx in block ${lastReceipt.blockNumber}, gas used ${lastReceipt.gasUsed}`);
  console.log(`  Total elapsed:   ${totalMs}ms`);
  console.log(`  Effective rate:  ${tps} tx/s (mempool → mined)`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
