import { useEffect, useState, type ReactNode } from "react";
import { StrataMark } from "./components/StrataMark";
import { Panel, StatusPill, Stat } from "./components/Panel";
import { Operations } from "./components/Operations";
import { AuditLog } from "./components/AuditLog";
import { TimeSeries } from "./components/TimeSeries";
import { useOverview } from "./hooks/useOverview";
import { fetchAnomalies, type Anomaly, type Section } from "./lib/api";

type View = "dashboard" | "chain" | "validators" | "rpc" | "services" | "alerts" | "backups" | "vault" | "operations" | "audit";

const NAV: { item: string; view: View }[] = [
  { item: "Dashboard", view: "dashboard" },
  { item: "Chain", view: "chain" },
  { item: "Validators", view: "validators" },
  { item: "RPC Tier", view: "rpc" },
  { item: "Services", view: "services" },
  { item: "Alerts", view: "alerts" },
  { item: "Backups & DR", view: "backups" },
  { item: "Vault", view: "vault" },
  { item: "Treasury · Governance (Ops)", view: "operations" },
  { item: "Audit Log", view: "audit" },
];

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function S<T>({ section, children }: { section: Section<T> | undefined; children: (d: T) => ReactNode }) {
  if (!section) return <Muted text="connecting…" />;
  if (section.available) return <>{children(section.data)}</>;
  return <Muted text={`unavailable — ${section.error}`} />;
}
function Muted({ text }: { text: string }) {
  return <p className="text-sm text-mist-1/45">{text}</p>;
}
function sectionPill(section: Section<unknown> | undefined) {
  if (!section) return <StatusPill tone="idle" label="connecting" />;
  return section.available ? <StatusPill tone="ok" label="live" /> : <StatusPill tone="idle" label="no data" />;
}
function ChartGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>;
}
function PendingExporter({ what }: { what: string }) {
  return (
    <Panel title="Time-series" subtitle="not yet available" status={<StatusPill tone="idle" label="exporter off" />}>
      <Muted text={`Charts here need the ${what} exposed to Prometheus (not scraped today). Enabling it is a small config + scrape job — ask ops to turn it on.`} />
    </Panel>
  );
}

type OverviewData = ReturnType<typeof useOverview>["data"];

