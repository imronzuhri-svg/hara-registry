import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

(async () => {
  const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const pub = createPublicClient({ transport: http("https://rpc.ledger.haratrust.io/write/") });
  const w   = createWalletClient({ account: deployer, transport: http("https://rpc.ledger.haratrust.io/write/") });

  const nonce = await pub.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  console.log("Nonce from pending:", nonce);

  const raw = await deployer.signTransaction({
    type: "legacy", chainId: 131216, nonce,
    to: "0x000000000000000000000000000000000000dEaD", value: 1n,
    gasPrice: 0n, gas: 21000n,
  });
  console.log("Sending raw tx...");
  const hash = await w.sendRawTransaction({ serializedTransaction: raw });
  console.log("Hash returned:", hash);

  for (let i = 0; i < 30; i++) {
    const tx = await pub.getTransaction({ hash }).catch(() => null);
    const r  = await pub.getTransactionReceipt({ hash }).catch(() => null);
    console.log(`t=${i*2}s  tx=${tx ? `block=${tx.blockNumber}` : "null"}  receipt=${r ? "MINED" : "pending"}`);
    if (r) break;
    await new Promise(r => setTimeout(r, 2000));
  }
})().catch(e => { console.error(e); process.exit(1); });
