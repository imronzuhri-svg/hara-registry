import { useEffect, useState, type ReactNode } from "react";
import { StrataMark } from "./components/StrataMark";
import { Panel, StatusPill, Stat } from "./components/Panel";
import { Operations } from "./components/Operations";
import { AuditLog } from "./components/AuditLog";
import { TimeSeries } from "./components/TimeSeries";
import { useOverview } from "./hooks/useOverview";
import { fetchAnomalies, fetchSilences, silenceAlert, unsilence, fetchInsights, copilotConfigured, askCopilot, ago, rel, type Anomaly, type Section, type Silence, type Insights } from "./lib/api";

type View = "dashboard" | "insights" | "copilot" | "chain" | "validators" | "rpc" | "services" | "alerts" | "backups" | "vault" | "operations" | "audit" | "help";

const NAV: { item: string; view: View }[] = [
  { item: "Dashboard", view: "dashboard" },
  { item: "Insights", view: "insights" },
  { item: "Copilot", view: "copilot" },
  { item: "Chain", view: "chain" },
  { item: "Validators", view: "validators" },
  { item: "RPC Tier", view: "rpc" },
  { item: "Services", view: "services" },
  { item: "Alerts", view: "alerts" },
  { item: "Backups & DR", view: "backups" },
  { item: "Vault", view: "vault" },
  { item: "Treasury · Governance (Ops)", view: "operations" },
  { item: "Audit Log", view: "audit" },
  { item: "Help & Guide", view: "help" },
];

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Plain-language help for each panel (shown via the "?" toggle).
const HELP: Record<string, ReactNode> = {
  chain: (
    <>
      <b>What it is:</b> the blockchain itself — every transaction lands here. <b>Watch:</b> "Latest block" should keep climbing and "Block time" should stay near ~2s. <b>Good:</b> block time steady ~2s. <b>Bad:</b> block time growing or block number frozen = the chain is stalling.
    </>
  ),
  validators: (
    <>
      <b>What it is:</b> the 4 computers that take turns producing & signing blocks (QBFT). The chain needs <b>3 of 4</b> healthy. <b>Watch:</b> each should say "proposing"; "stale" means one stopped taking its turn. <b>Good:</b> all 4 proposing, peers ≈ healthy. <b>Bad:</b> 2+ stale = the chain can halt.
    </>
  ),
  rpc: (
    <>
      <b>What it is:</b> the front door apps use to read/write the chain (load balancer + nodes). <b>Watch:</b> "UP", request rate, and 5xx (errors). <b>Good:</b> UP, syncing "no", 0 errors. <b>Bad:</b> rising 5xx or syncing "yes" for long = clients getting errors/stale reads.
    </>
  ),
  services: (
    <>
      <b>What it is:</b> the indexer that reads the chain into the database powering the explorer & traceability API. <b>Watch:</b> "Indexer lag" (how many blocks behind). <b>Good:</b> lag 0–2. <b>Bad:</b> lag climbing = the API/explorer is showing stale data.
    </>
  ),
  accounts: (
    <>
      <b>What it is:</b> the funded accounts we care about (admin, deployers, partners). <b>Why:</b> on this free-gas chain a <b>zero-balance</b> account silently can't send — its transactions vanish. <b>Watch:</b> a red "ZERO" tag = fund it before that account is used.
    </>
  ),
  vault: (
    <>
      <b>What it is:</b> the secure store for all keys/secrets. After any restart it must be "unsealed" with 3 of 5 keys. <b>Watch:</b> seal status. <b>Good:</b> "unsealed". <b>Bad:</b> "SEALED" = services can't fetch secrets until an operator unseals it.
    </>
  ),
  backups: (
    <>
      <b>What it is:</b> nightly encrypted backups shipped off-site (Postgres, Vault, each validator). <b>Watch:</b> the result tag + "last run". <b>Good:</b> all "success" with a recent last-run. <b>Bad:</b> "exit-code" = that backup failed; check it didn't silently stop protecting you.
    </>
  ),
  alerts: (
    <>
      <b>What it is:</b> automated warnings from the monitoring system. They <b>clear themselves</b> when the problem resolves — no need to mark them done. <b>To quiet one</b> during planned work, use "mute 1h/24h" (it shows under Silences). <b>Severity:</b> critical = act now; warning = look soon.
    </>
  ),
  insights: (
    <>
      <b>What it is:</b> the intelligence layer — it reads all the numbers and tells you, in plain language, what to look at, optimise, or pre-empt. <b>Includes:</b> statistical baselines (drift before a hard alert), forecasts, RPC reliability (SLO) + cache efficiency, validator fairness, and capacity vs the 45-month plan. <b>Read the Recommendations first.</b> It only advises — you act via Operations.
    </>
  ),
  copilot: (
    <>
      <b>What it is:</b> an assistant you can ask in plain English ("is everything healthy?", "why are backups failing?"). It answers from the <b>live</b> state and points you to the right screen/action — it <b>can't run anything</b>. Needs an API key configured; otherwise it shows "not configured".
    </>
  ),
};

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
          {active === "insights" && <InsightsScreen />}
          {active === "copilot" && <CopilotScreen />}
          {active === "chain" && <ChainScreen data={data} />}
          {active === "validators" && <ValidatorsScreen data={data} />}
          {active === "rpc" && <RpcScreen data={data} />}
          {active === "services" && <ServicesScreen data={data} />}
          {active === "alerts" && <AlertsScreen data={data} />}
          {active === "backups" && <BackupsScreen data={data} />}
          {active === "vault" && <VaultScreen data={data} />}
          {active === "operations" && <Operations />}
          {active === "audit" && <AuditLog />}
          {active === "help" && <HelpScreen onJump={setActive} />}
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
  const evalAt = items[0]?.at;
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-display text-sm font-semibold text-mist-0">⚠ {items.length} anomaly signal{items.length > 1 ? "s" : ""}</span>
        {evalAt && <span className="text-[11px] text-mist-1/45" title={evalAt}>evaluated {ago(evalAt)} · clears automatically when resolved</span>}
      </div>
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
    <Panel title="Chain" subtitle="QBFT · Besu" status={sectionPill(data?.chain)} help={HELP.chain}>
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
    <Panel title="Validators" subtitle="QBFT · quorum 3/4" status={sectionPill(data?.validators)} help={HELP.validators}>
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
    <Panel title="RPC Tier" subtitle="hara-rpc-1 · LB endpoint" status={sectionPill(data?.rpcTier)} help={HELP.rpc}>
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
    <Panel title="Services" subtitle="indexer lag" status={sectionPill(data?.services)} help={HELP.services}>
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
    <Panel title="Account Watchlist" subtitle="zero-balance guard" status={sectionPill(data?.accounts)} help={HELP.accounts}>
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
    <Panel title="Vault" subtitle="Raft · 3-of-5 unseal" status={sectionPill(data?.vault)} help={HELP.vault}>
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
    <Panel title="Backups & DR" subtitle="age + rclone → S3" status={sectionPill(data?.backups)} help={HELP.backups}>
      <S section={data?.backups}>
        {(b) => (
          <ul className="space-y-2">
            {b.hosts.flatMap((h) =>
              h.timers.map((t) => (
                <li key={`${h.host}/${t.unit}`} className="flex items-center justify-between gap-3 rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="text-mist-1/80">{t.unit.replace(/\.timer$/, "")}</span> <span className="text-xs text-mist-1/40">@ {h.host}</span>
                    <span className="mt-0.5 block text-xs text-mist-1/40">
                      last run <span title={t.lastRun ?? ""}>{t.lastRun ? ago(t.lastRun) : "never"}</span>
                      {" · next "}<span title={t.nextRun ?? ""}>{rel(t.nextRun)}</span>
                    </span>
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
function SilenceButtons({ alertname }: { alertname: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const doSilence = async (h: number) => {
    setBusy(`${h}`);
    try {
      await silenceAlert(alertname, h, "silenced from console");
    } catch {
      /* ignore; poll will reflect */
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="flex items-center gap-1">
      {[1, 24].map((h) => (
        <button
          key={h}
          onClick={() => doSilence(h)}
          disabled={!!busy}
          title={`Silence ${alertname} for ${h}h`}
          className="rounded-md bg-ink-700 px-2 py-1 text-[11px] text-mist-1/70 hover:bg-accent-orange/30 hover:text-accent-orange disabled:opacity-50"
        >
          {busy === `${h}` ? "…" : `mute ${h}h`}
        </button>
      ))}
    </span>
  );
}

function AlertsPanel({ data, silenceable = false }: { data: OverviewData; silenceable?: boolean }) {
  return (
    <Panel title="Alerts" subtitle="Alertmanager · auto-resolves when cleared" status={sectionPill(data?.alerts)} help={HELP.alerts}>
      <S section={data?.alerts}>
        {(rows) =>
          rows.length === 0 ? (
            <Muted text="no active alerts — anything that fires clears automatically when its condition resolves" />
          ) : (
            <ul className="space-y-2">
              {rows.map((al, i) => (
                <li key={`${al.name}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="text-mist-1/80">{al.name}</span>
                    {al.startsAt && (
                      <span className="ml-2 text-xs text-mist-1/40" title={al.startsAt}>
                        firing {ago(al.startsAt)}
                      </span>
                    )}
                    {al.state === "suppressed" && <span className="ml-2 rounded bg-mist-1/10 px-1.5 py-0.5 text-[10px] text-mist-1/50">silenced</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {silenceable && al.state !== "suppressed" && <SilenceButtons alertname={al.name} />}
                    <StatusPill tone={al.severity === "critical" ? "down" : "warn"} label={al.severity} />
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </S>
    </Panel>
  );
}

function SilencesPanel() {
  const [silences, setSilences] = useState<Silence[] | null>(null);
  const load = () => fetchSilences().then(setSilences).catch(() => setSilences([]));
  useEffect(() => {
    load();
    const h = setInterval(load, 15000);
    return () => clearInterval(h);
  }, []);
  return (
    <Panel title="Silences" subtitle="muted alerts (acknowledge / ignore)">
      {silences === null ? (
        <Muted text="loading…" />
      ) : silences.length === 0 ? (
        <Muted text="no active silences. Use “mute” on an alert to suppress its notifications for a window." />
      ) : (
        <ul className="space-y-2">
          {silences.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="text-mist-1/80">{s.alertname}</span>
                <span className="ml-2 text-xs text-mist-1/40" title={`${s.startsAt} → ${s.endsAt}`}>
                  until {new Date(s.endsAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })} · by {s.createdBy}
                </span>
              </span>
              <button
                onClick={async () => {
                  await unsilence(s.id).catch(() => {});
                  load();
                }}
                className="shrink-0 rounded-md bg-ink-700 px-2 py-1 text-[11px] text-mist-1/70 hover:bg-brand-blue/30"
              >
                unsilence
              </button>
            </li>
          ))}
        </ul>
      )}
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
      <AlertsPanel data={data} silenceable />
      <SilencesPanel />
      <ChartGrid>
        <TimeSeries series="alertsFiring" minutes={180} />
      </ChartGrid>
      <Panel title="How alerts work" subtitle="lifecycle">
        <Muted text="Alerts come from Prometheus rules and auto-resolve the moment their condition clears — there's no manual “mark solved”. To mute one (e.g. during planned work), use “mute 1h/24h”; it appears under Silences and you can unsilence early. Anomaly signals (top banner) are stateless threshold checks re-evaluated every ~20s and vanish on their own when the threshold is no longer breached." />
      </Panel>
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
function CopilotScreen() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [msgs, setMsgs] = useState<{ role: "you" | "strata"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    copilotConfigured().then(setConfigured);
  }, []);

  const examples = [
    "Is the registry healthy right now?",
    "Why might the validator backups be failing?",
    "Are we anywhere near capacity?",
    "Anything I should act on today?",
  ];

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "you", text: q }]);
    setBusy(true);
    try {
      const { answer } = await askCopilot(q);
      setMsgs((m) => [...m, { role: "strata", text: answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "strata", text: `⚠ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title="Operator copilot"
        subtitle="ask in plain language · read-only"
        status={<StatusPill tone={configured ? "ok" : "idle"} label={configured == null ? "…" : configured ? "ready" : "not configured"} />}
        help={<>Phase 4 — an assistant grounded in the live state (chain, validators, backups, vault, insights). It explains and recommends; it <b>cannot run anything</b> — when an action is needed it points you to the Operations tab. Answers are based only on current data.</>}
      >
        {configured === false ? (
          <Muted text="Copilot isn't configured. Set CONSOLE_COPILOT_API_KEY (a Kimi/Moonshot API key) in the console API env and redeploy — then this becomes a live Q&A grounded in the platform's current state." />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {examples.map((e) => (
                <button key={e} onClick={() => ask(e)} disabled={busy || !configured} className="rounded-full bg-ink-700 px-3 py-1 text-xs text-mist-1/70 hover:bg-brand-blue/30 hover:text-mist-0 disabled:opacity-40">
                  {e}
                </button>
              ))}
            </div>
            <div className="mb-3 max-h-[420px] space-y-3 overflow-y-auto">
              {msgs.length === 0 && <Muted text="Ask anything about the registry's current state." />}
              {msgs.map((m, i) => (
                <div key={i} className={m.role === "you" ? "text-right" : ""}>
                  <div className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === "you" ? "bg-strata text-white" : "bg-ink-900/70 text-mist-1/90"}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {busy && <Muted text="thinking…" />}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="e.g. why is indexer lag high?"
                disabled={busy || !configured}
                className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-0 placeholder:text-mist-1/30 focus:border-brand-blue focus:outline-none disabled:opacity-50"
              />
              <button type="submit" disabled={busy || !configured} className="rounded-lg bg-strata px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Ask
              </button>
            </form>
          </>
        )}
      </Panel>
      <p className="px-1 text-[11px] text-mist-1/35">
        Read-only & grounded: the copilot answers from live data and never executes — it points you to Operations (propose-only) for any action. Phase 4 of doc/registry-console-intelligence-roadmap.md.
      </p>
    </div>
  );
}

function InsightsScreen() {
  const [ins, setIns] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchInsights().then((d) => alive && (setIns(d), setError(null))).catch((e) => alive && setError((e as Error).message));
    load();
    const h = setInterval(load, 30000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const sevTone = (s: string) => (s === "critical" ? "down" : s === "warn" ? "warn" : "idle");
  const fmtBytes = (n: number | null) => (n == null ? "—" : `${(n / 1024 / 1024).toFixed(0)}MB`);

  if (error) return <Panel title="Insights" subtitle="intelligence"><Muted text={`unavailable — ${error}`} /></Panel>;
  if (!ins) return <Panel title="Insights" subtitle="intelligence"><Muted text="analysing…" /></Panel>;

  return (
    <div className="space-y-5">
      <Panel
        title="Recommendations"
        subtitle="reliability + optimisation · read-only analysis"
        status={<StatusPill tone="ok" label={`${ins.recommendations.length}`} />}
        help={<>Plain-language conclusions from the live numbers — what to look at, optimise, or pre-empt. Acting on any of these stays human-approved (use the Operations tab to build the command). Re-evaluated every 30s.</>}
      >
        <ul className="space-y-2">
          {ins.recommendations.map((r, i) => (
            <li key={i} className="flex items-start gap-3 rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
              <StatusPill tone={sevTone(r.severity)} label={r.area} />
              <span className="text-mist-1/80">{r.text}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <ChartGrid>
        <Panel title="Statistical baselines" subtitle="z-score vs 2h normal" help={<>Phase 1.1 — learns each metric's normal range and flags drift <b>before</b> a hard threshold. <b>z</b> = how many standard deviations from normal; |z|≥3 = anomalous, ≥2 = elevated.</>}>
          <ul className="space-y-2">
            {ins.baselines.map((b) => (
              <li key={b.key} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                <span className="text-mist-1/80">{b.label}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-mist-1/45">
                    {b.current?.toFixed(1) ?? "—"} <span className="text-mist-1/30">(~{b.mean?.toFixed(1) ?? "—"} · z {b.z?.toFixed(1) ?? "—"})</span>
                  </span>
                  <StatusPill tone={b.status === "anomalous" ? "down" : b.status === "elevated" ? "warn" : "ok"} label={b.status} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Forecasts" subtitle="linear projection +1h" help={<>Phase 1.2 — projects a metric an hour ahead (predict_linear) and flags if it'll cross a safe threshold, turning surprises into scheduled work.</>}>
          <ul className="space-y-2">
            {ins.forecasts.map((f, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                <span className="text-mist-1/80">{f.label}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-mist-1/45">
                    {f.label.includes("memory") ? `${fmtBytes(f.current)} → ${fmtBytes(f.predicted1h)}` : `${f.current?.toFixed(0) ?? "—"} → ${f.predicted1h?.toFixed(0) ?? "—"}`}
                  </span>
                  <StatusPill tone={f.willBreach ? "warn" : "ok"} label={f.willBreach ? "watch" : "ok"} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="RPC SLO & cache" subtitle="error budget + cache efficiency" help={<>Phase 1.4 / 2.1 — request success rate (target 99.9%) and cache hit-rate. Low cache hit = more load on validators; falling success = burning error budget.</>}>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="RPC success" value={ins.slo.successPct != null ? `${ins.slo.successPct.toFixed(3)}%` : "—"} hint={`${ins.slo.errors5xx ?? "—"} total 5xx`} />
            <Stat label="5xx now" value={ins.slo.recent5xxPerMin != null ? `${ins.slo.recent5xxPerMin.toFixed(1)}/min` : "—"} />
            <Stat label="Cache hit" value={ins.cacheHitPct != null ? `${ins.cacheHitPct.toFixed(0)}%` : "—"} hint="rpc-cache" />
          </div>
        </Panel>

        <Panel title="Validator fairness" subtitle="proposing-share balance" help={<>Phase 2.2 — are the 4 validators sharing block production evenly? A lopsided share usually means one node is slow or peering poorly.</>}>
          <div className="mb-2 text-xs text-mist-1/55">verdict: <span className="text-mist-1/80">{ins.fairness.verdict}</span>{ins.fairness.spreadPct != null && ` · spread ${ins.fairness.spreadPct.toFixed(0)}pp`}</div>
          <ul className="space-y-2">
            {ins.fairness.shares.map((s) => (
              <li key={s.address} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                <span className="font-mono text-mist-1/80">{shortAddr(s.address)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-mist-1/45">{s.pct.toFixed(1)}%</span>
                  <StatusPill tone={s.recentlyProposed ? "ok" : "warn"} label={s.recentlyProposed ? "active" : "stale"} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </ChartGrid>

      <Panel
        title="Capacity & growth"
        subtitle="forecast vs the 45-month projection"
        help={<>Phase 3 — compares live throughput & chain growth to the planned workload (25k batches × ~7k transfers over 45 months) and the measured {ins.capacity.capacityTps} TPS ceiling, so capacity needs become dated milestones rather than surprises. (Precise disk-fill needs host metrics, not scraped yet.)</>}
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Stat label="Throughput now" value={ins.capacity.currentTps != null ? `${ins.capacity.currentTps.toFixed(1)} TPS` : "—"} />
          <Stat label="Measured ceiling" value={`${ins.capacity.capacityTps} TPS`} hint="stress-tested" />
          <Stat label="Headroom" value={ins.capacity.headroomPct != null ? `${ins.capacity.headroomPct.toFixed(0)}%` : "—"} />
          <Stat label="Blocks / day" value={ins.capacity.blocksPerDay != null ? ins.capacity.blocksPerDay.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"} />
          <Stat label="Chain height" value={ins.capacity.chainHeight?.toLocaleString() ?? "—"} />
          <Stat label="Events indexed" value={ins.capacity.totalEvents?.toLocaleString() ?? "—"} />
          <Stat label="Plan: batches" value={ins.capacity.targetBatches.toLocaleString()} hint={`${ins.capacity.horizonMonths}-mo target`} />
          <Stat label="Plan: transfers" value={`${(ins.capacity.targetTransfers / 1e6).toFixed(0)}M`} />
          <Stat label="Req. avg TPS" value={`${ins.capacity.requiredAvgTps.toFixed(1)}`} hint="to meet plan" />
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-mist-1/55">
          {ins.capacity.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Panel>

      <Panel title="Backup freshness" subtitle="time since last successful run" help={<>Phase 1.2 — flags any backup that hasn't succeeded recently (a daily backup older than ~26h, or whose last run failed) so a silently-broken backup can't hide.</>}>
        <ul className="space-y-2">
          {ins.backups.length === 0 && <Muted text="no backup agents reachable" />}
          {ins.backups.map((b, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
              <span>
                <span className="text-mist-1/80">{b.unit.replace(/\.timer$/, "")}</span> <span className="text-xs text-mist-1/40">@ {b.host}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-mist-1/45">{b.ageHours != null ? `${b.ageHours.toFixed(0)}h ago` : "never"}</span>
                <StatusPill tone={b.overdue ? "down" : "ok"} label={b.overdue ? "overdue" : "fresh"} />
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="px-1 text-[11px] text-mist-1/35">
        Intelligence Phase 1 (reliability) + Phase 2 (optimisation), read-only. AI suggests; operators decide. Full plan: doc/registry-console-intelligence-roadmap.md
      </p>
    </div>
  );
}

function HelpScreen({ onJump }: { onJump: (v: View) => void }) {
  const areas: { view: View; title: string; key: string }[] = [
    { view: "insights", title: "Insights (intelligence)", key: "insights" },
    { view: "copilot", title: "Copilot", key: "copilot" },
    { view: "chain", title: "Chain", key: "chain" },
    { view: "validators", title: "Validators", key: "validators" },
    { view: "rpc", title: "RPC Tier", key: "rpc" },
    { view: "services", title: "Services / Indexer", key: "services" },
    { view: "dashboard", title: "Account Watchlist", key: "accounts" },
    { view: "vault", title: "Vault", key: "vault" },
    { view: "backups", title: "Backups & DR", key: "backups" },
    { view: "alerts", title: "Alerts", key: "alerts" },
  ];
  return (
    <div className="space-y-5">
      <Panel title="What this console is" subtitle="read me first">
        <div className="space-y-2 text-sm text-mist-1/80">
          <p>
            Strata is the single place to see whether Hara Registry is healthy and to run common operations safely. It only <b>reads</b> and <b>shows</b> — for privileged actions it builds the exact command for an operator to run (it never holds keys).
          </p>
          <p>
            <b>Colour code everywhere:</b> <span className="text-brand-teal">teal = healthy/live</span>, <span className="text-accent-orange">amber = warning, look soon</span>, <span className="text-red-400">red = problem, act now</span>, grey = no data / idle.
          </p>
          <p>
            <b>Two ways trouble surfaces:</b> the <b>anomaly banner</b> at the top (plain-language signals, auto-clears when resolved) and the <b>Alerts</b> screen (from the monitoring rules). Each panel has a <span className="font-bold text-brand-teal">?</span> button explaining what to look at.
          </p>
        </div>
      </Panel>

      <Panel title="Area-by-area guide" subtitle="what each screen tells you">
        <ul className="space-y-3 text-xs leading-relaxed text-mist-1/80">
          {areas.map((a) => (
            <li key={a.title} className="rounded-lg bg-ink-900/50 p-3">
              <button onClick={() => onJump(a.view)} className="font-display text-sm font-semibold text-brand-teal hover:underline">
                {a.title} →
              </button>
              <div className="mt-1">{HELP[a.key]}</div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Glossary" subtitle="plain language">
        <dl className="grid grid-cols-1 gap-2 text-xs text-mist-1/80 md:grid-cols-2">
          {[
            ["Validator / QBFT", "The 4 machines that take turns making blocks and vote to agree. Need 3 of 4 working."],
            ["Block / block time", "A batch of transactions added every ~2 seconds. Steady block time = healthy chain."],
            ["RPC", "The API apps use to talk to the chain — reads and writes go through a load balancer."],
            ["Indexer lag", "How many blocks behind the database is vs the chain. Low = the explorer/API is current."],
            ["Vault seal", "Vault locks its keys when restarted; an operator 'unseals' it with 3 of 5 key shares."],
            ["Anomaly", "An automatic plain-language signal that a number crossed a healthy threshold. Self-clears."],
            ["Alert / silence", "A monitoring warning (auto-resolves). 'Silence' = mute it for a window during planned work."],
            ["Free-gas / zero-balance", "Transactions are free, but a 0-balance account still can't send — fund it first."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-lg bg-ink-900/50 p-2">
              <dt className="font-semibold text-mist-1">{t}</dt>
              <dd className="text-mist-1/60">{d}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Intelligence roadmap" subtitle="future AI / analytics on this data" help={<>This is where the console goes next: layering analysis on top of the live numbers — not just "is it up?" but "what should we do, what's coming, and what's interesting?". Full detail in <code>doc/registry-console-intelligence-roadmap.md</code>.</>}>
        <div className="space-y-3 text-xs leading-relaxed text-mist-1/80">
          <RoadmapRow tag="live" tone="ok" title="Threshold anomaly signals" body="Chain-stall, indexer lag, failed backups, stale validators, firing alerts — the top banner. (Phase 0)" />
          <RoadmapRow tag="live" tone="ok" title="Statistical baselining + forecasts" body="z-scores vs each metric's normal range (drift before a hard alert) and +1h projections — see the Insights screen. (Phase 1.1/1.2)" />
          <RoadmapRow tag="live" tone="ok" title="Reliability: SLO + backup freshness" body="RPC success vs 99.9% target, live 5xx rate, and 'has each backup succeeded recently?'. (Phase 1.4)" />
          <RoadmapRow tag="live" tone="ok" title="Optimisation engine" body="Cache hit-rate, validator proposing-fairness, and indexer batch-tuning hints from real traffic. (Phase 2)" />
          <RoadmapRow tag="live" tone="ok" title="Capacity & milestones" body="Throughput & growth vs the measured ceiling and the 45-month projection — Insights → Capacity & growth. (Phase 3)" />
          <RoadmapRow tag="live*" tone="ok" title="Operator copilot (LLM)" body="Ask in plain English; grounded in live state; points you to Operations for any action. *Needs an API key configured. (Phase 4)" />
          <RoadmapRow tag="next" tone="idle" title="ML anomaly + real alert routing" body="Per-metric ML (Holt-Winters/Prophet) feeding Alertmanager → Slack/PagerDuty (currently stdout-only). (Phase 3.3)" />
          <RoadmapRow tag="later" tone="idle" title="Supply-chain intelligence (domain)" body="Graph analytics on the palm-oil custody DAG: mass-balance/fraud detection, RSPO coverage, flow maps, ESG/compliance reports. (Phase 5)" />
          <p className="pt-1 text-mist-1/45">All action-taking stays human-approved via the propose-only model; AI suggests, operators decide.</p>
        </div>
      </Panel>
    </div>
  );
}

function RoadmapRow({ tag, tone, title, body }: { tag: string; tone: "ok" | "warn" | "idle"; title: string; body: string }) {
  return (
    <div className="rounded-lg bg-ink-900/50 p-3">
      <div className="mb-1 flex items-center gap-2">
        <StatusPill tone={tone} label={tag} />
        <span className="font-display text-sm font-semibold text-mist-0">{title}</span>
      </div>
      <p className="text-mist-1/65">{body}</p>
    </div>
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
