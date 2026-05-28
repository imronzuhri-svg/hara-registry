# RPC Tier Scaling — Design (2026-05-28)

**Audience:** operator planning the next infra phase. Follow-on to the RPC-hang
root-cause work (see `memory:rpc-node-hang-bug`) and the 200×500 stress effort.

**Status:** design only. Software mitigations already shipped (Blockscout
internal-tx fetcher disabled, real RPC healthcheck + autoheal, GC/heap pin,
`--sync-min-peers=2`, client-side send/receipt retry). This doc covers the
*structural* fix the software mitigations cannot address.

---

## 1. The bottleneck, precisely

Every Besu node — validator, write-RPC, read-RPC — **imports every block**
(replays all txs to update world state). Under our heavy traceability workload
(200–300M-gas blocks full of 499-hop `executeChain` calls), import is CPU-bound
and takes real wall-clock time.

Today all RPC containers (`rpc-write`, `rpc-read-1`, `rpc-read-2`, `rpc-cache`,
`lb`, `indexer`, `signer`, `broadcaster`, Blockscout BE/FE, Caddy, full obs
stack) share **one** VPS — `hara-stateless` (8 vCPU / 32 GB). During heavy
import they all contend for the same CPUs, fall behind the validators, and
`isInSync` flaps → tx pool disabled, receipts lag, HAProxy evicts backends.
That's the 200×500 wall and the source of the "rpc-write degrades under
sustained load" symptom.

**Key principle:**
> Scale RPC **serving + redundancy** horizontally (more nodes).
> Scale RPC **import throughput** vertically (more CPU / faster NVMe per node).
> Our wall is import → the first lever is vertical.

---

## 2. Can we "load-balance multiple write nodes"? (the question that prompted this)

Yes — standard pattern (Consensys "Besu Fleet") — **but** with two caveats:

1. **It does NOT reduce per-node import load.** Each write node still imports
   every block. Three write nodes on one overloaded host all drown together.
   More write nodes helps *acceptance/serving/redundancy*, not import.

2. **Naive round-robin breaks nonce consistency.** `eth_sendRawTransaction`
   only accepts + gossips a signed tx; each node has its own mempool view.
   Round-robining a single sender's sequential nonces (or its
   `getTransactionCount(pending)` query) across nodes yields gaps / inconsistent
   nonces. **Required: sender affinity** — route all txs from one sender to one
   node. HAProxy `balance source` (source-IP stickiness) is the cheap version.
   Our load client already manages nonces explicitly + retries, which is the
   complementary pattern that makes a multi-node write layer tolerable.

**Implication for our workloads:**
- Single-sender sequential bursts (the stress-test deployer) gain nothing from
  multiple write nodes — they must pin to one node for a consistent nonce view.
  Only *more CPU on that node* helps. → vertical.
- Multi-tenant real-world load (hara-did anchor-oracle + palm-oil operators +
  500 wallets) spreads across write nodes nicely under sender affinity. →
  horizontal helps here.

---

## 3. Target topology (phased)

### Phase 1 — dedicated RPC host (do first; solves the wall)

Move the RPC tier off `hara-stateless` onto its own VPS `hara-rpc-1`. Leaves
`hara-stateless` for services + obs + edge only.

```
hara-rpc-1  (NEW)        — rpc-write, rpc-read-1, rpc-read-2, lb, rpc-cache, autoheal
hara-stateless           — signer, broadcaster, indexer, Blockscout BE/FE, obs, Caddy
hara-stateful            — Vault, Postgres, Redis, MinIO   (unchanged)
hara-v1..v4              — validators                       (unchanged)
```

Even keeping the same node *count*, giving them a host where they don't fight
signer/indexer/Blockscout/obs for CPU lets import keep pace. This alone is
expected to clear the 200×500 wall.

### Phase 2 — HA + multi-tenant write scale (when load justifies)

Add `hara-rpc-2` with a 2nd write node + read replica. HAProxy spans both hosts.

```
hara-rpc-1   — rpc-write-1, rpc-read-1, lb (primary), rpc-cache, autoheal
hara-rpc-2   — rpc-write-2, rpc-read-2, lb (backup via keepalived/VIP), rpc-cache
```

- Write pool: 2 backends, `balance source` (sender affinity).
- Read pool: 2+ backends, `balance roundrobin` (reads are stateless).
- Redundancy: one RPC host down ≠ public outage.

---

## 4. Host sizing (Nevacloud)

| Host | vCPU | RAM | Disk | Rationale |
|---|---|---|---|---|
| `hara-rpc-1` (Phase 1) | **8** | 16 GB | 200 GB NVMe | 3 Besu nodes each import in parallel; NVMe is the real lever for Bonsai import. Heap is only 6 GB/node so 16 GB RAM is enough if not co-locating obs. |
| `hara-rpc-2` (Phase 2) | 8 | 16 GB | 200 GB NVMe | same |
| `hara-stateless` (post-move) | can **downsize** to 4 vCPU / 16 GB | — | RPC import burden removed; just services + obs + edge |

NVMe over network/HDD storage is non-negotiable for Besu — per Besu perf docs,
disk I/O is the usual import bottleneck. Map to nearest Nevacloud SKU; prefer
more vCPU + NVMe over RAM.

