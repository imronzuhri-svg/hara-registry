/**
 * @hara/registry-sdk — official TypeScript/Node SDK for the Hara Registry.
 *
 * Hara Registry is a permissioned Hyperledger Besu (QBFT) chain (id 131216) for
 * palm-oil supply-chain traceability with post-quantum audit anchoring.
 *
 * Three rules that bite every integrator (all handled by HaraChainClient):
 *   1. Legacy txs, gasPrice 0, chainId 131216 — always.
 *   2. Pre-fund >= 1 wei before a wallet's first tx (zero-balance drop).
 *   3. Verify receipt.status === "success" — a mined tx can still revert.
 */

export * from "./config.js";
export * from "./chain.js";
export * from "./contracts.js";
export * from "./trace.js";
export * from "./anchor.js";
export * from "./types.js";
