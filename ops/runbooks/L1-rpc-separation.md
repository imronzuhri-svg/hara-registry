# L1 — RPC read/write separation runbook

L1 replaces the L0 single RPC node with a 3-node RPC tier (2 read + 1 write) behind an HAProxy load balancer. Validators remain private — no public ingress to consensus nodes.

## Topology

```
Host :8545 ─┬─► HAProxy ─► /rpc/read  → rpc-read-1 (10.42.0.21)
            │              /rpc/read  → rpc-read-2 (10.42.0.22)   round-robin
            │              /rpc/write → rpc-write  (10.42.0.23)
            │              /healthz   → LB liveness
            │              default    → read pool (reads dominate)
            │
            └─► (no direct path to validators — they are private)

Host :8546 ─► HAProxy ─► WebSocket → rpc-read-* (least-conn)

Host :8404 ─► HAProxy stats UI + Prometheus /metrics
```

## What's new vs L0

| Component | L0 | L1 |
|---|---|---|
| RPC nodes | 1 combined (`hara-rpc`) | 3 split: 2 read + 1 write |
| Load balancer | None — direct connection | HAProxy with path routing + health checks + rate limit |
| Failover | None — single point of failure | Read tier survives 1 node loss |
| Rate limiting | None | 1000 req per 10s per source IP (default) |
| Public ingress | Host port 8545 → rpc directly | Host port 8545 → LB → backend pools |
| Stats UI | Grafana only | + HAProxy stats at :8404/stats |

## Bring-up

If you're coming from L0 with a running chain, **the L0 chain state cannot be reused** — re-bootstrap is required because validator addresses are pinned in genesis and L1 adds new RPC node IPs.

```bash
docker compose -f chain/docker-compose.yml --env-file chain/.env down -v
docker compose -f chain/docker-compose.yml --env-file chain/.env up vault -d
# Wait for Vault healthy, then run init:
docker compose -f chain/docker-compose.yml --env-file chain/.env run --rm init
docker compose -f chain/docker-compose.yml --env-file chain/.env up -d
```

Wait for LB liveness:
```bash
curl http://localhost:8545/healthz
# Expected: ok
```

## L1 exit criteria

- [ ] `curl /healthz` returns `ok`
- [ ] `POST /rpc/read eth_blockNumber` returns increasing block height
- [ ] `POST /rpc/write eth_blockNumber` returns the same height (within 1 block)
- [ ] Round-robin observable: two consecutive `/rpc/read` calls hit different backends (visible at `/stats`)
- [ ] HAProxy stats page reachable at http://localhost:8404/stats — shows all 3 backends UP
- [ ] **Killing `hara-rpc-read-1` → `/rpc/read` keeps serving with 100% success rate after 6s** (chaos test)
- [ ] Validators have NO published host ports for RPC (only `30303` P2P on validator1)
- [ ] Contract deploy via `--rpc-url http://localhost:8545/rpc/write` succeeds
- [ ] Contract read via `--rpc-url http://localhost:8545/rpc/read` returns matching state

## End-to-end verification commands

### Deploy (write path)

```bash
cd contracts
docker run --rm --network hara-chain \
  -v "$(pwd):/work" -w /work \
  --entrypoint forge ghcr.io/foundry-rs/foundry:latest \
  script script/Deploy.s.sol:Deploy \
    --rpc-url http://lb:8545/rpc/write \
    --broadcast --legacy --skip-simulation \
    --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Read (read path)

```bash
docker run --rm --network hara-chain \
  --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  call 0x5FbDB2315678afecb367f032d93F642f64180aa3 \
    "getActive(bytes32)(address)" \
    "$(docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest keccak ContractRegistry)" \
    --rpc-url http://lb:8545/rpc/read
```

Expected: returns `0x5FbDB2315678afecb367f032d93F642f64180aa3` (ContractRegistry self-registered).

### Chaos test (read failover)

```bash
docker stop hara-rpc-read-1
sleep 6                          # allow 2 failed health checks at 2s interval
for i in $(seq 1 12); do
  curl -s -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       http://localhost:8545/rpc/read
  echo
done
# Expected: all 12 succeed via rpc-read-2
docker start hara-rpc-read-1
```

## HAProxy stats UI

- URL: http://localhost:8404/stats
- Shows each backend's UP/DOWN state, current sessions, queue, error rates
- Useful columns when debugging: `LastChk` (most recent health check result), `Status` (UP/DOWN/MAINT), `Wght` (weight)

## Rate limiting

Default: 1000 requests per 10 seconds per source IP.

Triggers HTTP 429 when exceeded:
```bash
for i in $(seq 1 1500); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
       -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       http://localhost:8545/rpc/read &
done | sort | uniq -c
# Should show a mix of 200 and 429
```

Tune in `chain/lb/haproxy.cfg` — the `http-request deny ... gt 1000` value.

## What L1 does NOT include

Deferred to later stages:

- **Multiple write RPC nodes** — would help write availability but adds nonce-coordination complexity. Lands in P1 once the signer service (L2) is in place to coordinate.
- **TLS termination** — host-port traffic is plain HTTP. P1 adds TLS at the LB.
- **API key gating for partner RPC** — uses HAProxy ACLs on `Authorization` header. Lands in L9 (full RPC mesh).
- **Archive node separation** — `eth_getLogs` and historical queries still go to the same read pool. Splits in L9.
- **JSON-RPC method-level routing** — currently path-based. Future: inspect JSON body and route `eth_sendRawTransaction` to write pool even on the default endpoint. Requires Lua scripting in HAProxy or a small proxy service.

## Common issues

### "/rpc/read returns empty / connection refused"

LB up but no read backends healthy. Check:
```bash
docker compose -f chain/docker-compose.yml ps | grep rpc-read
curl -s http://localhost:8404/stats  # look at HAProxy status table
```

If both read nodes are DOWN at the LB level, look at health check failures:
```bash
docker logs hara-lb | grep -i "is DOWN"
```

### "HAProxy stats page shows servers UP but RPC returns 503"

The health check passes (POST eth_blockNumber returns 200) but live traffic gets 503. Usually caused by HTTP/2 mismatch or wrong `mode http` in a backend. Run `docker exec hara-lb haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg` to validate config.

### "Throughput is much lower than L0"

The LB adds ~1ms overhead per request — should be invisible. If it's significant:
- Check `nbthread 4` in `haproxy.cfg` is uncommented
- Check Docker resource limits aren't pegging HAProxy CPU
- Increase `maxconn` in `global` (currently 8192)

## Next stage

When all L1 exit criteria pass: **L2 — Signer service + nonce manager + queue + broadcaster**. See `doc/hara-ledger-roadmap.md`.
