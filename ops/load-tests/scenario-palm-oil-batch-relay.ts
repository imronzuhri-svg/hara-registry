#!/usr/bin/env -S npx tsx
// Scenario C (ERC-1155 palm-oil edition) — Batch relay: N custody hops in ONE transaction.
//
// Strategy:
//   Phase 1: derive N deterministic wallets
//   Phase 2a: prime each with 1 wei native HARA (pipelined, ~14s for 100)
//   Phase 2b: mint the batch to wallet[0]
//   Phase 2c: each wallet calls setApprovalForAll(relay, true)   <-- ONE-TIME cost
//             (100 parallel approves from different senders, all nonce=0, mine together)
//   Phase 3:  ONE call to relay.executeChain(token, batchId, amount, holders[])
//             emits N canonical TransferSingle events — same audit trail as Scenario A
//
// Why it works:
//   - All N transferFrom calls execute within a SINGLE tx, so Besu can't reorder them
//   - Each holder approved the relay separately, so the relay has authority to move tokens
//   - The audit trail (TransferSingle events) is identical to what sequential produces

import {
  createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi,
  keccak256, toHex, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HOPS = Number(process.argv[2] ?? 100);
const INITIAL_LITERS = BigInt(process.env.INITIAL_LITERS ?? 1000);
const TRANSFER_LITERS = BigInt(process.env.TRANSFER_LITERS ?? 900);
const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://rpc-write:8545";
const RPC_READ = process.env.RPC_READ_URL ?? "http://rpc-read-1:8545";
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const TOKEN = (process.env.TOKEN_ADDRESS ?? "0xa31f4c0ef2935af25370d9ae275169ccd9793da3") as Address;
const RELAY = (process.env.RELAY_ADDRESS ?? "0xf9c0bf1cfaab883adb95fed4cfd60133bffab18a") as Address;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const SEED = process.env.SEED ?? `hara-palm-relay-${Date.now()}`;
const BATCH_ID = BigInt(process.env.BATCH_ID ?? Date.now());

const ERC1155_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)",
]);
const RELAY_ABI = parseAbi([
  "function executeChain(address token, uint256 batchId, uint256 amount, address[] holders)",
]);

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const writeClient = createWalletClient({ account: deployer, transport: http(RPC_WRITE) });

