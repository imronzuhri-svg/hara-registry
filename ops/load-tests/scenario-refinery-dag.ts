#!/usr/bin/env -S npx tsx
// Refinery DAG — single 900L source flows through tank operations, splits and mixes,
// and ends as 10 distinct output batches.
//
// Models a real palm-oil refinery layout:
//
//   STAGE 0: Source plantation                                   (1 wallet, 900L)
//   STAGE 1: Receiving tanks                                     (5 wallets)
//   STAGE 2: Settlement / holding tanks                          (10 wallets)
//   STAGE 3: Degumming + bleaching processing lines              (8 lines × 3 internal nodes = 24 wallets)
//   STAGE 4: Deodorization tanks                                 (6 wallets)
//   STAGE 5: Fractionation units (olein/stearin separation)      (4 wallets)
//   STAGE 6: Blending tanks                                      (8 wallets)
//   STAGE 7: Output batches (final products)                     (10 wallets)
//
// Total wallets: ~66
// Total unique hops: ~100
// Total transfers (with split/merge granularity): ~500
//
// Mass balance is preserved at every node: sum(incoming) == sum(outgoing) (or final balance).
// All transfers happen in ONE TraceabilityBatchRelay.executeHops() call.

import {
  createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi,
  keccak256, toHex, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_WRITE = process.env.RPC_WRITE_URL ?? "http://rpc-write:8545";
const RPC_READ = process.env.RPC_READ_URL ?? "http://rpc-read-1:8545";
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const TOKEN = (process.env.TOKEN_ADDRESS ?? "0xa31f4c0ef2935af25370d9ae275169ccd9793da3") as Address;
const RELAY = (process.env.RELAY_ADDRESS ?? "0xf9c0bf1cfaab883adb95fed4cfd60133bffab18a") as Address;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 131216);
const SEED = process.env.SEED ?? `refinery-${Date.now()}`;
const BATCH_ID = BigInt(process.env.BATCH_ID ?? Date.now());
const INITIAL_LITERS = 900n;

const ERC1155_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function mintBatch(uint256 batchId, address firstOwner, uint256 liters, bytes32 rspoCertificateHash, bytes32 plantationId, uint64 productionDate)",
]);
const RELAY_ABI = parseAbi([
  "function executeHops(address token, uint256 batchId, address[] froms, address[] tos, uint256[] amounts)",
]);

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ transport: http(RPC_READ) });
const writeClient = createWalletClient({ account: deployer, transport: http(RPC_WRITE) });

// ─────────────────────────────────────────────────────────────────────────────
// DAG generation
// ─────────────────────────────────────────────────────────────────────────────

interface Stage {
  name: string;
  prefix: string;
  count: number;
}

const STAGES: Stage[] = [
  { name: "source",        prefix: "src",     count: 1 },
  { name: "receiving",     prefix: "recv",    count: 5 },
  { name: "settlement",    prefix: "settle",  count: 10 },
  { name: "degumming-in",  prefix: "deg_in",  count: 8 },
  { name: "degumming-mid", prefix: "deg_mid", count: 8 },
  { name: "degumming-out", prefix: "deg_out", count: 8 },
  { name: "deodorization", prefix: "deo",     count: 6 },
  { name: "fractionation", prefix: "frac",    count: 4 },
  { name: "blending",      prefix: "blend",   count: 8 },
  { name: "output",        prefix: "out",     count: 10 },
];

function deriveWallet(stagePrefix: string, idx: number) {
  return privateKeyToAccount(keccak256(toHex(`${SEED}-${stagePrefix}-${idx}`)));
}

// Build wallets per stage
const wallets: Record<string, ReturnType<typeof deriveWallet>[]> = {};
for (const stage of STAGES) {
  wallets[stage.prefix] = Array.from({ length: stage.count }, (_, i) => deriveWallet(stage.prefix, i));
}

