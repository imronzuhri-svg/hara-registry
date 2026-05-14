export const config = {
  port: Number(process.env.SIGNER_PORT ?? 7000),
  host: process.env.SIGNER_HOST ?? "0.0.0.0",
  chainId: Number(process.env.HARA_CHAIN_ID ?? 131216),
  rpcReadUrl: process.env.RPC_READ_URL ?? "http://lb:8545/rpc/read",
  defaultGasLimit: BigInt(process.env.DEFAULT_GAS_LIMIT ?? 8_000_000),
  defaultGasPrice: BigInt(process.env.DEFAULT_GAS_PRICE ?? 0), // free-gas chain
};
