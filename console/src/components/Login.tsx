import { useState } from "react";
import { login, type AuthUser } from "../lib/auth";
import { StrataMark } from "./StrataMark";

export function Login({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLogin(await login(username, password));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-900 px-4 font-body">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-800 p-7 shadow-panel">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <StrataMark size={48} live />
          <div>
            <div className="font-display text-lg font-semibold text-mist-0">
              HARA <span className="text-brand-teal">Registry</span> Console
            </div>
            <div className="text-[11px] uppercase tracking-widest text-mist-1/40">Sign in</div>
          </div>
        </div>
        <label className="mb-1 block text-xs text-mist-1/60">Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          className="mb-4 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-0 outline-none focus:border-brand-blue"
        />
        <label className="mb-1 block text-xs text-mist-1/60">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mb-5 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-0 outline-none focus:border-brand-blue"
        />
        {err && <p className="mb-4 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</p>}
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-lg bg-strata py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in →"}
        </button>
        <p className="mt-4 text-center text-[11px] text-mist-1/30">
          Access is also gated by the network (WireGuard/VPN).
        </p>
      </form>
    </div>
  );
}
