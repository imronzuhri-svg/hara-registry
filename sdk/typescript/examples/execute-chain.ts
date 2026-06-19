/**
 * Mint a batch, approve the relay, and move it down a custody chain in one
 * atomic relay tx — mirroring the stress-test pattern.
 *
 *   MINTER_PK=0x... npx tsx examples/execute-chain.ts
 *
 * Requires a funded MINTER_ROLE key. Remember:
 *   - legacy tx, gasPrice 0, chainId 131216 (baked into HaraChainClient)
 *   - pre-fund every signer with >= 1 wei before its first tx
 *   - verify receipt.status === "success" (waitForReceipt throws otherwise)
 */
import {
  ADDRESSES,
  HaraChainClient,
  HaraPalmOil,
  TraceabilityBatchRelay,
} from "@hara/registry-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, type Address, type Hex } from "viem";

async function main() {
  const pk = process.env.MINTER_PK as Hex | undefined;
  if (!pk) throw new Error("set MINTER_PK to a funded MINTER_ROLE private key");

  const minter = privateKeyToAccount(pk);
  const client = new HaraChainClient({ account: minter });

  // 1. Make sure the minter is funded — Besu drops zero-balance senders.
  await client.ensureFunded(minter.address);

  const palmOil = new HaraPalmOil(client);
  const relay = new TraceabilityBatchRelay(client);

  const batchId = BigInt(Date.now()); // unique-ish demo id
  const liters = 1000n;

  // 2. Mint the batch to the minter (firstOwner).
  console.log(`Minting batch ${batchId} (${liters} L)...`);
  const mintHash = await palmOil.mintBatch({
    batchId,
    firstOwner: minter.address,
    liters,
    rspoCertificateHash: keccak256(toBytes("RSPO-CERT-DEMO")),
    plantationId: keccak256(toBytes("PLANTATION-DEMO")),
    productionDate: BigInt(Math.floor(Date.now() / 1000)),
  });
  await client.waitForReceipt(mintHash);
  console.log("  minted:", mintHash);

  // 3. Approve the relay to move the minter's tokens (one-time, per holder).
  if (!(await palmOil.isApprovedForAll(minter.address, ADDRESSES.TraceabilityBatchRelay))) {
    console.log("Approving relay...");
    const approveHash = await palmOil.setApprovalForAll(ADDRESSES.TraceabilityBatchRelay, true);
    await client.waitForReceipt(approveHash);
    console.log("  approved:", approveHash);
  }

  // 4. Run the custody chain. holders[0] is the current owner (minter);
  //    intermediate holders must each have approved the relay beforehand.
  const holders: Address[] = [
    minter.address,
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  ];
  console.log(`Relaying batch ${batchId} through ${holders.length} holders...`);
  const chainHash = await relay.executeChain(ADDRESSES.HaraPalmOil, batchId, liters, holders);
  const receipt = await client.waitForReceipt(chainHash);
  console.log("  relayed:", chainHash, "in block", receipt.blockNumber);

  const finalHolder = holders[holders.length - 1] as Address;
  const finalBalance = await palmOil.balanceOf(finalHolder, batchId);
  console.log(`Final holder ${finalHolder} now holds ${finalBalance} L`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
