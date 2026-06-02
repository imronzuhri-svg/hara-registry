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
export interface RpcTierInfo {
  endpoint: string;
  up: boolean;
  block: number | null;
  peers: number | null;
  syncing: boolean;
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
export interface BackupTimer {
  unit: string;
  service: string | null;
  nextRun: string | null;
  lastRun: string | null;
  result: string | null;
  exitStatus: string | null;
}
export interface BackupHost {
  host: string;
  generatedAt: string;
  timers: BackupTimer[];
}
export interface BackupsData {
  hosts: BackupHost[];
  unreachable: number;
}

export interface Overview {
  generatedAt: string;
  chain: Section<ChainData>;
  validators: Section<ValidatorData>;
  accounts: Section<AccountRow[]>;
  rpcTier: Section<RpcTierInfo>;
  services: Section<ServicesData>;
  vault: Section<VaultData>;
  alerts: Section<AlertRow[]>;
  backups: Section<BackupsData>;
}

export async function fetchOverview(signal?: AbortSignal): Promise<Overview> {
  const res = await fetch(`${API_BASE}/overview`, { signal });
  if (!res.ok) throw new Error(`Console API HTTP ${res.status}`);
  return (await res.json()) as Overview;
}
