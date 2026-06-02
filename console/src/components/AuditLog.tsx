import { useEffect, useState } from "react";
import { Panel, StatusPill } from "./Panel";
import { fetchAudit, type AuditEntry } from "../lib/api";

const riskTone = (r: string) => (r === "low" ? "ok" : r === "medium" ? "warn" : "down");

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAudit(200)
      .then(setEntries)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <Panel title="Audit log" subtitle="every proposed privileged action (append-only)">
      {error && <p className="text-sm text-accent-orange">unavailable — {error}</p>}
      {!error && entries === null && <p className="text-sm text-mist-1/45">loading…</p>}
      {entries !== null && entries.length === 0 && <p className="text-sm text-mist-1/45">No proposals recorded yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map((e, i) => (
            <li key={i} className="rounded-lg bg-ink-900/60 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-mist-1/80">
                  <span className="font-mono text-xs text-mist-1/45">{e.ts.replace("T", " ").slice(0, 19)}Z</span>{" "}
                  <span className="font-semibold">{e.kind}</span> · {e.summary}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-mist-1/40">{e.actor}</span>
                  <StatusPill tone={riskTone(e.risk)} label={e.risk} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
