import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { PQ_ANCHOR_REGISTRY_ABI } from "./abi.js";

/**
 * Thin viem wrapper over the three PQAnchorRegistry calls the worker uses.
 *
 * All txs go --legacy + gasPrice 0 per house convention (state-2 §7 / §12 —
 * Besu QBFT + London EVM + gasPrice=0 is invariant; EIP-1559 paths break it).
 */

const haraChain = defineChain({
  id: config.chainId,
  name: "HaraLedger",
  nativeCurrency: { name: "HARA", symbol: "HARA", decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcReadUrl] },
  },
});

let _readClient: ReturnType<typeof createPublicClient> | null = null;
let _writeClient: ReturnType<typeof createWalletClient> | null = null;

function readClient() {
  if (!_readClient) {
    _readClient = createPublicClient({ chain: haraChain, transport: http(config.rpcReadUrl) });
  }
  return _readClient;
}

function writeClient(privateKey: Hex) {
  if (!_writeClient) {
    _writeClient = createWalletClient({
      chain: haraChain,
      transport: http(config.rpcWriteUrl),
      account: privateKeyToAccount(privateKey),
    });
  }
  return _writeClient;
}

export async function currentPQKeyHashOnChain(): Promise<Hex> {
  const v = await readClient().readContract({
    address: config.pqAnchorAddress,
    abi: PQ_ANCHOR_REGISTRY_ABI,
    functionName: "currentPQKeyHash",
  });
  return v as Hex;
}

export async function rotatePQKey(
  signerKey: Hex,
  newKeyHash: Hex,
  newAlgorithm: string,
): Promise<Hex> {
  const wc = writeClient(signerKey);
  const hash = await wc.writeContract({
    address: config.pqAnchorAddress,
    abi: PQ_ANCHOR_REGISTRY_ABI,
    functionName: "rotatePQKey",
    args: [newKeyHash, newAlgorithm],
    chain: haraChain,
    account: wc.account!,
    gasPrice: 0n,
  } as any);
  await readClient().waitForTransactionReceipt({ hash });
  return hash;
}

export interface RecordAnchorParams {
  merkleRoot: Hex;
  sha3Root: Hex;
  blockFrom: bigint;
  blockTo: bigint;
  eventCount: bigint;
  anchorChain: Hex;
  pqSignatureHash: Hex;
}

export interface RecordAnchorResult {
  txHash: Hex;
  blockNumber: bigint;
  /** The anchorId returned by the contract, parsed from the AnchorRecorded log. */
  anchorId: bigint;
}

export async function recordAnchor(
  signerKey: Hex,
  p: RecordAnchorParams,
): Promise<RecordAnchorResult> {
  const wc = writeClient(signerKey);
  const txHash = await wc.writeContract({
    address: config.pqAnchorAddress,
    abi: PQ_ANCHOR_REGISTRY_ABI,
    functionName: "recordAnchor",
    args: [
      p.merkleRoot,
      p.sha3Root,
      p.blockFrom,
      p.blockTo,
      p.eventCount,
      p.anchorChain,
      p.pqSignatureHash,
    ],
    chain: haraChain,
    account: wc.account!,
    gasPrice: 0n,
  } as any);

  const receipt = await readClient().waitForTransactionReceipt({ hash: txHash });

  // anchorId is the first indexed topic on the AnchorRecorded event.
  // Parse the topic[1] of the matching log instead of calling anchorCount()
  // afterwards (race-free).
  let anchorId = 0n;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === config.pqAnchorAddress.toLowerCase() &&
      log.topics[0] // event signature
    ) {
      // AnchorRecorded is the only event recordAnchor emits, so any matching
      // log from our contract is it.
      anchorId = BigInt(log.topics[1] ?? "0x0");
      break;
    }
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    anchorId,
  };
}

export async function ensureWalletPrefunded(address: Address): Promise<void> {
  // Besu silently drops zero-balance senders even at gasPrice=0 (state-2 §12).
  // If we're cold-starting on a fresh chain, the deployer may not have funded
  // our wallet yet. Bail loudly rather than emit txs that vanish into the
  // mempool.
  const bal = await readClient().getBalance({ address });
  if (bal === 0n) {
    throw new Error(
      `Anchor signer ${address} has zero native balance. ` +
        `Pre-fund with ≥1 wei (Besu drops zero-balance senders at gasPrice=0). ` +
        `See infra/scripts/prefund-vault-key.sh.`,
    );
  }
}
