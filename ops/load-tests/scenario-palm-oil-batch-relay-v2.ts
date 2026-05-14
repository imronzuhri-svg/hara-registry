#!/usr/bin/env -S npx tsx
// Scenario C v2 — Same as batch-relay, but uses JSON-RPC batching for the approval
// phase: 99 setApprovalForAll calls go in ONE HTTP POST instead of 99 POSTs.
//
// Demonstrates how to fully parallelize without throttling, by leveraging:
//   1. Besu's --rpc-http-max-active-connections=2000 (raised from 80)
//   2. Besu's --rpc-http-max-batch-size=2048
//   3. JSON-RPC 2.0 batching at the client side

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
const SEED = process.env.SEED ?? `hara-palm-relay-v2-${Date.now()}`;
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

/**
 * Submit N signed transactions in ONE HTTP POST via JSON-RPC batching.
 * Returns either the tx hash or an Error per submission, in the same order as input.
 */
async function batchSendRawTxs(rpcUrl: string, signedTxs: Hex[]): Promise<(Hex | Error)[]> {
  const body = signedTxs.map((raw, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_sendRawTransaction",
    params: [raw],
  }));
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const results = (await res.json()) as Array<{ id: number; result?: Hex; error?: { message: string } }>;
  // Besu may return out-of-order — sort by id
  results.sort((a, b) => a.id - b.id);
  return results.map((r) => (r.error ? new Error(r.error.message) : r.result!));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  PALM-OIL BATCH RELAY v2 (JSON-RPC batched) — ${HOPS} hops`);
  console.log(`  Batch:     ${BATCH_ID}`);
  console.log(`  Seed:      ${SEED}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const wallets = Array.from({ length: HOPS }, (_, i) => deriveWallet(i));
  const t0 = Date.now();

  // Phase 2a: prime native HARA — also batch this!
  console.log(`▶ Phase 2a: priming ${HOPS} wallets (batched JSON-RPC) ...`);
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
  const primeSubmitMs = Date.now() - primeStart;
  const primeFailed = primeResults.filter((r) => r instanceof Error).length;
  // Wait for the last priming to confirm
  const lastPrimeHash = primeResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastPrimeHash, timeout: 120_000 });
  console.log(`  ✔ ${HOPS - primeFailed}/${HOPS} primed (submit ${primeSubmitMs}ms, total ${Date.now() - primeStart}ms)`);
  depNonce += HOPS;

  // Phase 2b: mintBatch
  console.log(`▶ Phase 2b: mintBatch(...)`);
  const mintStart = Date.now();
  const mintData = encodeFunctionData({
    abi: ERC1155_ABI, functionName: "mintBatch",
    args: [BATCH_ID, wallets[0].address, INITIAL_LITERS,
      keccak256(toHex("rspo-cert-load-test-v2")), keccak256(toHex("plantation-test-v2")),
      BigInt(Math.floor(Date.now() / 1000))],
  });
  const rawMint = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce,
    to: TOKEN, data: mintData, value: 0n, gasPrice: 0n, gas: 200_000n,
  });
  const mintHash = await writeClient.sendRawTransaction({ serializedTransaction: rawMint });
  await publicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 60_000 });
  console.log(`  ✔ minted in ${Date.now() - mintStart}ms`);

  // Phase 2c: ALL approvals in ONE HTTP POST
  console.log(`▶ Phase 2c: ${HOPS - 1} approvals (JSON-RPC batched, single POST) ...`);
  const apprStart = Date.now();
  const apprRaws: Hex[] = [];
  for (let i = 0; i < HOPS - 1; i++) {
    const data = encodeFunctionData({
      abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [RELAY, true],
    });
    apprRaws.push(await wallets[i].signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: 0,
      to: TOKEN, data, value: 0n, gasPrice: 0n, gas: 60_000n,
    }));
  }
  const apprResults = await batchSendRawTxs(RPC_WRITE, apprRaws);
  const apprSubmitMs = Date.now() - apprStart;
  const apprFailed = apprResults.filter((r) => r instanceof Error).length;
  const lastApprHash = apprResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastApprHash, timeout: 180_000 });
  console.log(`  ✔ ${HOPS - 1 - apprFailed}/${HOPS - 1} approvals (submit ${apprSubmitMs}ms, total ${Date.now() - apprStart}ms)`);

  // Phase 3: the one chain tx
  console.log(`▶ Phase 3: relay.executeChain(${HOPS - 1} hops)`);
  const chainStart = Date.now();
  const chainData = encodeFunctionData({
    abi: RELAY_ABI, functionName: "executeChain",
    args: [TOKEN, BATCH_ID, TRANSFER_LITERS, wallets.map((w) => w.address)],
  });
  const gas = BigInt(Math.max(200_000, HOPS * 60_000));
  const rawChain = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce + 1,
    to: RELAY, data: chainData, value: 0n, gasPrice: 0n, gas,
  });
  const chainHash = await writeClient.sendRawTransaction({ serializedTransaction: rawChain });
  const r = await publicClient.waitForTransactionReceipt({ hash: chainHash, timeout: 180_000 });
  const chainMs = Date.now() - chainStart;
  console.log(`  ✔ executed in ${chainMs}ms (block ${r.blockNumber}, gas ${r.gasUsed})`);

  const finalBalance = (await publicClient.readContract({
    address: TOKEN, abi: ERC1155_ABI, functionName: "balanceOf",
    args: [wallets[HOPS - 1].address, BATCH_ID],
  })) as bigint;
  const total = Date.now() - t0;

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RESULT — ${HOPS}-hop chain (BATCH RELAY v2, JSON-RPC batched)`);
  console.log(`  Final wallet[${HOPS - 1}]: ${finalBalance}L  ${finalBalance === TRANSFER_LITERS ? "✓" : "✗"}`);
  console.log(`  Total wall time:    ${(total / 1000).toFixed(1)}s`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(finalBalance === TRANSFER_LITERS ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
