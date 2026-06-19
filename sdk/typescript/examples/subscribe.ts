/**
 * Subscribe to new block headers over WebSocket.
 *
 *   npx tsx examples/subscribe.ts
 *
 * Uses the public WS endpoint wss://rpc.ledger.haratrust.io/ws (no auth).
 */
import { createPublicClient, webSocket } from "viem";
import { ENDPOINTS, haraChain } from "@hara/registry-sdk";

async function main() {
  const client = createPublicClient({
    chain: haraChain,
    transport: webSocket(ENDPOINTS.ws),
  });

  console.log("Subscribing to newHeads on", ENDPOINTS.ws);
  const unwatch = client.watchBlocks({
    emitMissed: false,
    onBlock: (block) => {
      console.log(`block #${block.number}  ${block.hash}  txs=${block.transactions.length}`);
    },
    onError: (err) => console.error("subscription error:", err),
  });

  // Run for ~30s then stop (instant-finality ~2s blocks → ~15 blocks).
  setTimeout(() => {
    unwatch();
    console.log("Unsubscribed.");
    process.exit(0);
  }, 30_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
