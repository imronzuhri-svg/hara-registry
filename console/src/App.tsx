import type { ReactNode } from "react";
import { StrataMark } from "./components/StrataMark";
import { Panel, StatusPill, Stat } from "./components/Panel";
import { useOverview } from "./hooks/useOverview";
import type { Section } from "./lib/api";

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

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Renders a Section: data when available, else a muted unavailable note. */
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
  return section.available ? (
    <StatusPill tone="ok" label="live" />
  ) : (
    <StatusPill tone="idle" label="no data" />
  );
}

export default function App() {
  const { data, connected, error } = useOverview();
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
          <span className="rounded-full bg-ink-700 px-3 py-1 text-xs text-mist-1/70 ring-1 ring-ink-700">
            did:hara · Numira (stub)
          </span>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-6">
        <nav className="hidden w-52 shrink-0 lg:block">
          <ul className="space-y-1 text-sm">
            {NAV.map((item, i) => (
              <li key={item}>
                <a
                  href="#"
                  className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                    i === 0 ? "bg-strata text-white" : "text-mist-1/70 hover:bg-ink-800 hover:text-mist-0"
                  }`}
                >
                  {item}
                  {i !== 0 && <span className="text-[10px] text-mist-1/30">P1+</span>}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-6 px-3 text-[11px] leading-relaxed text-mist-1/35">
            P0 — read-only “glass”. Write/governance actions arrive in P1+ (see
            <span className="text-brand-teal"> doc/registry-console-plan.md</span>).
          </p>
          {error && !connected && (
            <p className="mt-3 px-3 text-[11px] text-accent-orange/80">
              Console API not reachable — run <code>pnpm --dir server start</code>.
            </p>
          )}
        </nav>

        <main className="grid flex-1 grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {/* Chain */}
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

          {/* Validators */}
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

          {/* RPC Tier */}
          <Panel title="RPC Tier" subtitle="hara-rpc-1 · HAProxy" status={sectionPill(data?.rpcTier)}>
            <S section={data?.rpcTier}>
              {(rows) => (
                <ul className="space-y-2">
                  {rows.map((b) => (
                    <li key={`${b.proxy}/${b.server}`} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                      <span className="text-mist-1/80">{b.proxy}/{b.server}</span>
                      <StatusPill tone={b.status === "UP" ? "ok" : b.status === "no check" ? "idle" : "down"} label={b.status} />
                    </li>
                  ))}
                </ul>
              )}
            </S>
          </Panel>

          {/* Services */}
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

          {/* Account watchlist */}
          <Panel title="Account Watchlist" subtitle="zero-balance guard" status={sectionPill(data?.accounts)}>
            <S section={data?.accounts}>
              {(rows) => (
                <ul className="space-y-2">
                  {rows.map((a) => (
                    <li key={a.address} className="flex items-center justify-between rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
                      <span>
                        <span className="text-mist-1/80">{a.label}</span>{" "}
                        <span className="font-mono text-xs text-mist-1/40">{shortAddr(a.address)}</span>
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

          {/* Vault */}
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

          {/* Backups */}
          <Panel title="Backups & DR" subtitle="age + rclone → S3" status={sectionPill(data?.backups)}>
            <S section={data?.backups}>{() => <Muted text="backups agent connected." />}</S>
          </Panel>

          {/* Alerts */}
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

          {/* Observability */}
          <Panel title="Observability" subtitle="Grafana embed" status={<StatusPill tone="idle" label="P0.3" />}>
            <Muted text="Embedded Grafana panels (SSO-shared) — Prometheus · Loki · Tempo." />
          </Panel>
        </main>
      </div>
    </div>
  );
}
