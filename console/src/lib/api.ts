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

// ── Time-series + anomalies ──────────────────────────────────────────────────
export interface RangePoint {
  t: number;
  v: number;
}
export interface RangeSeries {
  name: string;
  unit: string;
  label: string;
  points: RangePoint[];
}
export interface Anomaly {
  area: string;
  level: "info" | "warn" | "critical";
  message: string;
  at: string;
}
export interface Silence {
  id: string;
  alertname: string;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
  state: string;
}

export async function fetchSilences(): Promise<Silence[]> {
  const res = await fetch(`${API_BASE}/alerts/silences`);
  if (!res.ok) throw new Error(`silences HTTP ${res.status}`);
  return ((await res.json()) as { silences: Silence[] }).silences;
}
export async function silenceAlert(alertname: string, hours: number, comment = ""): Promise<void> {
  const res = await fetch(`${API_BASE}/alerts/silence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alertname, hours, comment }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
}
export async function unsilence(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/alerts/silence/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** "2m ago" / "3h ago" relative time from an ISO timestamp. */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Relative time handling both past ("3h ago") and future ("in 5h"). */
export function rel(iso: string | null): string {
  if (!iso) return "—";
  const d = (new Date(iso).getTime() - Date.now()) / 1000;
  if (d < 0) return ago(iso);
  if (d < 60) return "in <1m";
  if (d < 3600) return `in ${Math.floor(d / 60)}m`;
  if (d < 86400) return `in ${Math.floor(d / 3600)}h`;
  return `in ${Math.floor(d / 86400)}d`;
}

export async function fetchRange(series: string, minutes = 60): Promise<RangeSeries> {
  const res = await fetch(`${API_BASE}/metrics/range?series=${series}&minutes=${minutes}`);
  if (!res.ok) throw new Error(`metrics HTTP ${res.status}`);
  return (await res.json()) as RangeSeries;
}

export async function fetchAnomalies(): Promise<Anomaly[]> {
  const res = await fetch(`${API_BASE}/anomalies`);
  if (!res.ok) throw new Error(`anomalies HTTP ${res.status}`);
  return ((await res.json()) as { anomalies: Anomaly[] }).anomalies;
}

// ── Insights (intelligence: reliability + optimisation) ──────────────────────
export interface Baseline {
  key: string;
  label: string;
  unit: string;
  current: number | null;
  mean: number | null;
  z: number | null;
  status: "normal" | "elevated" | "anomalous";
}
export interface Forecast {
  label: string;
  current: number | null;
  predicted1h: number | null;
  threshold: number;
  willBreach: boolean;
}
export interface BackupFreshness {
  unit: string;
  host: string;
  ageHours: number | null;
  result: string | null;
  overdue: boolean;
}
export interface Slo {
  successPct: number | null;
  total: number | null;
  errors5xx: number | null;
  recent5xxPerMin: number | null;
}
export interface Fairness {
  shares: { address: string; pct: number; recentlyProposed: boolean }[];
  spreadPct: number | null;
  verdict: string;
}
export interface Recommendation {
  area: string;
  severity: "info" | "warn" | "critical";
  text: string;
}
export interface Insights {
  generatedAt: string;
  baselines: Baseline[];
  forecasts: Forecast[];
  backups: BackupFreshness[];
  slo: Slo;
  cacheHitPct: number | null;
  fairness: Fairness;
  recommendations: Recommendation[];
}

export async function fetchInsights(): Promise<Insights> {
  const res = await fetch(`${API_BASE}/insights`);
  if (!res.ok) throw new Error(`insights HTTP ${res.status}`);
  return (await res.json()) as Insights;
}

export const CONTRACT_ROLES: Record<string, string[]> = {
  HaraPalmOil: ["MINTER_ROLE", "CERTIFIER_ROLE", "DEFAULT_ADMIN_ROLE"],
  PQAnchorRegistry: ["ANCHOR_ROLE", "KEY_ROTATOR_ROLE", "DEFAULT_ADMIN_ROLE"],
  ContractRegistry: ["REGISTRAR_ROLE", "DEFAULT_ADMIN_ROLE"],
  GovernanceContract: ["GOVERNANCE_ROLE", "DEFAULT_ADMIN_ROLE"],
  AnchorRegistry: ["ANCHOR_ROLE", "DEFAULT_ADMIN_ROLE"],
  TraceabilityBatchRelay: ["DEFAULT_ADMIN_ROLE"],
};
