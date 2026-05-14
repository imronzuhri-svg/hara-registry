import { createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
  const c = createPublicClient({ transport: http(process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read") });
  const TOKEN = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" as const;
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

  const head = await c.getBlockNumber();
  console.log(`Chain head: ${head}`);

  for (const i of [0, 1, 2, 5, 10, 50, 97, 98, 99]) {
    const pk = keccak256(toHex(`hara-trace-${i}`));
    const a = privateKeyToAccount(pk);
    const b = (await c.readContract({ address: TOKEN, abi, functionName: "balanceOf", args: [a.address] })) as bigint;
    console.log(`wallet[${i}] ${a.address} = ${b / 10n ** 18n} HTST`);
  }
}
main();
