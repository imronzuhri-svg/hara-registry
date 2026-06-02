// Client for the read-only Console API (/api/overview).
// Dev: Vite proxies /api -> the Console API (see vite.config.ts).
// Prod: same-origin, served alongside the SPA.
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export type Section<T> =
  | { available: true; data: T }
  | { available: false; error: string };

export interface ChainData {
  chainId: number;
  block: number;
  blockTimeSec: number | null;
  gasPrice: string;
}
export interface ValidatorRow {
  address: string;
  proposedBlockCount: number | null;
  lastProposedBlock: number | null;
  recentlyProposed: boolean;
}
export interface ValidatorData {
  count: number;
  head: number;
  validators: ValidatorRow[];
}
export interface AccountRow {
  label: string;
  address: string;
  balanceEth: string;
  nonce: number;
  zeroBalance: boolean;
}
export interface BackendRow {
  proxy: string;
  server: string;
  status: string;
}
export interface ServicesData {
  indexerLag: number | null;
  indexedBlock: number | null;
  chainHead: number | null;
}
export interface VaultData {
  sealed: boolean;
  threshold: number;
  shares: number;
  progress: number;
  version?: string;
}
export interface AlertRow {
  name: string;
  severity: string;
  state: string;
  startsAt: string;
}

export interface Overview {
  generatedAt: string;
  chain: Section<ChainData>;
  validators: Section<ValidatorData>;
  accounts: Section<AccountRow[]>;
  rpcTier: Section<BackendRow[]>;
  services: Section<ServicesData>;
  vault: Section<VaultData>;
  alerts: Section<AlertRow[]>;
  backups: Section<unknown>;
}

export async function fetchOverview(signal?: AbortSignal): Promise<Overview> {
  const res = await fetch(`${API_BASE}/overview`, { signal });
  if (!res.ok) throw new Error(`Console API HTTP ${res.status}`);
  return (await res.json()) as Overview;
}
