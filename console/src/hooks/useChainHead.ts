import { useEffect, useRef, useState } from "react";
import { rpc, hexToNumber } from "../lib/rpc";

export interface ChainHead {
  ok: boolean;
  loading: boolean;
  chainId: number | null;
  block: number | null;
  /** seconds between the last two observed blocks (rough block time) */
  blockTimeSec: number | null;
  error: string | null;
}

const POLL_MS = 3000;

/** Polls the chain head read-only and derives a rough block time. */
export function useChainHead(): ChainHead {
  const [state, setState] = useState<ChainHead>({
    ok: false,
    loading: true,
    chainId: null,
    block: null,
    blockTimeSec: null,
    error: null,
  });
  const last = useRef<{ block: number; t: number } | null>(null);

  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const [chainIdHex, blockHex] = await Promise.all([
          rpc<string>("eth_chainId"),
          rpc<string>("eth_blockNumber"),
        ]);
        if (!alive) return;
        const block = hexToNumber(blockHex);
        const now = Date.now();
        let blockTimeSec: number | null = null;
        if (last.current && block > last.current.block) {
          blockTimeSec = (now - last.current.t) / 1000 / (block - last.current.block);
          last.current = { block, t: now };
        } else if (!last.current) {
          last.current = { block, t: now };
        }
        setState((s) => ({
          ok: true,
          loading: false,
          chainId: hexToNumber(chainIdHex),
          block,
          blockTimeSec: blockTimeSec ?? s.blockTimeSec,
          error: null,
        }));
      } catch (e) {
        if (!alive) return;
        setState((s) => ({ ...s, ok: false, loading: false, error: (e as Error).message }));
      }
    }

    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  return state;
}