If a single bigger box is cheaper than two 8-vCPU hosts: a **16 vCPU / 32 GB**
`hara-rpc-1` running all 3 nodes with CPU headroom is a valid Phase-1.5 middle
ground before true multi-host HA.

---

## 5. HAProxy config — sender-affinity write pool (Phase 2)

The current `deploy/rpc/lb/haproxy.cfg` write pool is single-backend. For two
write backends with sender affinity:

```haproxy
backend rpc_write_pool
    option httpchk
    http-check send meth POST uri / hdr Content-Type application/json \
        body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
    http-check expect status 200
    # Sender affinity: hash on source IP so a given client's sequential nonces
    # always land on the same write node (consistent mempool/nonce view).
    # NOTE: this is IP-level, not from-address-level — good enough when each
    # tx-submitting service has a stable source IP. True from-address routing
    # needs L7 JSON-RPC parsing (not worth it yet).
    balance source
    hash-type consistent
    server rpc-write-1 rpc-write-1:8545 check inter 3s rise 1 fall 3 maxconn 2000
    server rpc-write-2 rpc-write-2:8545 check inter 3s rise 1 fall 3 maxconn 2000
```

`hash-type consistent` keeps affinity stable when a backend is added/removed
(only ~1/N of clients rebalance, not all). Keep `rise 1 fall 3 inter 3s` (the
sync-flip-tolerant tuning from the hang fix).

Read pool stays `balance roundrobin` — reads are stateless, any node serves.

**Caveat to document for clients:** even with affinity, a write node can lag on
import; clients must keep the send-retry + resilient-receipt-wait logic
(already in `scenario-stress-200x500.ts`) since read-after-write across nodes is
eventually-consistent.

---

## 6. Migration steps (Phase 1 — low risk)

RPC nodes are re-syncable: their only state is chain data they can re-import
from peers. No keys, no unique data. So the move is low-stakes.

1. **Provision `hara-rpc-1`**, cloud-init, add to WG mesh as a new peer
   (`deploy/ops/wg-add-peer.sh prepare/finalize` — assign e.g. 10.43.0.21).
2. **Open the cross-host bindings** the RPC nodes need: they already reach
   validators (10.43.0.11–14:30303) and Postgres/Redis (10.43.0.40) over the
   mesh — confirm `hara-rpc-1` can hit those.
3. **Bring up `deploy/rpc/docker-compose.yml` on `hara-rpc-1`.** New nodes sync
   from genesis (or restore a validator snapshot to skip the wait). With
   `--sync-min-peers=2` they peer immediately.
4. **Repoint Caddy** (`deploy/edge/Caddyfile` on hara-stateless): `/read/`,
   `/write/`, `/ws` upstreams → `hara-rpc-1`'s LB (10.43.0.21:8545/8546) instead
   of localhost.
5. **Repoint internal consumers** that hit `/rpc/read` directly: Blockscout
   (`ETHEREUM_JSONRPC_*_URL`), indexer, rpc-cache upstream → the new LB address.
6. **Stop the old RPC containers on hara-stateless**, free its CPU.
7. **Verify**: public endpoints, Blockscout indexing, a 200×500 run. The
   dedicated CPU should let import keep pace → clean completion.

Rollback: repoint Caddy/consumers back to the old localhost LB and restart the
old containers — they re-sync in minutes.

---

## 7. What stays the same

- Validators: untouched. Quorum, keys, snapshots all unchanged.
- Vault/Postgres/Redis/MinIO on hara-stateful: untouched.
- WG mesh model: just one more peer.
- All the software fixes (healthcheck/autoheal, GC, Blockscout, retry): carry
  over — they run on whichever host the RPC containers live on.

---

## 8. Open questions / decisions for the operator

1. **One bigger RPC host vs two smaller** — Phase 1 (single dedicated host) is
   enough to clear the 200×500 wall. Go to Phase 2 (HA, 2 hosts) only when you
   need redundancy or multi-tenant write headroom (hara-did + more partners).
2. **Snapshot-seed new RPC nodes** vs sync-from-genesis — at ~16K+ blocks,
   genesis sync is quick today; revisit when the chain is larger.
3. **Cost** — Phase 1 adds one ~8-vCPU VPS; hara-stateless can downsize to
   partially offset. Net cost roughly flat to +1 small VPS.
4. **from-address-level write routing** — only worth building (L7 JSON-RPC
   parse in HAProxy/a small proxy) if source-IP affinity proves too coarse
   (e.g., many senders behind one NAT'd service). Not now.

---

## TL;DR

- The 200×500 wall is **block-import CPU contention on the shared host**, not a
  software bug — the software fixes are done.
- **Phase 1: move the RPC tier to its own VPS** (`hara-rpc-1`, 8 vCPU/NVMe).
  Highest value, low risk, likely clears the wall on its own.
- **Multiple write nodes + LB** is real and worth it **for HA + multi-tenant
  write load** (Phase 2), with **`balance source` sender affinity** — but it
  does *not* substitute for per-node CPU; single-sender bursts still pin to one
  node.
- Keep client-side nonce management + retry; it's what makes a multi-node write
  layer safe.
