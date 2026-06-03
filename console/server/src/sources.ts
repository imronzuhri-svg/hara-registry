import { config } from "./config.js";
import { rpc, fetchT, hexToNum, hexToBig, weiToEth } from "./rpc.js";

/** tolerant numeric parse: accepts "0x.." hex or decimal string */
const num = (v: string | number): number =>
  typeof v === "number" ? v : v.startsWith("0x") ? parseInt(v, 16) : parseInt(v, 10);

export interface ChainInfo {
  chainId: number;
  block: number;
  blockTimeSec: number | null;
  gasPrice: string;
}

export async function getChain(): Promise<ChainInfo> {
  const [chainIdHex, latest, gasPriceHex] = await Promise.all([
    rpc<string>("eth_chainId"),
    rpc<{ number: string; timestamp: string }>("eth_getBlockByNumber", ["latest", false]),
    rpc<string>("eth_gasPrice"),
  ]);
  const blockNum = hexToNum(latest.number);
  let blockTimeSec: number | null = null;
  if (blockNum > 1) {
    const prev = await rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
      "0x" + (blockNum - 1).toString(16),
      false,
    ]);
    if (prev) blockTimeSec = hexToNum(latest.timestamp) - hexToNum(prev.timestamp);
  }
  return { chainId: hexToNum(chainIdHex), block: blockNum, blockTimeSec, gasPrice: hexToBig(gasPriceHex).toString() };
}

export interface ValidatorInfo {
  address: string;
  proposedBlockCount: number | null;
  lastProposedBlock: number | null;
  recentlyProposed: boolean;
}

export async function getValidators(): Promise<{ count: number; head: number; validators: ValidatorInfo[] }> {
  const [set, metricsRaw, headHex] = await Promise.all([
    rpc<string[]>("qbft_getValidatorsByBlockNumber", ["latest"]),
    rpc<Array<{ address: string; proposedBlockCount: string; lastProposedBlockNumber: string }>>(
      "qbft_getSignerMetrics"
    ).catch(() => [] as Array<{ address: string; proposedBlockCount: string; lastProposedBlockNumber: string }>),
    rpc<string>("eth_blockNumber"),
  ]);
  const head = hexToNum(headHex);
  const byAddr = new Map(metricsRaw.map((m) => [m.address.toLowerCase(), m]));
  const validators: ValidatorInfo[] = set.map((addr) => {
    const m = byAddr.get(addr.toLowerCase());
    const last = m ? num(m.lastProposedBlockNumber) : null;
    return {
      address: addr,
      proposedBlockCount: m ? num(m.proposedBlockCount) : null,
      lastProposedBlock: last,
      // "recent" if it proposed within the last ~4 rounds (4 validators)
      recentlyProposed: last != null && head - last <= set.length * 2,
    };
  });
  return { count: set.length, head, validators };
}

export interface AccountInfo {
  label: string;
  address: string;
  balanceEth: string;
  nonce: number;
  zeroBalance: boolean;
}

export async function getAccounts(): Promise<AccountInfo[]> {
  return Promise.all(
    config.watchAccounts.map(async (a) => {
      const [balHex, nonceHex] = await Promise.all([
        rpc<string>("eth_getBalance", [a.address, "latest"]),
        rpc<string>("eth_getTransactionCount", [a.address, "latest"]),
      ]);
      const bal = hexToBig(balHex);
      return {
        label: a.label,
        address: a.address,
        balanceEth: weiToEth(bal),
        nonce: hexToNum(nonceHex),
        zeroBalance: bal === 0n,
      };
    })
  );
}

export interface RpcTierInfo {
  endpoint: string;
  up: boolean;
  block: number | null;
  peers: number | null;
  syncing: boolean;
}

