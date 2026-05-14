import type { Address, Hex } from "viem";

export type TxStatus =
  | "DRAFT"
  | "QUEUED"
  | "SIGNED"
  | "BROADCASTED"
  | "CONFIRMED"
  | "REVERTED"
  | "FAILED"
  | "RETRYING";

export interface TxRow {
  txId: string;
  fromAddress: Address;
  toAddress: Address | null;
  data: Hex;
  value: string; // numeric stored as string in pg
  gasLimit: number | null;
  nonce: number | null;
  chainId: number;
  rawTx: Hex | null;
  txHash: Hex | null;
  status: TxStatus;
  receiptStatus: number | null;
  blockNumber: number | null;
  gasUsed: number | null;
  errorMessage: string | null;
  retryCount: number;
  submittedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
}

export interface SubmitTxRequest {
  from: Address;
  to?: Address;
  data?: Hex;
  value?: string;
  gasLimit?: number;
}

export interface SubmitTxResponse {
  txId: string;
  status: TxStatus;
}

export const QUEUE_KEY_OUTBOUND = "hara:tx:outbound";
export const QUEUE_GROUP_BROADCASTER = "broadcaster";
