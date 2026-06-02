// Minimal JSON-RPC client for read-only chain queries.
// Dev: hits "/rpc/read/" which Vite proxies to the public gateway (no CORS).
// Prod: the Console API serves the same origin-relative path.
const RPC_READ_URL = import.meta.env.VITE_RPC_READ_URL ?? "/rpc/read/";

let id = 0;

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_READ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export const hexToNumber = (hex: string): number => parseInt(hex, 16);
