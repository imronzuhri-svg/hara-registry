import { config } from "./config.js";

let id = 0;

/** Fetch with an abort timeout (Node 22 global fetch). */
export async function fetchT(url: string, init: RequestInit = {}, timeoutMs = config.fetchTimeoutMs): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Read-only JSON-RPC call against the Besu read endpoint. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetchT(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export const hexToNum = (h: string): number => parseInt(h, 16);
export const hexToBig = (h: string): bigint => BigInt(h);
export const weiToEth = (wei: bigint): string => {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${frac}`;
};
