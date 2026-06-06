import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchHostRange, type HostRange } from "../lib/api";

// One distinct colour per host (Strata palette + a few neutrals).
const COLORS = ["#2BD4C0", "#3B6BFF", "#5A45E0", "#FFC56E", "#FF9D5C", "#F39B24", "#9B8CFF", "#6FE3D2"];
const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Self-fetching multi-line host time-series (one line per host), polls every 30s. */
export function HostTimeSeries({ metric, minutes, height = 190 }: { metric: string; minutes: number; height?: number }) {
  const [data, setData] = useState<HostRange | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchHostRange(metric, minutes)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    load();
    const h = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [metric, minutes]);

  const hours = Math.max(1, Math.round(minutes / 60));

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-800 p-4 shadow-panel">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-display text-xs font-semibold uppercase tracking-wider text-mist-1">
          {data?.label ?? metric} <span className="text-mist-1/40">· last {hours}h</span>
        </span>
        <span className="text-xs text-mist-1/40">{data?.unit ?? "%"}</span>
      </div>
      {error ? (
        <p className="py-6 text-center text-xs text-mist-1/40">no data — {error}</p>
      ) : !data ? (
        <p className="py-6 text-center text-xs text-mist-1/40">loading…</p>
      ) : data.rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-mist-1/40">no datapoints in window yet</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data.rows} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
            <CartesianGrid stroke="#101A38" vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtTime} tick={{ fill: "#E8ECF666", fontSize: 10 }} minTickGap={40} stroke="#101A38" />
            <YAxis domain={[0, 100]} tick={{ fill: "#E8ECF666", fontSize: 10 }} width={40} stroke="#101A38" tickFormatter={(v) => `${v}%`} />
            <Tooltip
              contentStyle={{ background: "#0C1226", border: "1px solid #101A38", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(t) => fmtTime(Number(t))}
              formatter={(v: number, n: string) => [`${v}%`, n]}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {data.hosts.map((h, i) => (
              <Line key={h} type="monotone" dataKey={h} stroke={COLORS[i % COLORS.length]} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
