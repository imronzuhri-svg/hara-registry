import { useEffect, useState } from "react";
import { fetchOverview, type Overview } from "../lib/api";

const POLL_MS = 5000;

export interface OverviewState {
  data: Overview | null;
  loading: boolean;
  /** true once we've had at least one successful fetch */
  connected: boolean;
  error: string | null;
}

/** Polls the Console API /api/overview read-only. */
export function useOverview(): OverviewState {
  const [state, setState] = useState<OverviewState>({
    data: null,
    loading: true,
    connected: false,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    let ctrl: AbortController | null = null;

    async function tick() {
      ctrl = new AbortController();
      try {
        const data = await fetchOverview(ctrl.signal);
        if (!alive) return;
        setState({ data, loading: false, connected: true, error: null });
      } catch (e) {
        if (!alive) return;
        setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
      }
    }

    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      ctrl?.abort();
      clearInterval(h);
    };
  }, []);

  return state;
}
