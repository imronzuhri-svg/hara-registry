import { useState } from "react";
import { Panel, StatusPill } from "./Panel";
import { propose, CONTRACT_ROLES, type Proposal, type Risk } from "../lib/api";

type Kind = "fund" | "grantRole" | "revokeRole" | "register" | "onboard" | "snapshot";

const ACTIONS: { kind: Kind; label: string; risk: Risk }[] = [
  { kind: "fund", label: "Fund account", risk: "low" },
  { kind: "onboard", label: "Onboard partner", risk: "low" },
  { kind: "register", label: "Register contract", risk: "medium" },
  { kind: "grantRole", label: "Grant role", risk: "high" },
  { kind: "revokeRole", label: "Revoke role", risk: "high" },
  { kind: "snapshot", label: "Trigger snapshot", risk: "medium" },
];

const riskTone = (r: Risk) => (r === "low" ? "ok" : r === "medium" ? "warn" : "down");

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="rounded-md bg-ink-700 px-2 py-1 text-xs text-mist-1 hover:bg-brand-blue/30"
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-0 placeholder:text-mist-1/30 focus:border-brand-blue focus:outline-none";

export function Operations() {
  const [kind, setKind] = useState<Kind>("fund");
  const [f, setF] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const contract = f.contract ?? "HaraPalmOil";

  async function build() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const params = buildParams(kind, f);
      setResult(await propose(kind, params));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel title="Propose an action" subtitle="propose-only · the console never signs">
        <div className="space-y-3">
          <label className="block text-xs uppercase tracking-wide text-mist-1/45">Action</label>
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setResult(null);
              setError(null);
            }}
          >
            {ACTIONS.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.label} — {a.risk} risk
              </option>
            ))}
          </select>

          {/* per-action fields */}
          {(kind === "fund" || kind === "onboard") && (
            <>
              {kind === "onboard" && <Field label="Partner label" v={f.label} onChange={(v) => set("label", v)} placeholder="hara-xchange" />}
              <Field label={kind === "onboard" ? "Deployer address" : "Recipient address"} v={f.to ?? f.address} onChange={(v) => set(kind === "onboard" ? "address" : "to", v)} placeholder="0x…" />
              <Field label="Amount (HARA)" v={f.amountEth} onChange={(v) => set("amountEth", v)} placeholder="10" />
            </>
          )}

          {(kind === "grantRole" || kind === "revokeRole") && (
            <>
              <Select label="Contract" v={contract} onChange={(v) => set("contract", v)} options={Object.keys(CONTRACT_ROLES)} />
              <Select label="Role" v={f.role} onChange={(v) => set("role", v)} options={CONTRACT_ROLES[contract] ?? []} />
              <Field label="Account" v={f.account} onChange={(v) => set("account", v)} placeholder="0x…" />
            </>
          )}

          {(kind === "register" || (kind === "onboard")) && (
            <>
              <Field label={kind === "onboard" ? "Register name (optional)" : "Name"} v={f.name} onChange={(v) => set("name", v)} placeholder="HaraXchangeOrderBook" />
              <Field label="Version" v={f.version} onChange={(v) => set("version", v)} placeholder="1" />
              {kind === "register" && <Field label="Contract address" v={f.address} onChange={(v) => set("address", v)} placeholder="0x…" />}
            </>
          )}

          {kind === "onboard" && (
            <>
              <Select label="Grant role — contract (optional)" v={f.contract ?? ""} onChange={(v) => set("contract", v)} options={["", ...Object.keys(CONTRACT_ROLES)]} />
              {f.contract && <Select label="Role" v={f.role} onChange={(v) => set("role", v)} options={CONTRACT_ROLES[f.contract] ?? []} />}
            </>
          )}

          {kind === "snapshot" && (
            <>
              <Select label="Host" v={f.host} onChange={(v) => set("host", v)} options={["hara-stateful", "hara-v1", "hara-v2", "hara-v3", "hara-v4"]} />
              <Select label="Unit" v={f.unit} onChange={(v) => set("unit", v)} options={["hara-postgres-snapshot", "hara-vault-snapshot", "hara-validator-snapshot"]} />
            </>
          )}

          <button
            onClick={build}
            disabled={busy}
            className="mt-2 w-full rounded-lg bg-strata py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "building…" : "Build proposal"}
          </button>
          {error && <p className="text-sm text-accent-orange">{error}</p>}
        </div>
      </Panel>

      <Panel
        title="Proposal"
        subtitle="review → run the command yourself"
        status={result && <StatusPill tone={riskTone(result.risk)} label={`${result.risk} risk`} />}
      >
        {!result ? (
          <p className="text-sm text-mist-1/45">Fill the form and build a proposal. Nothing is executed — you'll get the exact command to run.</p>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="font-display text-sm font-semibold text-mist-0">{result.title}</div>
              <div className="text-xs text-mist-1/55">{result.summary}</div>
            </div>
            {result.commands.map((c, i) => (
              <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-3">
                <div className="mb-2 flex justify-end">
                  <CopyBtn text={c} />
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-brand-teal">{c}</pre>
              </div>
            ))}
            <ul className="list-disc space-y-1 pl-5 text-xs text-mist-1/55">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <p className="text-[11px] text-mist-1/35">Logged to the audit trail. The console did not sign or send anything.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Field({ label, v, onChange, placeholder }: { label: string; v?: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-mist-1/45">{label}</label>
      <input className={inputCls} value={v ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function Select({ label, v, onChange, options }: { label: string; v?: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-mist-1/45">{label}</label>
      <select className={inputCls} value={v ?? options[0] ?? ""} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "(none)"}
          </option>
        ))}
      </select>
    </div>
  );
}

function buildParams(kind: Kind, f: Record<string, string>): Record<string, unknown> {
  switch (kind) {
    case "fund":
      return { to: f.to, amountEth: f.amountEth };
    case "grantRole":
    case "revokeRole":
      return { contract: f.contract ?? "HaraPalmOil", role: f.role, account: f.account };
    case "register":
      return { name: f.name, version: Number(f.version || 0), address: f.address };
    case "onboard": {
      const p: Record<string, unknown> = { label: f.label, address: f.address, amountEth: f.amountEth };
      if (f.contract && f.role) p.roles = [{ contract: f.contract, role: f.role }];
      if (f.name) p.register = { name: f.name, version: Number(f.version || 0) };
      return p;
    }
    case "snapshot":
      return { host: f.host ?? "hara-stateful", unit: f.unit ?? "hara-postgres-snapshot" };
  }
}
