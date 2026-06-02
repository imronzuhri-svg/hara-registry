import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  status,
  children,
}: {
  title: string;
  subtitle?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-800 p-5 shadow-panel">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-mist-1">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-mist-1/50">{subtitle}</p>}
        </div>
        {status}
      </header>
      {children}
    </section>
  );
}

export function StatusPill({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "down" | "idle";
  label: string;
}) {
  const tones: Record<string, string> = {
    ok: "bg-brand-teal/15 text-brand-teal ring-brand-teal/30",
    warn: "bg-accent-orange/15 text-accent-orange ring-accent-orange/30",
    down: "bg-red-500/15 text-red-400 ring-red-500/30",
    idle: "bg-mist-1/10 text-mist-1/60 ring-mist-1/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${tones[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mist-1/45">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold text-mist-0">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-mist-1/45">{hint}</div>}
    </div>
  );
}
