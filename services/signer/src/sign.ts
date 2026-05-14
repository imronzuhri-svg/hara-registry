import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { fetchSignerKey, type SignerKey } from "@hara/shared";
import { config } from "./config.js";

/**
 * In-memory cache of signer keys, keyed by lowercased address.
 * Keys live only in this process's heap and never touch disk.
 */
const keyCache = new Map<string, SignerKey>();

export async function getSignerKey(vaultPath: string): Promise<SignerKey> {
  if (keyCache.has(vaultPath)) return keyCache.get(vaultPath)!;
  const key = await fetchSignerKey(vaultPath);
  keyCache.set(vaultPath, key);
  return key;
}

export interface UnsignedTx {
  from: Address;
  to: Address | null;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  nonce: number;
}

export interface SignedTx {
  rawTx: Hex;
  txHash: Hex;
}

export async function signTx(vaultPath: string, tx: UnsignedTx): Promise<SignedTx> {
  const key = await getSignerKey(vaultPath);
  if (key.address.toLowerCase() !== tx.from.toLowerCase()) {
    throw new Error(
      `Vault key address ${key.address} does not match requested from ${tx.from}`,
    );
  }
  const account = privateKeyToAccount(key.privateKey);

  // Legacy tx — matches Besu QBFT genesis (London hardfork but zeroBaseFee).
  // EIP-1559 type-2 txs aren't useful here because there is no base fee.
  const rawTx = await account.signTransaction({
    type: "legacy",
    chainId: config.chainId,
    nonce: tx.nonce,
    to: tx.to ?? undefined,
    data: tx.data,
    value: tx.value,
    gasPrice: config.defaultGasPrice,
    gas: tx.gasLimit,
  });

  // viem returns the keccak256 of the raw tx as the resulting hash
  const { keccak256 } = await import("viem");
  const txHash = keccak256(rawTx);

  return { rawTx, txHash };
}
