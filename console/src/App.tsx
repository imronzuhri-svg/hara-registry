import { StrataMark } from "./components/StrataMark";
import { Panel, StatusPill, Stat } from "./components/Panel";
import { useChainHead } from "./hooks/useChainHead";

const NAV = [
  "Dashboard",
  "Governance & Roles",
  "Treasury",
  "Validators",
  "Contracts",
  "Partners",
  "Backups & DR",
  "Vault",
  "Alerts",
  "Audit Log",
];

function Soon({ phase }: { phase: string }) {
  return <StatusPill tone="idle" label={`wiring · ${phase}`} />;
}

export default function App() {
  const head = useChainHead();
  const chainTone = head.ok ? "ok" : head.loading ? "idle" : "down";
  const chainLabel = head.ok ? "live" : head.loading ? "connecting" : "unreachable";

  return (
    <div className="min-h-full font-body">
      {/* Top nav */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-700 bg-ink-900/80 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <StrataMark size={34} live={head.ok} />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold text-mist-0">
              HARA <span className="text-brand-teal">Registry</span> Console
            </div>
            <div className="text-[11px] uppercase tracking-widest text-mist-1/40">
              Strata · operations
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill tone={chainTone} label={`chain ${chainLabel}`} />
          <span className="rounded-full bg-ink-700 px-3 py-1 text-xs text-mist-1/70 ring-1 ring-ink-700">
            did:hara · Numira (stub)
          </span>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-6">
        {/* Sidebar */}
        <nav className="hidden w-52 shrink-0 lg:block">
          <ul className="space-y-1 text-sm">
            {NAV.map((item, i) => (
              <li key={item}>
                <a
                  href="#"
                  className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                    i === 0
                      ? "bg-strata text-white"
                      : "text-mist-1/70 hover:bg-ink-800 hover:text-mist-0"
                  }`}
                >
                  {item}
                  {i !== 0 && <span className="text-[10px] text-mist-1/30">P1+</span>}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-6 px-3 text-[11px] leading-relaxed text-mist-1/35">
            P0 = read-only “glass”. Governance & write actions arrive in P1+ — see
            <span className="text-brand-teal"> doc/registry-console-plan.md</span>.
          </p>
        </nav>

        {/* Main grid */}
        <main className="grid flex-1 grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {/* LIVE: Chain */}
          <Panel
            title="Chain"
            subtitle="QBFT · Besu"
            status={<StatusPill tone={chainTone} label={chainLabel} />}
          >
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Chain ID" value={head.chainId ?? "—"} />
              <Stat
                label="Latest block"
                value={head.block?.toLocaleString() ?? "—"}
                hint={head.error ? `error: ${head.error}` : "polling every 3s"}
              />
              <Stat
                label="Block time"
                value={head.blockTimeSec ? `${head.blockTimeSec.toFixed(1)}s` : "—"}
                hint="rolling estimate"
              />
              <Stat label="Gas price" value="0" hint="free-gas chain" />
            </div>
          </Panel>

          <Panel title="Validators" subtitle="QBFT 4-node · quorum 3/4" status={<Soon phase="P0.2" />}>
            <PlaceholderRows
              rows={["hara-v1", "hara-v2", "hara-v3", "hara-v4"]}
              note="up/down · peers · sync · last block · RAM headroom"
            />
          </Panel>

          <Panel title="RPC Tier" subtitle="hara-rpc-1 · HAProxy" status={<Soon phase="P0.2" />}>
            <PlaceholderRows
              rows={["rpc-write", "rpc-read-1", "rpc-read-2", "rpc-cache"]}
              note="backend health · req/s · error rate · cache hit ratio (HAProxy :8404)"
            />
          </Panel>

          <Panel title="Services" subtitle="hara-stateless-2" status={<Soon phase="P0.2" />}>
            <PlaceholderRows
              rows={["signer", "broadcaster", "indexer", "anchor-worker", "blockscout"]}
              note="indexer lag vs chain head · health"
            />
          </Panel>

          <Panel
            title="Account Watchlist"
            subtitle="zero-balance guard"
            status={<Soon phase="P0.3" />}
          >
            <PlaceholderRows
              rows={["platform admin", "loadtest-deployer", "hara-xchange", "funder"]}
              note="flags 0-balance senders BEFORE Besu silently drops their txs"
            />
          </Panel>

          <Panel title="Backups & DR" subtitle="age + rclone → Nevacloud S3" status={<Soon phase="P0.3" />}>
            <PlaceholderRows
              rows={["postgres 02:00", "vault-raft 04:00", "validators 03:0x"]}
              note="last run · next run · off-host age · last restore drill"
            />
          </Panel>

          <Panel title="Vault" subtitle="Raft · 3-of-5 unseal" status={<Soon phase="P0.3" />}>
            <PlaceholderRows rows={["seal status", "AppRoles"]} note="read-only; guided unseal in P2" />
          </Panel>

          <Panel title="Alerts" subtitle="Alertmanager feed" status={<Soon phase="P0.3" />}>
            <p className="text-sm text-mist-1/50">
              Live alert feed + severity + runbook links. (Routing config is P3 — currently
              stdout only.)
            </p>
          </Panel>

          <Panel title="Observability" subtitle="Grafana embed" status={<Soon phase="P0.3" />}>
            <p className="text-sm text-mist-1/50">
              Embedded Grafana panels (SSO-shared) — Prometheus · Loki · Tempo.
            </p>
          </Panel>
        </main>
      </div>
    </div>
  );
}

function PlaceholderRows({ rows, note }: { rows: string[]; note: string }) {
  return (
    <div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r}
            className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm"
          >
            <span className="text-mist-1/80">{r}</span>
            <span className="h-2 w-2 rounded-full bg-mist-1/20" />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-mist-1/40">{note}</p>
    </div>
  );
}
