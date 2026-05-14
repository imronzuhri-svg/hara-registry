// Benchmark RPC cache vs direct, in one Node process (avoids per-curl startup overhead).

const N = Number(process.argv[2] ?? 500);

const cases = [
  {
    name: "eth_blockNumber",
    payload: { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 },
    note: "1s TTL — mostly cache miss expected (block produces every 2s)",
  },
  {
    name: "eth_chainId",
    payload: { jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 },
    note: "24h TTL — first call miss, rest hit",
  },
  {
    name: "eth_getBlockByNumber(0x10)",
    payload: { jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["0x10", false], id: 1 },
    note: "1h TTL — finalized block, first call miss, rest hit",
  },
  {
    name: "eth_getLogs(0..0xa)",
    payload: {
      jsonrpc: "2.0",
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: "0xa", topics: [] }],
      id: 1,
    },
    note: "3s TTL — short-lived cache, hits within window",
  },
];

async function bench(label, url, payload) {
  // Warm-up — first call may have cold connection
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const start = Date.now();
  let errors = 0;
  for (let i = 0; i < N; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) errors++;
      await res.json();
    } catch {
      errors++;
    }
  }
  const ms = Date.now() - start;
  const usPerCall = (ms * 1000) / N;
  const rps = (N * 1000) / ms;
  console.log(
    `  ${label.padEnd(28)} ${String(N).padStart(5)} calls  ${String(ms).padStart(5)} ms  ${usPerCall.toFixed(0).padStart(5)} µs/call  ${rps.toFixed(0).padStart(5)} req/s  (errors: ${errors})`,
  );
  return { ms, rps };
}

const DIRECT_URL = process.env.DIRECT_URL ?? "http://lb:8545/rpc/read";
const CACHED_URL = process.env.CACHED_URL ?? "http://rpc-cache:8080";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);

async function benchConcurrent(label, url, payload, concurrency) {
  // Warm-up
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const start = Date.now();
  let done = 0;
  let errors = 0;
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= N) return;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) errors++;
        await res.json();
        done++;
      } catch {
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ms = Date.now() - start;
  const rps = (N * 1000) / ms;
  console.log(
    `  ${label.padEnd(28)} ${String(N).padStart(5)} calls (C=${concurrency}) ${String(ms).padStart(5)} ms = ${rps.toFixed(0).padStart(5)} req/s  (errors: ${errors})`,
  );
  return { ms, rps };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  console.log(`  RPC Cache Benchmark — ${N} sequential calls per method, single Node process`);
  console.log(`  Direct: ${DIRECT_URL}`);
  console.log(`  Cached: ${CACHED_URL}`);
  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  for (const c of cases) {
    console.log();
    console.log(`─── ${c.name} ─── ${c.note}`);
    const d = await benchConcurrent("DIRECT (HAProxy→Besu)", DIRECT_URL, c.payload, CONCURRENCY);
    const cc = await benchConcurrent("CACHED (rpc-cache→Redis)", CACHED_URL, c.payload, CONCURRENCY);
    const speedup = (d.ms / cc.ms).toFixed(1);
    console.log(`  → Cache is ${speedup}× faster (${cc.rps.toFixed(0)} req/s vs ${d.rps.toFixed(0)} req/s)`);
  }
}

main();