// RPC-tier health is read from the LB endpoint the API already reaches over the
// mesh (10.43.0.21:8545) — peers/syncing/block. This avoids recreating hara-lb
// (the sole RPC ingress) just to expose HAProxy's 127.0.0.1-only stats port.
// (Per-backend UP/DOWN would need stats published on the mesh — see compose note.)
export async function getRpcTier(): Promise<RpcTierInfo> {
  const [blockHex, peersHex, syncing] = await Promise.all([
    rpc<string>("eth_blockNumber"),
    rpc<string>("net_peerCount").catch(() => null),
    rpc<unknown>("eth_syncing").catch(() => false),
  ]);
  return {
    endpoint: config.rpcUrl,
    up: true,
    block: hexToNum(blockHex),
    peers: peersHex ? hexToNum(peersHex) : null,
    syncing: syncing !== false,
  };
}

export async function getServices(): Promise<{ indexerLag: number | null; indexedBlock: number | null; chainHead: number | null }> {
  const res = await fetchT(config.indexerMetricsUrl);
  if (!res.ok) throw new Error(`indexer metrics HTTP ${res.status}`);
  const text = await res.text();
  const pick = (metric: string): number | null => {
    const m = text.match(new RegExp(`^${metric}\\s+([0-9.eE+-]+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  const indexed = pick("hara_indexer_last_indexed_block");
  const head = pick("hara_indexer_chain_head_block");
  return {
    indexedBlock: indexed,
    chainHead: head,
    indexerLag: indexed != null && head != null ? head - indexed : null,
  };
}

export async function getVault(): Promise<{ sealed: boolean; threshold: number; shares: number; progress: number; version?: string }> {
  const res = await fetchT(`${config.vaultAddr}/v1/sys/seal-status`);
  if (!res.ok) throw new Error(`Vault HTTP ${res.status}`);
  const j = (await res.json()) as { sealed: boolean; t: number; n: number; progress: number; version?: string };
  return { sealed: j.sealed, threshold: j.t, shares: j.n, progress: j.progress, version: j.version };
}

export interface AlertInfo {
  name: string;
  severity: string;
  state: string;
  startsAt: string;
}

export async function getAlerts(): Promise<AlertInfo[]> {
  const res = await fetchT(`${config.alertmanagerUrl}/api/v2/alerts`);
  if (!res.ok) throw new Error(`Alertmanager HTTP ${res.status}`);
  const arr = (await res.json()) as Array<{
    labels: Record<string, string>;
    status: { state: string };
    startsAt: string;
  }>;
  return arr.map((a) => ({
    name: a.labels.alertname ?? "(unnamed)",
    severity: a.labels.severity ?? "none",
    state: a.status?.state ?? "unknown",
    startsAt: a.startsAt,
  }));
}

export interface BackupTimerRaw {
  unit: string;
  service: string | null;
  nextRun: string | null;
  lastRun: string | null;
  result: string | null;
  exitStatus: string | null;
  // Added by the enriched agent; older agents omit these (treated as null).
  durationSec?: number | null;
  activeState?: string | null;
  artifactBytes?: number | null;
  artifactAt?: string | null;
}
export interface DrillResult {
  drill: string;
  status: string | null; // "pass" | "fail"
  at: string | null;
  durationSec: number | null;
}
export interface BackupHost {
  host: string;
  generatedAt: string;
  timers: BackupTimerRaw[];
  drills?: DrillResult[];
}

/** Aggregate every backups-status agent; include reachable hosts, note the rest. */
export async function getBackups(): Promise<{ hosts: BackupHost[]; unreachable: number }> {
  if (config.backupsAgentUrls.length === 0)
    throw new Error("no backups-status agents configured (set BACKUPS_AGENT_URLS)");

  const settled = await Promise.allSettled(
    config.backupsAgentUrls.map(async (url) => {
      const res = await fetchT(url);
      if (!res.ok) throw new Error(`agent HTTP ${res.status}`);
      return (await res.json()) as BackupHost;
    })
  );
  const hosts = settled.filter((s): s is PromiseFulfilledResult<BackupHost> => s.status === "fulfilled").map((s) => s.value);
  const unreachable = settled.length - hosts.length;
  if (hosts.length === 0) throw new Error(`no backups agents reachable (${unreachable} configured)`);
  return { hosts, unreachable };
}

// ── Backups report (dedicated /api/backups) ──────────────────────────────────
// Expected run cadence per backup kind, used to flag "overdue" (a silently-
// stopped backup is the dangerous failure mode). Keyed by unit base name; a
// 1.3× grace is applied before a backup is called overdue.
const EXPECTED_INTERVAL_HOURS: Record<string, number> = {
  "hara-postgres-wal-snapshot": 10 / 60, // every 10 min
  "hara-postgres-snapshot": 24,
  "hara-postgres-basebackup-snapshot": 24,
  "hara-redis-snapshot": 24,
  "hara-minio-snapshot": 24,
  "hara-vault-snapshot": 24,
  "hara-validator-snapshot": 24,
};
const OVERDUE_GRACE = 1.3;

export type BackupHealth = "ok" | "failed" | "overdue" | "never" | "unknown";

// DR category each job belongs to (the console groups by this).
//  backup      = off-host encrypted logical/object copy
//  snapshot    = point-in-time physical snapshot
//  replication = continuous shipping (the WAL stream → S3)
export type DrCategory = "backup" | "snapshot" | "replication";
const CATEGORY: Record<string, DrCategory> = {
  "hara-postgres-snapshot": "backup",
  "hara-redis-snapshot": "backup",
  "hara-minio-snapshot": "backup",
  "hara-vault-snapshot": "backup",
  "hara-postgres-basebackup-snapshot": "snapshot",
  "hara-validator-snapshot": "snapshot",
  "hara-postgres-wal-snapshot": "replication",
};

export interface BackupJob extends BackupTimerRaw {
  host: string;
  base: string; // unit without ".timer"
  category: DrCategory;
  expectedIntervalHours: number | null;
  ageHours: number | null;
  overdue: boolean;
  health: BackupHealth;
}

export interface DrReplication {
  method: string;
  walLastShipAt: string | null;
  walLagMinutes: number | null;
  healthy: boolean;
  rpoMinutes: number;
  streamingReplica: "configured" | "not configured";
}
export interface DrFailover {
  model: string;
  configured: boolean;
  standbyHost: string | null;
  standbyAwake: boolean | null; // null = unknown / not probed
  note: string;
}
export interface DrRecovery {
  scheduled: boolean; // is a recovery-drill timer installed?
  drills: Array<DrillResult & { host: string; ageHours: number | null }>;
  lastPass: string | null;
  anyFail: boolean;
}
export interface BackupsReport {
  generatedAt: string;
  hosts: number;
  unreachable: number;
  jobs: BackupJob[];
  summary: { total: number; ok: number; failed: number; overdue: number; never: number; oldestSuccessAgeHours: number | null };
  dr: { replication: DrReplication; failover: DrFailover; recovery: DrRecovery };
}

function classify(t: BackupTimerRaw, nowMs: number): { ageHours: number | null; expected: number | null; overdue: boolean; health: BackupHealth } {
  const base = t.unit.replace(/\.timer$/, "");
  const expected = EXPECTED_INTERVAL_HOURS[base] ?? null;
  const ageHours = t.lastRun ? (nowMs - new Date(t.lastRun).getTime()) / 3.6e6 : null;
  const failed = !!(t.result && t.result !== "success");
  const overdue = expected != null && ageHours != null && ageHours > expected * OVERDUE_GRACE && !failed;
  let health: BackupHealth;
  if (!t.lastRun) health = "never";
  else if (failed) health = "failed";
  else if (overdue) health = "overdue";
  else if (t.result === "success") health = "ok";
  else health = "unknown";
  return { ageHours, expected, overdue, health };
}

/** Rich, computed backup status for the dedicated Backups screen. */
/** Probe the standby's health endpoint (only when configured + awake). */
async function probeStandby(): Promise<boolean | null> {
  if (!config.standby.healthUrl) return null;
  try {
    const res = await fetchT(config.standby.healthUrl);
    return res.ok;
  } catch {
    return false; // configured but unreachable → asleep / down
  }
}

export async function getBackupsReport(nowMs: number = Date.now()): Promise<BackupsReport> {
  const { hosts, unreachable } = await getBackups();
  const jobs: BackupJob[] = [];
  let drillScheduled = false;
  const drills: Array<DrillResult & { host: string; ageHours: number | null }> = [];
  for (const h of hosts) {
    for (const t of h.timers) {
      const base = t.unit.replace(/\.timer$/, "");
      // The recovery-drill timer matches the agent glob but isn't a backup job —
      // it drives the Recovery panel, not the backup/snapshot lists.
      if (base === "hara-drill-snapshot") {
        drillScheduled = true;
        continue;
      }
      const { ageHours, expected, overdue, health } = classify(t, nowMs);
      jobs.push({
        ...t,
        host: h.host,
        base,
        category: CATEGORY[base] ?? "backup",
        expectedIntervalHours: expected,
        ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
        overdue,
        health,
      });
    }
    for (const d of h.drills ?? []) {
      drills.push({ ...d, host: h.host, ageHours: d.at ? Math.round(((nowMs - new Date(d.at).getTime()) / 3.6e6) * 10) / 10 : null });
    }
  }
  jobs.sort((a, b) => {
    const rank: Record<BackupHealth, number> = { failed: 0, overdue: 1, never: 2, unknown: 3, ok: 4 };
    return rank[a.health] - rank[b.health] || a.host.localeCompare(b.host) || a.base.localeCompare(b.base);
  });
  const okAges = jobs.filter((j) => j.health === "ok" && j.ageHours != null).map((j) => j.ageHours as number);

  // ── DR summary ──────────────────────────────────────────────────────────────
  const wal = jobs.find((j) => j.base === "hara-postgres-wal-snapshot");
  const replication: DrReplication = {
    method: "Async WAL archive → Nevacloud S3 (every 10 min)",
    walLastShipAt: wal?.lastRun ?? null,
    walLagMinutes: wal?.ageHours != null ? Math.round(wal.ageHours * 60) : null,
    healthy: wal?.health === "ok",
    rpoMinutes: config.standby.rpoMinutes,
    streamingReplica: "not configured",
  };
  const standbyAwake = await probeStandby();
  const failover: DrFailover = {
    model: "Cold/sleeping standby — restores base + replays WAL from S3, operator-promoted",
    configured: !!config.standby.host,
    standbyHost: config.standby.host || null,
    standbyAwake,
    note: config.standby.host
      ? "Standby provisioned; wakes on emergency and replays from S3 (RPO ≈ WAL cadence)."
      : "No standby VPS provisioned yet — failover is a manual restore-from-S3 to a new host.",
  };
  const passDrills = drills.filter((d) => d.status === "pass" && d.at).map((d) => d.at as string).sort();
  const recovery: DrRecovery = {
    scheduled: drillScheduled,
    drills,
    lastPass: passDrills.length ? passDrills[passDrills.length - 1] : null,
    anyFail: drills.some((d) => d.status === "fail"),
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    hosts: hosts.length,
    unreachable,
    jobs,
    summary: {
      total: jobs.length,
      ok: jobs.filter((j) => j.health === "ok").length,
      failed: jobs.filter((j) => j.health === "failed").length,
      overdue: jobs.filter((j) => j.health === "overdue").length,
      never: jobs.filter((j) => j.health === "never").length,
      oldestSuccessAgeHours: okAges.length ? Math.max(...okAges) : null,
    },
    dr: { replication, failover, recovery },
  };
}