// ─── Define the DAG ────────────────────────────────────────────────────────
// Each hop = { from, to, amount }. Order matters (topological).
// We design connections per stage transition + intra-stage mixing.

interface Hop { from: Address; to: Address; amount: bigint; }

function buildRefineryHops(): Hop[] {
  const hops: Hop[] = [];

  // Tracks current balance per wallet (using deterministic accounting so we preserve mass balance).
  const bal: Map<Address, bigint> = new Map();
  const give = (a: Address, amt: bigint) => bal.set(a, (bal.get(a) ?? 0n) + amt);
  const take = (a: Address, amt: bigint) => bal.set(a, (bal.get(a) ?? 0n) - amt);
  const move = (from: Address, to: Address, amount: bigint) => {
    if ((bal.get(from) ?? 0n) < amount) throw new Error(`Insufficient at ${from}: have ${bal.get(from)}, need ${amount}`);
    hops.push({ from, to, amount });
    take(from, amount);
    give(to, amount);
  };

  // Source starts with 900L
  give(wallets.src[0].address, INITIAL_LITERS);

  // STAGE 0 → STAGE 1: source distributes to 5 receiving tanks
  // 180L each (5 transfers — but we'll split each into ~3 sub-transfers to model continuous flow)
  for (let r = 0; r < 5; r++) {
    const total = 180n;
    const parts = [60n, 70n, 50n]; // 3 sub-transfers per receiving line
    for (const p of parts) move(wallets.src[0].address, wallets.recv[r].address, p);
  }

  // Intra-stage 1: receiving tanks redistribute to balance levels (10 transfers, mass-balanced cycles)
  // recv[i] sends portion to recv[(i+1)%5] and gets some back from recv[(i+2)%5] — keeps net flow balanced
  for (let r = 0; r < 5; r++) {
    move(wallets.recv[r].address, wallets.recv[(r + 1) % 5].address, 30n);
  }
  // After that cycle, every receiving tank still has 180L (gave 30, got 30).
  for (let r = 0; r < 5; r++) {
    move(wallets.recv[r].address, wallets.recv[(r + 2) % 5].address, 20n);
  }

  // STAGE 1 → STAGE 2: 5 receiving × ~3 settlement each = 15 hops
  // Each receiving has 180L; split into 3 portions (60L each) going to 3 settlement tanks
  for (let r = 0; r < 5; r++) {
    const targets = [r * 2 % 10, (r * 2 + 1) % 10, (r * 2 + 3) % 10];
    move(wallets.recv[r].address, wallets.settle[targets[0]].address, 70n);
    move(wallets.recv[r].address, wallets.settle[targets[1]].address, 60n);
    move(wallets.recv[r].address, wallets.settle[targets[2]].address, 50n);
  }
  // Each settlement tank now has ~90L (varies due to overlap)

  // Intra-stage 2: settlement tanks cross-mix (20 transfers)
  for (let s = 0; s < 10; s++) {
    move(wallets.settle[s].address, wallets.settle[(s + 1) % 10].address, 20n);
  }
  for (let s = 0; s < 10; s++) {
    move(wallets.settle[s].address, wallets.settle[(s + 3) % 10].address, 15n);
  }

  // Recalculate each settlement's balance after mixing — they all hover near 90L but vary
  // Distribute remaining to degumming lines

  // STAGE 2 → STAGE 3a (degumming-in): 10 settlement → 8 degumming lines
  // Each settlement sends to ~2 lines, each line receives from ~2-3 settlements
  // Roughly 20 hops
  for (let s = 0; s < 10; s++) {
    const cur = bal.get(wallets.settle[s].address) ?? 0n;
    if (cur <= 0n) continue;
    const targetLines = [s % 8, (s + 1) % 8];
    const half = cur / 2n;
    move(wallets.settle[s].address, wallets.deg_in[targetLines[0]].address, half);
    move(wallets.settle[s].address, wallets.deg_in[targetLines[1]].address, cur - half);
  }

  // STAGE 3 internal: deg-in → deg-mid → deg-out (24 hops, 8 lines × 3)
  for (let line = 0; line < 8; line++) {
    const cur = bal.get(wallets.deg_in[line].address) ?? 0n;
    if (cur > 0n) {
      // Split each line's flow into 3 sub-transfers to model continuous processing
      const third = cur / 3n;
      move(wallets.deg_in[line].address, wallets.deg_mid[line].address, third);
      move(wallets.deg_in[line].address, wallets.deg_mid[line].address, third);
      move(wallets.deg_in[line].address, wallets.deg_mid[line].address, cur - 2n * third);
    }
    const mid = bal.get(wallets.deg_mid[line].address) ?? 0n;
    if (mid > 0n) {
      const half = mid / 2n;
      move(wallets.deg_mid[line].address, wallets.deg_out[line].address, half);
      move(wallets.deg_mid[line].address, wallets.deg_out[line].address, mid - half);
    }
  }

  // Cross-line mixing at degumming-out level (16 transfers)
  for (let line = 0; line < 8; line++) {
    move(wallets.deg_out[line].address, wallets.deg_out[(line + 1) % 8].address, 8n);
  }
  for (let line = 0; line < 8; line++) {
    move(wallets.deg_out[line].address, wallets.deg_out[(line + 3) % 8].address, 5n);
  }

  // STAGE 3 → STAGE 4 (deodorization): 8 degumming-out → 6 deo tanks (~12 hops, fan-in)
  for (let line = 0; line < 8; line++) {
    const cur = bal.get(wallets.deg_out[line].address) ?? 0n;
    if (cur <= 0n) continue;
    const tA = line % 6;
    const tB = (line + 2) % 6;
    const half = cur / 2n;
    move(wallets.deg_out[line].address, wallets.deo[tA].address, half);
    move(wallets.deg_out[line].address, wallets.deo[tB].address, cur - half);
  }

  // Intra-stage 4: deodorization tank cross-flow (12 transfers)
  for (let d = 0; d < 6; d++) {
    move(wallets.deo[d].address, wallets.deo[(d + 1) % 6].address, 8n);
  }
  for (let d = 0; d < 6; d++) {
    move(wallets.deo[d].address, wallets.deo[(d + 2) % 6].address, 5n);
  }

  // STAGE 4 → STAGE 5 (fractionation): 6 → 4 (~12 hops, more fan-in)
  for (let d = 0; d < 6; d++) {
    const cur = bal.get(wallets.deo[d].address) ?? 0n;
    if (cur <= 0n) continue;
    const tA = d % 4;
    const tB = (d + 1) % 4;
    const half = cur / 2n;
    move(wallets.deo[d].address, wallets.frac[tA].address, half);
    move(wallets.deo[d].address, wallets.frac[tB].address, cur - half);
  }

  // STAGE 5 internal: olein/stearin separation (4 × 2 = 8 transfers between own pairs is not great; do cross-flow instead)
  for (let f = 0; f < 4; f++) {
    move(wallets.frac[f].address, wallets.frac[(f + 1) % 4].address, 10n);
  }

  // STAGE 5 → STAGE 6 (blending): 4 fractionation → 8 blending (~16 hops, fan-out)
  for (let f = 0; f < 4; f++) {
    const cur = bal.get(wallets.frac[f].address) ?? 0n;
    if (cur <= 0n) continue;
    const tA = f * 2 % 8;
    const tB = (f * 2 + 1) % 8;
    const tC = (f * 2 + 3) % 8;
    const third = cur / 3n;
    move(wallets.frac[f].address, wallets.blend[tA].address, third);
    move(wallets.frac[f].address, wallets.blend[tB].address, third);
    move(wallets.frac[f].address, wallets.blend[tC].address, cur - 2n * third);
  }

  // Intra-stage 6: blending tanks cross-mix to balance (16 transfers)
  for (let b = 0; b < 8; b++) {
    move(wallets.blend[b].address, wallets.blend[(b + 1) % 8].address, 6n);
  }
  for (let b = 0; b < 8; b++) {
    move(wallets.blend[b].address, wallets.blend[(b + 3) % 8].address, 4n);
  }

  // STAGE 6 → STAGE 7 (output): 8 blending → 10 output batches (~14 hops)
  for (let b = 0; b < 8; b++) {
    const cur = bal.get(wallets.blend[b].address) ?? 0n;
    if (cur <= 0n) continue;
    const out1 = b % 10;
    const out2 = (b + 2) % 10;
    const half = cur / 2n;
    move(wallets.blend[b].address, wallets.out[out1].address, half);
    move(wallets.blend[b].address, wallets.out[out2].address, cur - half);
  }

  return hops;
}

