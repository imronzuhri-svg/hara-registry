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

export interface BackendInfo {
  proxy: string;
  server: string;
  status: string;
}

export async function getRpcTier(): Promise<BackendInfo[]> {
  const res = await fetchT(config.haproxyStatsUrl);
  if (!res.ok) throw new Error(`HAProxy HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("empty HAProxy stats");
  const header = lines[0].replace(/^# /, "").split(",");
  const iName = header.indexOf("pxname");
  const iSvr = header.indexOf("svname");
  const iStatus = header.indexOf("status");
  return lines
    .slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[iSvr] && c[iSvr] !== "FRONTEND")
    .map((c) => ({ proxy: c[iName], server: c[iSvr], status: c[iStatus] }));
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

export interface BackupHost {
  host: string;
  generatedAt: string;
  timers: Array<{
    unit: string;
    service: string | null;
    nextRun: string | null;
    lastRun: string | null;
    result: string | null;
    exitStatus: string | null;
  }>;
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
