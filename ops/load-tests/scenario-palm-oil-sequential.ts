#!/usr/bin/env -S npx tsx
// Scenario A (ERC-1155 palm-oil edition) — Sequential custody chain with real safeTransferFrom.
//
// Models RSPO Segregated palm-oil custody: a batch of N liters moves through N custodians,
// each safeTransferFrom emits a canonical TransferSingle event (the audit trail).
//
// Strategy:
//   Phase 1: derive N deterministic wallets
//   Phase 2a: prime each with 1 wei native HARA (Besu block-selector requirement)
//   Phase 2b: mint the batch to wallet[0] with RSPO metadata
//   Phase 3: for each hop i=0..N-2, call safeTransferFrom from wallet[i] to wallet[i+1],
//            WAIT FOR RECEIPT, then proceed. This is the safe but slow pattern.
//
// Usage: ./scenario-palm-oil-sequential.ts [HOPS]   (default 100)

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
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const SEED = process.env.SEED ?? `hara-palm-seq-${Date.now()}`;
const BATCH_ID = BigInt(process.env.BATCH_ID ?? Date.now()); // ERC-1155 token id

const ERC1155_ABI = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)",
]);

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const writeClient = createWalletClient({ account: deployer, transport: http(RPC_WRITE) });

function deriveWallet(i: number) {
  return privateKeyToAccount(keccak256(toHex(`${SEED}-${i}`)));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  PALM-OIL SEQUENTIAL (ERC-1155) — ${HOPS} hops`);
  console.log(`  Batch:     ${BATCH_ID} (${INITIAL_LITERS}L → ${TRANSFER_LITERS}L/hop)`);
  console.log(`  Token:     ${TOKEN}`);
  console.log(`  Seed:      ${SEED}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const wallets = Array.from({ length: HOPS }, (_, i) => deriveWallet(i));
  const t0 = Date.now();

  // Phase 2a: prime native HARA — pipelined sequential nonces from the deployer
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
  let lastPrimeHash: Hex = primeRaws[0];
  for (const raw of primeRaws) {
    lastPrimeHash = await writeClient.sendRawTransaction({ serializedTransaction: raw });
  }
  await publicClient.waitForTransactionReceipt({ hash: lastPrimeHash, timeout: 120_000 });
  depNonce += HOPS;
  console.log(`  ✔ ${HOPS} primings in ${Date.now() - primeStart}ms`);

  // Phase 2b: mint the batch to wallet[0]
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

  // Phase 3: sequential hops with receipt-wait
  console.log(`▶ Phase 3: ${HOPS - 1} sequential safeTransferFrom hops...`);
  const hopsStart = Date.now();
  let hopMsSum = 0;
  for (let i = 0; i < HOPS - 1; i++) {
    const tHop = Date.now();
    const w = wallets[i];
    const wClient = createWalletClient({ account: w, transport: http(RPC_WRITE) });
    const data = encodeFunctionData({
      abi: ERC1155_ABI, functionName: "safeTransferFrom",
      args: [w.address, wallets[i + 1].address, BATCH_ID, TRANSFER_LITERS, "0x"],
    });
    const raw = await w.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: 0,
      to: TOKEN, data, value: 0n, gasPrice: 0n, gas: 200_000n,
    });
    const h = await wClient.sendRawTransaction({ serializedTransaction: raw });
    const r = await publicClient.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
    if (r.status !== "success") { console.error(`✗ hop ${i} reverted at block ${r.blockNumber}`); break; }
    hopMsSum += Date.now() - tHop;
    if ((i + 1) % 10 === 0 || i === HOPS - 2) {
      process.stdout.write(`\r  ${i + 1}/${HOPS - 1} hops (~${Math.round(hopMsSum / (i + 1))}ms/hop avg)`);
    }
  }
  process.stdout.write("\n");
  const hopsMs = Date.now() - hopsStart;

  // Verify
  const finalBalance = (await publicClient.readContract({
    address: TOKEN, abi: ERC1155_ABI, functionName: "balanceOf",
    args: [wallets[HOPS - 1].address, BATCH_ID],
  })) as bigint;
  const total = Date.now() - t0;
  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RESULT — ${HOPS}-hop palm-oil chain (SEQUENTIAL)`);
  console.log(`  Final custodian liters: ${finalBalance}  ${finalBalance === TRANSFER_LITERS ? "✓" : "✗"}`);
  console.log(`  Hops phase:             ${(hopsMs / 1000).toFixed(1)}s  (${Math.round(hopMsSum / (HOPS - 1))}ms/hop)`);
  console.log(`  Total wall time:        ${(total / 1000).toFixed(1)}s`);
  console.log(`  Hops/sec:               ${((HOPS - 1) / (total / 1000)).toFixed(2)}`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(finalBalance === TRANSFER_LITERS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
