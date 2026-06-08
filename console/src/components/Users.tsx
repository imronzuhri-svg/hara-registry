import { useEffect, useState } from "react";
import { Panel, StatusPill } from "./Panel";
import { listUsers, createUser, updateUser, deleteUser, ROLES, roleLabel, type UserRow, type Role, type AuthUser } from "../lib/auth";

const input = "rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-mist-0 outline-none focus:border-brand-blue";

export function Users({ me }: { me: AuthUser }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // new-user form
  const [nu, setNu] = useState({ username: "", password: "", role: "viewer" as Role, email: "" });

  const load = () => listUsers().then(setRows).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await createUser({ username: nu.username, password: nu.password, role: nu.role, email: nu.email || undefined });
      setNu({ username: "", password: "", role: "viewer", email: "" });
    });
  }

  return (
    <Panel title="Users" subtitle="add · edit role/status · reset password · delete (owner only)" status={<StatusPill tone={rows ? "ok" : "idle"} label={rows ? `${rows.length}` : "…"} />}>
      {err && <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</p>}

      {/* add user */}
      <form onSubmit={add} className="mb-5 grid grid-cols-1 gap-2 rounded-lg border border-ink-700 bg-ink-900/40 p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <input className={input} placeholder="username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
        <input className={input} placeholder="password (≥10)" type="text" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
        <input className={input} placeholder="email (optional)" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
        <select className={input} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button disabled={busy || !nu.username || nu.password.length < 10} className="rounded-lg bg-strata px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40">Add user</button>
      </form>

      {/* list */}
      <div className="space-y-2">
        {!rows ? (
          <p className="text-sm text-mist-1/45">loading…</p>
        ) : rows.map((u) => (
          <UserItem key={u.id} u={u} me={me} busy={busy} onRun={run} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-mist-1/35">
        Roles: {ROLES.map((r) => roleLabel[r]).join(" · ")}. Disabling, deleting, password reset, or a role change ends that user's sessions.
      </p>
    </Panel>
  );
}

function UserItem({ u, me, busy, onRun }: { u: UserRow; me: AuthUser; busy: boolean; onRun: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const isSelf = u.id === me.id;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 px-3 py-2">
      <div className="min-w-[160px] flex-1">
        <span className="font-medium text-mist-0">{u.username}</span>
        {isSelf && <span className="ml-2 rounded bg-brand-teal/15 px-1.5 py-0.5 text-[10px] text-brand-teal">you</span>}
        <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${u.status === "active" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-mist-1/50"}`}>{u.status}</span>
        <div className="text-[11px] text-mist-1/40">{u.email ?? "—"} · last login {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</div>
      </div>

      <select className={input} value={u.role} disabled={busy} onChange={(e) => onRun(() => updateUser(u.id, { role: e.target.value as Role }))}>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>

      <button className="rounded-lg border border-ink-700 px-2 py-1 text-xs text-mist-1/70 hover:text-mist-0 disabled:opacity-40"
        disabled={busy || isSelf}
        onClick={() => onRun(() => updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" }))}>
        {u.status === "active" ? "Disable" : "Enable"}
      </button>

      <div className="flex items-center gap-1">
        <input className={`${input} w-28`} placeholder="new pw" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="rounded-lg border border-ink-700 px-2 py-1 text-xs text-mist-1/70 hover:text-mist-0 disabled:opacity-40"
          disabled={busy || pw.length < 10}
          onClick={() => onRun(async () => { await updateUser(u.id, { password: pw }); setPw(""); })}>Reset</button>
      </div>

      <button className="rounded-lg border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-30"
        disabled={busy || isSelf}
        onClick={() => { if (confirm(`Delete user "${u.username}"? This cannot be undone.`)) onRun(() => deleteUser(u.id)); }}>
        Delete
      </button>
    </div>
  );
}
