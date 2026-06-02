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

// ── P1 assisted-ops (propose-only) ───────────────────────────────────────────
export type Risk = "low" | "medium" | "high";
export interface Proposal {
  kind: string;
  title: string;
  summary: string;
  risk: Risk;
  commands: string[];
  notes: string[];
}
export interface AuditEntry {
  ts: string;
  actor: string;
  kind: string;
  summary: string;
  risk: string;
  params: Record<string, unknown>;
  commands: string[];
}

/** Build (but do NOT execute) a privileged-action command; the API audits it. */
export async function propose(kind: string, params: Record<string, unknown>): Promise<Proposal> {
  const res = await fetch(`${API_BASE}/propose/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as Proposal;
}

export async function fetchAudit(limit = 100): Promise<AuditEntry[]> {
  const res = await fetch(`${API_BASE}/audit?limit=${limit}`);
  if (!res.ok) throw new Error(`audit HTTP ${res.status}`);
  return ((await res.json()) as { entries: AuditEntry[] }).entries;
}

export const CONTRACT_ROLES: Record<string, string[]> = {
  HaraPalmOil: ["MINTER_ROLE", "CERTIFIER_ROLE", "DEFAULT_ADMIN_ROLE"],
  PQAnchorRegistry: ["ANCHOR_ROLE", "KEY_ROTATOR_ROLE", "DEFAULT_ADMIN_ROLE"],
  ContractRegistry: ["REGISTRAR_ROLE", "DEFAULT_ADMIN_ROLE"],
  GovernanceContract: ["GOVERNANCE_ROLE", "DEFAULT_ADMIN_ROLE"],
  AnchorRegistry: ["ANCHOR_ROLE", "DEFAULT_ADMIN_ROLE"],
  TraceabilityBatchRelay: ["DEFAULT_ADMIN_ROLE"],
};
