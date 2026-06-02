import { useState, type ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  status,
  help,
  children,
}: {
  title: string;
  subtitle?: string;
  status?: ReactNode;
  /** Plain-language explanation shown when the "?" is clicked. */
  help?: ReactNode;
  children: ReactNode;
}) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-800 p-5 shadow-panel">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-mist-1">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-mist-1/50">{subtitle}</p>}
          </div>
          {help && (
            <button
              onClick={() => setShowHelp((v) => !v)}
              aria-label="What is this?"
              title="What is this?"
              className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ring-1 ${
                showHelp ? "bg-brand-blue text-white ring-brand-blue" : "text-mist-1/50 ring-ink-700 hover:text-brand-teal hover:ring-brand-teal/50"
              }`}
            >
              ?
            </button>
          )}
        </div>
        {status}
      </header>
      {help && showHelp && (
        <div className="mb-4 rounded-lg border border-brand-blue/20 bg-brand-blue/5 p-3 text-xs leading-relaxed text-mist-1/80">
          {help}
        </div>
      )}
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
