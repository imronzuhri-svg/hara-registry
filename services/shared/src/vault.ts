import type { Hex } from "viem";

const VAULT_ADDR = process.env.VAULT_ADDR ?? "http://vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN ?? "haraledger-dev-root";

export interface SignerKey {
  address: `0x${string}`;
  privateKey: Hex;
}

/**
 * Fetch a signer key from Vault.
 * The key never touches disk; callers should hold it in memory only.
 */
export async function fetchSignerKey(vaultPath: string): Promise<SignerKey> {
  // vaultPath looks like "secret/haraledger/signer-keys/deployer"
  // KV v2 read URL is "<addr>/v1/secret/data/haraledger/signer-keys/deployer"
  const apiPath = vaultPath.replace(/^secret\//, "secret/data/");
  const url = `${VAULT_ADDR}/v1/${apiPath}`;

  const res = await fetch(url, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Vault fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { data: { address: string; private_key: string } } };
  const { address, private_key } = body.data.data;
  return {
    address: address.toLowerCase() as `0x${string}`,
    privateKey: private_key.startsWith("0x") ? (private_key as Hex) : (`0x${private_key}` as Hex),
  };
}
