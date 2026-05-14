import { createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
  const c = createPublicClient({ transport: http(process.env.RPC_READ_URL ?? "http://rpc-read-1:8545") });
  const TOKEN = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" as const;
  const SEED = process.env.SEED ?? "hara-trace-1778665339";
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

  let lastNonZero = -1;
  for (let i = 0; i < 100; i++) {
    const pk = keccak256(toHex(`${SEED}-${i}`));
    const a = privateKeyToAccount(pk);
    const b = (await c.readContract({ address: TOKEN, abi, functionName: "balanceOf", args: [a.address] })) as bigint;
    if (b > 0n) {
      lastNonZero = i;
      console.log(`wallet[${i}] = ${b / 10n ** 18n} HTST`);
    }
  }
  console.log(`\nChain broke after wallet[${lastNonZero}]`);
}
main();