export default function App() {
  const { data, connected, error } = useOverview();
  const [active, setActive] = useState<View>("dashboard");
  const chainOk = data?.chain.available ?? false;
  const headTone = connected ? (chainOk ? "ok" : "warn") : "down";
  const headLabel = connected ? (chainOk ? "live" : "degraded") : "offline";

  return (
    <div className="min-h-full font-body">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-700 bg-ink-900/80 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <StrataMark size={34} live={chainOk} />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold text-mist-0">
              HARA <span className="text-brand-teal">Registry</span> Console
            </div>
            <div className="text-[11px] uppercase tracking-widest text-mist-1/40">Strata · operations</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill tone={headTone} label={`api ${headLabel}`} />
          <span className="rounded-full bg-ink-700 px-3 py-1 text-xs text-mist-1/70 ring-1 ring-ink-700">did:hara · Numira (stub)</span>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-6">
        <nav className="hidden w-52 shrink-0 lg:block">
          <ul className="space-y-1 text-sm">
            {NAV.map(({ item, view }) => (
              <li key={item}>
                <button
                  onClick={() => setActive(view)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left ${
                    active === view ? "bg-strata text-white" : "text-mist-1/70 hover:bg-ink-800 hover:text-mist-0"
                  }`}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
          {error && !connected && (
            <p className="mt-4 px-3 text-[11px] text-accent-orange/80">
              Console API not reachable — run <code>pnpm --dir server start</code>.
            </p>
          )}
        </nav>

        <main className="flex-1 space-y-5">
          <AnomalyBanner onJump={setActive} />
          {active === "dashboard" && <Dashboard data={data} />}
          {active === "chain" && <ChainScreen data={data} />}
          {active === "validators" && <ValidatorsScreen data={data} />}
          {active === "rpc" && <RpcScreen data={data} />}
          {active === "services" && <ServicesScreen data={data} />}
          {active === "alerts" && <AlertsScreen data={data} />}
          {active === "backups" && <BackupsScreen data={data} />}
          {active === "vault" && <VaultScreen data={data} />}
          {active === "operations" && <Operations />}
          {active === "audit" && <AuditLog />}
        </main>
      </div>
    </div>
  );
}

// ── Anomaly banner ───────────────────────────────────────────────────────────
function AnomalyBanner({ onJump }: { onJump: (v: View) => void }) {
  const [items, setItems] = useState<Anomaly[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => fetchAnomalies().then((a) => alive && setItems(a)).catch(() => {});
    load();
    const h = setInterval(load, 20000);
    return () => { alive = false; clearInterval(h); };
  }, []);
  if (items.length === 0) return null;
  const worst = items.some((i) => i.level === "critical") ? "critical" : items.some((i) => i.level === "warn") ? "warn" : "info";
  const tone = worst === "critical" ? "border-red-500/40 bg-red-500/10" : worst === "warn" ? "border-accent-orange/40 bg-accent-orange/10" : "border-brand-blue/40 bg-brand-blue/10";
  const areaToView: Record<string, View> = { chain: "chain", services: "services", backups: "backups", validators: "validators", alerts: "alerts" };
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="mb-1 font-display text-sm font-semibold text-mist-0">⚠ {items.length} anomaly signal{items.length > 1 ? "s" : ""}</div>
      <ul className="space-y-1 text-sm text-mist-1/80">
        {items.map((a, i) => (
          <li key={i}>
            <button onClick={() => onJump(areaToView[a.area] ?? "dashboard")} className="hover:text-mist-0">
              <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] uppercase ${a.level === "critical" ? "bg-red-500/30 text-red-200" : a.level === "warn" ? "bg-accent-orange/30 text-accent-orange" : "bg-brand-blue/30 text-brand-blue"}`}>{a.level}</span>
              {a.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Reusable panels ──────────────────────────────────────────────────────────
function ChainPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Chain" subtitle="QBFT · Besu" status={sectionPill(data?.chain)}>
      <S section={data?.chain}>
        {(c) => (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Chain ID" value={c.chainId} />
            <Stat label="Latest block" value={c.block.toLocaleString()} />
            <Stat label="Block time" value={c.blockTimeSec != null ? `${c.blockTimeSec}s` : "—"} />
            <Stat label="Gas price" value={c.gasPrice} hint="free-gas chain" />
          </div>
        )}
      </S>
    </Panel>
  );
}
function ValidatorsPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Validators" subtitle="QBFT · quorum 3/4" status={sectionPill(data?.validators)}>
      <S section={data?.validators}>
        {(v) => (
          <ul className="space-y-2">
            {v.validators.map((val) => (
              <li key={val.address} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                <span className="font-mono text-mist-1/80">{shortAddr(val.address)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-mist-1/45">{val.proposedBlockCount ?? "—"} blocks</span>
                  <StatusPill tone={val.recentlyProposed ? "ok" : "warn"} label={val.recentlyProposed ? "proposing" : "stale"} />
                </span>
              </li>
            ))}
            <li className="pt-1 text-xs text-mist-1/40">{v.count} validators · head {v.head.toLocaleString()}</li>
          </ul>
        )}
      </S>
    </Panel>
  );
}
function RpcPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="RPC Tier" subtitle="hara-rpc-1 · LB endpoint" status={sectionPill(data?.rpcTier)}>
      <S section={data?.rpcTier}>
        {(r) => (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Endpoint" value={r.up ? "UP" : "DOWN"} />
            <Stat label="Peers" value={r.peers ?? "—"} />
            <Stat label="Syncing" value={r.syncing ? "yes" : "no"} />
            <Stat label="Block" value={r.block?.toLocaleString() ?? "—"} />
          </div>
        )}
      </S>
    </Panel>
  );
}
function ServicesPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Services" subtitle="indexer lag" status={sectionPill(data?.services)}>
      <S section={data?.services}>
        {(s) => (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Indexer lag" value={s.indexerLag != null ? `${s.indexerLag} blk` : "—"} />
            <Stat label="Indexed block" value={s.indexedBlock?.toLocaleString() ?? "—"} />
            <Stat label="Chain head" value={s.chainHead?.toLocaleString() ?? "—"} />
          </div>
        )}
      </S>
    </Panel>
  );
}
function AccountsPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Account Watchlist" subtitle="zero-balance guard" status={sectionPill(data?.accounts)}>
      <S section={data?.accounts}>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.address} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                <span>
                  <span className="text-mist-1/80">{a.label}</span> <span className="font-mono text-xs text-mist-1/40">{shortAddr(a.address)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-mist-1/55">{a.balanceEth} HARA</span>
                  {a.zeroBalance && <StatusPill tone="down" label="ZERO" />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </S>
    </Panel>
  );
}
function VaultPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Vault" subtitle="Raft · 3-of-5 unseal" status={sectionPill(data?.vault)}>
      <S section={data?.vault}>
        {(v) => (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Seal status" value={v.sealed ? "SEALED" : "unsealed"} />
            <Stat label="Unseal" value={`${v.progress}/${v.threshold}`} hint={`${v.shares} shares`} />
            {v.version && <Stat label="Version" value={v.version} />}
          </div>
        )}
      </S>
    </Panel>
  );
}
function BackupsPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Backups & DR" subtitle="age + rclone → S3" status={sectionPill(data?.backups)}>
      <S section={data?.backups}>
        {(b) => (
          <ul className="space-y-2">
            {b.hosts.flatMap((h) =>
              h.timers.map((t) => (
                <li key={`${h.host}/${t.unit}`} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                  <span>
                    <span className="text-mist-1/80">{t.unit.replace(/\.timer$/, "")}</span> <span className="text-xs text-mist-1/40">@ {h.host}</span>
                  </span>
                  <StatusPill tone={t.result === "success" ? "ok" : t.lastRun ? "down" : "idle"} label={t.result ?? "scheduled"} />
                </li>
              ))
            )}
            {b.unreachable > 0 && <li className="pt-1 text-xs text-accent-orange/70">{b.unreachable} agent(s) unreachable</li>}
          </ul>
        )}
      </S>
    </Panel>
  );
}
function AlertsPanel({ data }: { data: OverviewData }) {
  return (
    <Panel title="Alerts" subtitle="Alertmanager" status={sectionPill(data?.alerts)}>
      <S section={data?.alerts}>
        {(rows) =>
          rows.length === 0 ? (
            <Muted text="no active alerts" />
          ) : (
            <ul className="space-y-2">
              {rows.map((al, i) => (
                <li key={`${al.name}-${i}`} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                  <span className="text-mist-1/80">{al.name}</span>
                  <StatusPill tone={al.severity === "critical" ? "down" : "warn"} label={al.severity} />
                </li>
              ))}
            </ul>
          )
        }
      </S>
    </Panel>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────
function Dashboard({ data }: { data: OverviewData }) {
  return (
    <>
      <ChartGrid>
        <TimeSeries series="blockRate" minutes={60} />
        <TimeSeries series="indexerLag" minutes={60} />
      </ChartGrid>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        <ChainPanel data={data} />
        <ValidatorsPanel data={data} />
        <RpcPanel data={data} />
        <ServicesPanel data={data} />
        <AccountsPanel data={data} />
        <VaultPanel data={data} />
        <BackupsPanel data={data} />
        <AlertsPanel data={data} />
      </div>
    </>
  );
}
function ChainScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <ChainPanel data={data} />
      <ChartGrid>
        <TimeSeries series="blockRate" />
        <TimeSeries series="chainHeight" />
        <TimeSeries series="eventRate" />
      </ChartGrid>
    </>
  );
}
function ServicesScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <ServicesPanel data={data} />
      <ChartGrid>
        <TimeSeries series="indexerLag" />
        <TimeSeries series="batchMs" />
        <TimeSeries series="eventRate" />
        <TimeSeries series="errorRate" />
        <TimeSeries series="eventloopP90" />
        <TimeSeries series="indexerMem" />
      </ChartGrid>
    </>
  );
}
function AlertsScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <AlertsPanel data={data} />
      <ChartGrid>
        <TimeSeries series="alertsFiring" minutes={180} />
      </ChartGrid>
    </>
  );
}
function ValidatorsScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <ValidatorsPanel data={data} />
      <ChartGrid>
        <TimeSeries series="validatorPeers" />
        <TimeSeries series="validatorHeight" />
        <TimeSeries series="validatorInSync" />
        <TimeSeries series="txpool" />
      </ChartGrid>
    </>
  );
}
function RpcScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <RpcPanel data={data} />
      <ChartGrid>
        <TimeSeries series="rpcReqRate" />
        <TimeSeries series="rpcSessions" />
        <TimeSeries series="rpc5xx" />
        <TimeSeries series="rpcPeers" />
      </ChartGrid>
    </>
  );
}
function VaultScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <VaultPanel data={data} />
      <PendingExporter what="Vault telemetry (Prometheus format) enabled in the Vault config" />
    </>
  );
}
function BackupsScreen({ data }: { data: OverviewData }) {
  return (
    <>
      <BackupsPanel data={data} />
      <Panel title="About these backups" subtitle="event-based, not a time-series">
        <Muted text="Each host's agent reports its hara-*-snapshot timer (next/last run + systemd Result). Backups are discrete nightly events — the table above is the right view. A 'time-since-last-success' chart could be added later." />
      </Panel>
    </>
  );
}
