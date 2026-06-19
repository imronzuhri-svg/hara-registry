/**
 * Read an on-chain ERC-1155 balance (litres of a batch held by an address).
 *
 *   npx tsx examples/balance.ts <address> <batchId>
 *
 * Pure read — no wallet, no funding needed. Routes to /read/ (cached LB).
 */
import { createReadClient, HaraPalmOil } from "@hara/registry-sdk";
import type { Address } from "viem";

async function main() {
  const account = (process.argv[2] ?? "0x0000000000000000000000000000000000000001") as Address;
  const batchId = BigInt(process.argv[3] ?? "1");

  const client = createReadClient();
  console.log("chainId:", await client.getChainId());
  console.log("block:  ", await client.getBlockNumber());

  const palmOil = new HaraPalmOil(client);
  const liters = await palmOil.balanceOf(account, batchId);
  console.log(`Balance of batch ${batchId} for ${account}: ${liters} litres`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
