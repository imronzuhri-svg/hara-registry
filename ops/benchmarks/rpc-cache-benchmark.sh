#!/usr/bin/env bash
# Compare latency + throughput of read RPC calls direct vs through the cache.
#
# Two endpoints:
#   DIRECT  http://localhost:8545/rpc/read    (HAProxy → Besu read pool)
#   CACHED  http://localhost:8088/            (rpc-cache → Redis → fallback to LB)
#
# Three workloads:
#   1. eth_blockNumber × 1000 sequential       (1s TTL — many hits expected)
#   2. eth_chainId × 1000 sequential           (24h TTL — almost all hits)
#   3. eth_getBlockByNumber(0x10, false) × 1000 (finalized, 1h TTL — long cache life)

set -euo pipefail

DIRECT="http://localhost:8545/rpc/read"
CACHED="http://localhost:8088"
N=${N:-1000}

bench() {
  local label="$1"
  local url="$2"
  local payload="$3"
  local start_ns=$(date +%s%N)
  for ((i=1; i<=N; i++)); do
    curl -s -o /dev/null -X POST -H "Content-Type: application/json" --data "$payload" "$url"
  done
  local end_ns=$(date +%s%N)
  local elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  local per_call_us=$(( (end_ns - start_ns) / 1000 / N ))
  printf "  %-40s  %5d calls  %6d ms total  %4d µs/call  %.1f req/s\n" "$label" "$N" "$elapsed_ms" "$per_call_us" "$(awk "BEGIN{printf \"%.1f\", $N * 1000 / $elapsed_ms}")"
}

echo "═══════════════════════════════════════════════════════════════════════════"
echo "  RPC Cache Benchmark — $N calls per method"
echo "═══════════════════════════════════════════════════════════════════════════"
echo
echo "─── eth_blockNumber (1s TTL — cache hit window) ───"
bench "  DIRECT (HAProxy → Besu)"  "$DIRECT" '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
bench "  CACHED (rpc-cache → Redis)" "$CACHED" '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

echo
echo "─── eth_chainId (24h TTL — essentially permanent cache) ───"
bench "  DIRECT" "$DIRECT" '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
bench "  CACHED" "$CACHED" '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

echo
echo "─── eth_getBlockByNumber(0x10, false) (1h TTL — finalized) ───"
bench "  DIRECT" "$DIRECT" '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["0x10",false],"id":1}'
bench "  CACHED" "$CACHED" '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["0x10",false],"id":1}'

echo
echo "─── eth_getLogs (3s TTL — short cache for fresh queries) ───"
bench "  DIRECT" "$DIRECT" '{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0xa","topics":[]}],"id":1}'
bench "  CACHED" "$CACHED" '{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0xa","topics":[]}],"id":1}'

echo
echo "═══ Cache stats ═══"
docker exec hara-redis redis-cli -n 5 dbsize | head -1
echo