const allHops = buildRefineryHops();
const totalLiters = allHops.reduce((s, h) => s + h.amount, 0n);
console.log(`Built DAG: ${allHops.length} hops, total volume moved = ${totalLiters}L`);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function batchSendRawTxs(rpcUrl: string, signedTxs: Hex[]): Promise<(Hex | Error)[]> {
  const body = signedTxs.map((raw, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_sendRawTransaction", params: [raw],
  }));
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const results = (await res.json()) as Array<{ id: number; result?: Hex; error?: { message: string } }>;
  results.sort((a, b) => a.id - b.id);
  return results.map((r) => (r.error ? new Error(r.error.message) : r.result!));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Collect every unique wallet that appears as a sender (needs approval + native prime)
  const allWalletsSet = new Map<Address, typeof wallets.src[0]>();
  for (const stage of STAGES) {
    for (const w of wallets[stage.prefix]) allWalletsSet.set(w.address, w);
  }
  const allWallets = Array.from(allWalletsSet.values());
  const senders = new Set<Address>();
  for (const h of allHops) senders.add(h.from);
  const senderWallets = allWallets.filter((w) => senders.has(w.address));

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  PALM-OIL REFINERY DAG — ${INITIAL_LITERS}L → 10 output batches`);
  console.log(`  Total wallets:  ${allWallets.length}`);
  console.log(`  Senders needing approval: ${senderWallets.length}`);
  console.log(`  Total hops in DAG:        ${allHops.length}`);
  console.log(`  Batch ID:                 ${BATCH_ID}`);
  console.log(`  Token:                    ${TOKEN}`);
  console.log(`  Relay:                    ${RELAY}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const t0 = Date.now();

  // Phase A: prime native HARA for every wallet (batched JSON-RPC)
  console.log(`▶ A. Priming ${allWallets.length} wallets with 1 wei native HARA (batched)...`);
  let depNonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  const primeRaws: Hex[] = [];
  for (let i = 0; i < allWallets.length; i++) {
    primeRaws.push(await deployer.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: depNonce + i,
      to: allWallets[i].address, value: 1n, gasPrice: 0n, gas: 21_000n,
    }));
  }
  const primeStart = Date.now();
  const primeResults = await batchSendRawTxs(RPC_WRITE, primeRaws);
  const lastPrimeHash = primeResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastPrimeHash, timeout: 120_000 });
  console.log(`  ✔ ${allWallets.length} primed in ${Date.now() - primeStart}ms`);
  depNonce += allWallets.length;

  // Phase B: mint the batch to source
  console.log(`▶ B. mintBatch(${BATCH_ID}, source, ${INITIAL_LITERS}L) ...`);
  const mintData = encodeFunctionData({
    abi: ERC1155_ABI, functionName: "mintBatch",
    args: [BATCH_ID, wallets.src[0].address, INITIAL_LITERS,
      keccak256(toHex(`rspo-${SEED}`)), keccak256(toHex("plantation-refinery-demo")),
      BigInt(Math.floor(Date.now() / 1000))],
  });
  const rawMint = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce,
    to: TOKEN, data: mintData, value: 0n, gasPrice: 0n, gas: 200_000n,
  });
  const mintHash = await writeClient.sendRawTransaction({ serializedTransaction: rawMint });
  await publicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 60_000 });
  console.log(`  ✔ minted`);
  depNonce++;

  // Phase C: every sender approves the relay (batched JSON-RPC, all from different wallets, all nonce=0)
  console.log(`▶ C. ${senderWallets.length} senders setApprovalForAll(relay, true) (batched)...`);
  const apprRaws: Hex[] = [];
  const apprData = encodeFunctionData({
    abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [RELAY, true],
  });
  for (const w of senderWallets) {
    apprRaws.push(await w.signTransaction({
      type: "legacy", chainId: CHAIN_ID, nonce: 0,
      to: TOKEN, data: apprData, value: 0n, gasPrice: 0n, gas: 60_000n,
    }));
  }
  const apprStart = Date.now();
  const apprResults = await batchSendRawTxs(RPC_WRITE, apprRaws);
  const lastApprHash = apprResults.filter((r): r is Hex => !(r instanceof Error)).pop()!;
  await publicClient.waitForTransactionReceipt({ hash: lastApprHash, timeout: 180_000 });
  console.log(`  ✔ ${senderWallets.length} approvals in ${Date.now() - apprStart}ms`);

  // Phase D: THE ONE TX — executeHops with all hops in DAG order
  console.log(`▶ D. relay.executeHops(${allHops.length} hops) in 1 tx...`);
  const hopData = encodeFunctionData({
    abi: RELAY_ABI, functionName: "executeHops",
    args: [TOKEN, BATCH_ID,
      allHops.map((h) => h.from),
      allHops.map((h) => h.to),
      allHops.map((h) => h.amount),
    ],
  });
  const gas = BigInt(Math.max(500_000, allHops.length * 50_000));
  const rawHops = await deployer.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce: depNonce,
    to: RELAY, data: hopData, value: 0n, gasPrice: 0n, gas,
  });
  const tHops = Date.now();
  const hopsHash = await writeClient.sendRawTransaction({ serializedTransaction: rawHops });
  const r = await publicClient.waitForTransactionReceipt({ hash: hopsHash, timeout: 180_000 });
  console.log(`  ✔ ${allHops.length} hops executed in ${Date.now() - tHops}ms`);
  console.log(`    Block ${r.blockNumber}, gas used ${r.gasUsed}, status: ${r.status}`);
  console.log(`    Tx: ${hopsHash}`);

  // Verify: sum of final output batch balances should equal 900L
  console.log(`▶ E. Verifying mass balance at 10 output wallets...`);
  let totalOutput = 0n;
  for (let i = 0; i < 10; i++) {
    const b = (await publicClient.readContract({
      address: TOKEN, abi: ERC1155_ABI, functionName: "balanceOf",
      args: [wallets.out[i].address, BATCH_ID],
    })) as bigint;
    totalOutput += b;
    console.log(`    out[${i}] ${wallets.out[i].address.slice(0, 10)}…: ${b} L`);
  }
  const allMatch = totalOutput === INITIAL_LITERS;
  console.log(`    TOTAL OUTPUT: ${totalOutput} L  ${allMatch ? "✓ matches source" : `✗ expected ${INITIAL_LITERS}`}`);

  const total = Date.now() - t0;
  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  REFINERY DAG complete`);
  console.log(`  Source:    ${INITIAL_LITERS}L from 1 wallet`);
  console.log(`  Output:    ${totalOutput}L across 10 batches  ${allMatch ? "✓" : "✗"}`);
  console.log(`  Hops:      ${allHops.length} transfers in 1 transaction`);
  console.log(`  Gas:       ${r.gasUsed} (${Math.round(Number(r.gasUsed) / allHops.length)}/hop)`);
  console.log(`  Total wall time: ${(total / 1000).toFixed(1)}s`);
  console.log(`  Batch ID for viewer: ${BATCH_ID}`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allMatch ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