function deriveWallet(i: number) {
  return privateKeyToAccount(keccak256(toHex(`${SEED}-${i}`)));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  PALM-OIL BATCH RELAY (ERC-1155) — ${HOPS} hops in 1 tx`);
  console.log(`  Batch:     ${BATCH_ID} (${INITIAL_LITERS}L → ${TRANSFER_LITERS}L/hop)`);
  console.log(`  Token:     ${TOKEN}`);
  console.log(`  Relay:     ${RELAY}`);
  console.log(`  Seed:      ${SEED}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const wallets = Array.from({ length: HOPS }, (_, i) => deriveWallet(i));
  const t0 = Date.now();

  // Phase 2a: prime native HARA
  console.log(`▶ Phase 2a: priming ${HOPS} wallets with 1 wei native HARA...`);
  let depNonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  const primeStart = Date.now();
  const primeRaws: Hex[] = [];
  for (let i = 0; i < HOPS; i++) {
    primeRaws.push(await deployer.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: depNonce + i,
      to: wallets[i].address, value: 1n, gasPrice: 0n, gas: 21_000n,
    }));
  }
  let lastHash: Hex = primeRaws[0];
  for (const raw of primeRaws) {
    lastHash = await writeClient.sendRawTransaction({ serializedTransaction: raw });
  }
  await publicClient.waitForTransactionReceipt({ hash: lastHash, timeout: 120_000 });
  depNonce += HOPS;
  console.log(`  ✔ primed in ${Date.now() - primeStart}ms`);

  // Phase 2b: mint batch to wallet[0] — only wallet[0..N-2] actually need to approve (last holder doesn't forward)
  console.log(`▶ Phase 2b: mintBatch(${BATCH_ID}, wallet[0], ${INITIAL_LITERS}L) ...`);
  const mintStart = Date.now();
  const mintData = encodeFunctionData({
    abi: ERC1155_ABI, functionName: "mintBatch",
    args: [BATCH_ID, wallets[0].address, INITIAL_LITERS,
      keccak256(toHex("rspo-cert-load-test")), keccak256(toHex("plantation-test")), BigInt(Math.floor(Date.now() / 1000))],
  });
  const rawMint = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce,
    to: TOKEN, data: mintData, value: 0n, gasPrice: 0n, gas: 200_000n,
  });
  const mintHash = await writeClient.sendRawTransaction({ serializedTransaction: rawMint });
  await publicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 60_000 });
  console.log(`  ✔ minted in ${Date.now() - mintStart}ms`);

  // Phase 2c: each holder approves the relay — ALL FIRED IN PARALLEL (different senders, each nonce 0)
  console.log(`▶ Phase 2c: ${HOPS - 1} holders setApprovalForAll(relay, true) ...`);
  const apprStart = Date.now();
  const apprRaws: { hash?: Hex; raw: Hex }[] = [];
  for (let i = 0; i < HOPS - 1; i++) {
    const w = wallets[i];
    const data = encodeFunctionData({
      abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [RELAY, true],
    });
    const raw = await w.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: 0,
      to: TOKEN, data, value: 0n, gasPrice: 0n, gas: 60_000n,
    });
    apprRaws.push({ raw });
  }
  // Submit with bounded concurrency to avoid overwhelming rpc-write's HTTP stack
  const CONCURRENCY = 10;
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= apprRaws.length) return;
      let attempt = 0;
      while (attempt < 3) {
        try {
          apprRaws[i].hash = await writeClient.sendRawTransaction({ serializedTransaction: apprRaws[i].raw });
          break;
        } catch (err: any) {
          attempt++;
          if (attempt >= 3) {
            console.error(`  approve ${i} failed after retries: ${err.shortMessage ?? err.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 200 * attempt));
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const submitted = apprRaws.filter((e) => e.hash).length;
  // Wait for the LAST submitted approve to confirm; the rest will already be mined
  const lastApprHash = apprRaws.filter((e) => e.hash).pop()?.hash;
  if (!lastApprHash) { console.error("✗ no approvals submitted"); process.exit(1); }
  await publicClient.waitForTransactionReceipt({ hash: lastApprHash, timeout: 180_000 });
  console.log(`  ✔ ${submitted}/${HOPS - 1} approvals confirmed in ${Date.now() - apprStart}ms`);

  // Phase 3: THE ONE TX
  console.log(`▶ Phase 3: relay.executeChain(${HOPS - 1} hops) — single tx...`);
  const chainStart = Date.now();
  const chainData = encodeFunctionData({
    abi: RELAY_ABI, functionName: "executeChain",
    args: [TOKEN, BATCH_ID, TRANSFER_LITERS, wallets.map((w) => w.address)],
  });
  // Gas: ~30K per hop with onERC1155Received check = 100 × 30K = 3M; buffer to 10M
  const gas = BigInt(Math.max(200_000, HOPS * 60_000));
  const rawChain = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce + 1,
    to: RELAY, data: chainData, value: 0n, gasPrice: 0n, gas,
  });
  const chainHash = await writeClient.sendRawTransaction({ serializedTransaction: rawChain });
  const chainReceipt = await publicClient.waitForTransactionReceipt({ hash: chainHash, timeout: 180_000 });
  const chainMs = Date.now() - chainStart;
  console.log(`  ✔ ${HOPS - 1} hops executed in ${chainMs}ms (block ${chainReceipt.blockNumber}, gas ${chainReceipt.gasUsed})`);

  // Verify
  const finalBalance = (await publicClient.readContract({
    address: TOKEN, abi: ERC1155_ABI, functionName: "balanceOf",
    args: [wallets[HOPS - 1].address, BATCH_ID],
  })) as bigint;
  const firstBalance = (await publicClient.readContract({
    address: TOKEN, abi: ERC1155_ABI, functionName: "balanceOf",
    args: [wallets[0].address, BATCH_ID],
  })) as bigint;
  const total = Date.now() - t0;

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RESULT — ${HOPS}-hop palm-oil chain (BATCH RELAY)`);
  console.log(`  wallet[0] (first):  ${firstBalance}L`);
  console.log(`  wallet[${HOPS - 1}] (final): ${finalBalance}L  ${finalBalance === TRANSFER_LITERS ? "✓" : "✗"}`);
  console.log(`  Single chain tx:    ${chainMs}ms`);
  console.log(`  Total wall time:    ${(total / 1000).toFixed(1)}s`);
  console.log(`  Hops/sec (in tx):   ${((HOPS - 1) / (chainMs / 1000)).toFixed(0)}`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(finalBalance === TRANSFER_LITERS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
