import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

import { CHAIN_ID, ENDPOINTS, GAS_PRICE, haraChain } from "./config.js";

/**
 * A thin chain client for Hara Registry built on viem.
 *
 * It bakes in the three rules that bite every integrator:
 *   1. Legacy txs, gasPrice 0, chainId 131216 — always.
 *   2. Pre-fund >= 1 wei before a wallet's first tx (Besu silently drops
 *      zero-balance senders even at gasPrice 0).
 *   3. Verify receipt.status === "success" — a mined tx can still have reverted.
 */
export class HaraChainClient {
  /** Read client → /read/ (cached LB). */
  readonly public: PublicClient;
  /** Write client → /write/ (eth_sendRawTransaction). Present only if an account was given. */
  readonly wallet?: WalletClient;
  readonly account?: Account;

  constructor(opts: { account?: Account; readUrl?: string; writeUrl?: string } = {}) {
    const readUrl = opts.readUrl ?? ENDPOINTS.read;
    const writeUrl = opts.writeUrl ?? ENDPOINTS.write;

    this.public = createPublicClient({
      chain: haraChain,
      transport: http(readUrl),
    });

    if (opts.account) {
      this.account = opts.account;
      this.wallet = createWalletClient({
        account: opts.account,
        chain: haraChain,
        transport: http(writeUrl),
      });
    }
  }

  /** Current block height. */
  async getBlockNumber(): Promise<bigint> {
    return this.public.getBlockNumber();
  }

  /** Chain id reported by the node (should equal 131216). */
  async getChainId(): Promise<number> {
    return this.public.getChainId();
  }

  /** Native HARA balance (wei) of an address. */
  async getBalance(address: Address): Promise<bigint> {
    return this.public.getBalance({ address });
  }

  /**
   * Check that a wallet is funded before its first tx. Besu silently skips
   * zero-balance senders even at gasPrice 0, so an unfunded wallet's tx hangs
   * unmined. Returns the balance; warns (does not throw) when it is zero.
   */
  async ensureFunded(address: Address): Promise<bigint> {
    const balance = await this.getBalance(address);
    if (balance === 0n) {
      console.warn(
        `[hara] address ${address} has zero native HARA. Besu silently drops ` +
          `zero-balance senders (even at gasPrice 0) — pre-fund >= 1 wei before its first tx, ` +
          `or the tx will sit unmined and your tool will hang.`,
      );
    }
    return balance;
  }

  /**
   * Send a legacy (type 0) transaction with gasPrice 0 and chainId 131216 baked in.
   * Requires a wallet account. Returns the tx hash; pair with waitForReceipt().
   *
   * @param tx.to    destination address (contract or EOA)
   * @param tx.data  calldata (optional; e.g. from encodeFunctionData)
   * @param tx.value native value in wei (default 0n)
   * @param tx.gas   gas limit (optional; estimated if omitted)
   */
  async sendLegacyTx(tx: {
    to: Address;
    data?: Hex;
    value?: bigint;
    gas?: bigint;
  }): Promise<Hex> {
    if (!this.wallet || !this.account) {
      throw new Error(
        "sendLegacyTx requires an account — construct HaraChainClient({ account }).",
      );
    }

    return this.wallet.sendTransaction({
      account: this.account,
      chain: haraChain,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: tx.gas,
      // The three invariants of this chain:
      type: "legacy",
      gasPrice: GAS_PRICE,
      // chainId is enforced by `chain: haraChain` (id 131216); kept here for clarity.
    });
  }

  /**
   * Wait for a transaction receipt and throw if it did not succeed.
   * A mined tx can still have reverted — callers must not assume "mined" == "ok".
   */
  async waitForReceipt(
    hash: Hex,
    opts: { timeoutMs?: number; pollingIntervalMs?: number } = {},
  ): Promise<TransactionReceipt> {
    const receipt = await this.public.waitForTransactionReceipt({
      hash,
      timeout: opts.timeoutMs ?? 60_000,
      pollingInterval: opts.pollingIntervalMs ?? 1_000,
    });

    if (receipt.status !== "success") {
      throw new Error(
        `Transaction ${hash} reverted (status=${receipt.status}) in block ` +
          `${receipt.blockNumber}. Gas used: ${receipt.gasUsed}.`,
      );
    }

    return receipt;
  }
}

/** Convenience: a read-only client (no account). */
export function createReadClient(readUrl?: string): HaraChainClient {
  return new HaraChainClient({ readUrl });
}

export { CHAIN_ID };
