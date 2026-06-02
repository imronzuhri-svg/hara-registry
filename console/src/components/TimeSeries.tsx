import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchRange, type RangeSeries } from "../lib/api";

const fmtTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const fmtVal = (v: number, unit: string): string => {
  if (unit === "bytes") return `${(v / 1024 / 1024).toFixed(0)}MB`;
  if (v >= 1000) return v.toLocaleString();
  if (v < 1 && v > 0) return v.toFixed(3);
  return v.toFixed(2).replace(/\.00$/, "");
};

/** Self-fetching time-series area chart (Strata-themed), polls every 30s. */
export function TimeSeries({ series, minutes = 60, height = 140 }: { series: string; minutes?: number; height?: number }) {
  const [data, setData] = useState<RangeSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRange(series, minutes)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    load();
    const h = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [series, minutes]);

  const last = data && data.points.length ? data.points[data.points.length - 1].v : undefined;

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-800 p-4 shadow-panel">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-display text-xs font-semibold uppercase tracking-wider text-mist-1">
          {data?.label ?? series}
        </span>
        <span className="font-display text-lg text-mist-0">
          {last != null ? fmtVal(last, data?.unit ?? "") : "—"}
          <span className="ml-1 text-xs text-mist-1/40">{data?.unit}</span>
        </span>
      </div>
      {error ? (
        <p className="py-6 text-center text-xs text-mist-1/40">no data — {error}</p>
      ) : !data ? (
        <p className="py-6 text-center text-xs text-mist-1/40">loading…</p>
      ) : data.points.length === 0 ? (
        <p className="py-6 text-center text-xs text-mist-1/40">no datapoints in window</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data.points} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id={`g-${series}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2BD4C0" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#3B6BFF" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" tickFormatter={fmtTime} tick={{ fill: "#E8ECF666", fontSize: 10 }} minTickGap={40} stroke="#101A38" />
            <YAxis tick={{ fill: "#E8ECF666", fontSize: 10 }} width={40} stroke="#101A38" tickFormatter={(v) => fmtVal(v, data.unit)} />
            <Tooltip
              contentStyle={{ background: "#0C1226", border: "1px solid #101A38", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(t) => fmtTime(Number(t))}
              formatter={(v: number) => [fmtVal(v, data.unit), data.unit]}
            />
            <Area type="monotone" dataKey="v" stroke="#2BD4C0" strokeWidth={2} fill={`url(#g-${series})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
