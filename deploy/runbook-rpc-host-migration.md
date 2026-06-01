# Runbook — RPC Host Migration (combined cutover)

**Goal:** move the RPC tier onto a dedicated host and right-size the services
tier, in **one maintenance window**, by standing up both new boxes in parallel
and doing a single DNS/Caddy cutover.

**Companion:** [rpc-scaling-design.md](rpc-scaling-design.md) (the "why" + sizing).
This is the "how."

**End state:**
```
hara-rpc-1     (NEW, 8 vCPU/16GB/200GB NVMe)  — rpc-write, rpc-read-1, rpc-read-2, lb, autoheal
hara-stateless-2 (NEW, 4 vCPU/16GB/200GB NVMe) — signer, broadcaster, indexer, rpc-cache,
                                                  Blockscout BE/FE, obs, Caddy
hara-stateful  (unchanged)                     — Vault, Postgres, Redis, MinIO
hara-v1..v4    (unchanged)                      — validators
hara-stateless (OLD)                            — decommissioned after cutover
```

**Why combined:** the RPC move already forces a Caddy/DNS repoint. Folding the
services-tier downsize into the same cutover collapses two migrations into one
switch. Both new boxes are stateless-by-design (no unique data — chain re-syncs
from peers; Blockscout index lives in Postgres on hara-stateful), so this is
low-risk and fully reversible until the final decommission.

---

## 0. WG IP assignments (parallel-running phase)

Old `hara-stateless` keeps 10.43.0.20 until decommission. New boxes get fresh IPs:

| Host | WG IP | Public IP |
|---|---|---|
| `hara-rpc-1` | 10.43.0.21 | (from Nevacloud) |
| `hara-stateless-2` | 10.43.0.25 | (from Nevacloud) — becomes the DNS target |

(After decommission you *may* renumber hara-stateless-2 → .20 for tidiness, but
it's not required; nothing hardcodes .20 except the old host's own wg0.)

---

## 1. Pre-window prep (no downtime, do days ahead)

1. **Lower DNS TTL** on the three A records (`rpc`, `explorer`,
   `grafana`.ledger/platform.haratrust.io) at GoDaddy to **300s**, at least a
   day before, so the cutover propagates fast.
2. **Provision both VPSes** in the Nevacloud panel with `deploy/ops/cloud-init.yaml`
   user-data. Wait for SSH.
3. **WG-onboard both** with `deploy/ops/wg-add-peer.sh`:
   ```bash
   deploy/ops/wg-add-peer.sh prepare hara-rpc-1 10.43.0.21      # → send packet, get pubkey
   deploy/ops/wg-add-peer.sh finalize hara-rpc-1 10.43.0.21 <pubip> <pubkey>
   deploy/ops/wg-add-peer.sh prepare hara-stateless-2 10.43.0.25
   deploy/ops/wg-add-peer.sh finalize hara-stateless-2 10.43.0.25 <pubip> <pubkey>
   ```
   Verify both can ping validators (10.43.0.11-14) and hara-stateful (10.43.0.40).
4. **Clone the repo** on both: `sudo git clone … /opt/hara/hara-registry` (or rsync).

---

## 2. Phase A — stand up RPC tier on hara-rpc-1 (parallel, prod untouched)

```bash
ssh hara-rpc-1
cd /opt/hara/hara-registry
# .env for the rpc stack — same as old hara-stateless's deploy/rpc/.env
#   (cross-host bindings already point at validators + stateful by WG IP)
sudo docker compose -f deploy/rpc/docker-compose.yml --env-file deploy/rpc/.env up -d
```
- The 3 RPC nodes sync from genesis (or restore a validator snapshot to skip the
  wait). With `--sync-min-peers=2` they peer immediately; no 11-min stall.
- autoheal + real healthcheck come up automatically (already in the compose).
- **Verify in sync before cutover:**
  ```bash
  for n in hara-rpc-read-1 hara-rpc-read-2 hara-rpc-write; do
    ssh hara-rpc-1 "docker run --rm --network hara-platform alpine:3.20 \
      wget -qO- --post-data='{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"id\":1}' \
      --header='Content-Type: application/json' http://$n:8545"; done
  ```
  All three should report a block height matching the validators (`eth_blockNumber`
  on hara-v1). Wait until they're caught up.

Prod still serves from old hara-stateless — nothing switched yet.

---

## 3. Phase B — stand up services tier on hara-stateless-2 (parallel)

The one real edit: point the services + Blockscout + Caddy at the **new LB**
(hara-rpc-1 @ 10.43.0.21) instead of localhost.

```bash
ssh hara-stateless-2
cd /opt/hara/hara-registry

# Regenerate per-role .env files (or copy from old host and edit the RPC endpoint).
# secrets-bootstrap.sh bakes WG-IP bindings; run it for this host's roles:
sudo ./deploy/ops/secrets-bootstrap.sh services   # or copy + edit

# CRITICAL repoints (RPC endpoint: localhost → hara-rpc-1 WG IP):
#   deploy/services/.env:        RPC_WRITE_URL / RPC_READ_URL → http://10.43.0.21:8545/rpc/...
#   deploy/edge/Caddyfile:       /read,/write,/ws upstreams    → 10.43.0.21:8545 / :8546
#                                 (rpc-cache stays local on this host; its upstream → 10.43.0.21)
#   blockscout env (GITIGNORED — re-apply by hand, see gotcha #1):
#                                 ETHEREUM_JSONRPC_*_URL        → http://10.43.0.21:8545/rpc/read
#                                 INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true  ← re-add!

sudo docker compose -f deploy/services/docker-compose.yml --env-file deploy/services/.env up -d
sudo docker compose -f deploy/services/blockscout/docker-compose.yml up -d
sudo docker compose -f deploy/platform/docker-compose.obs.yml up -d
# DON'T start Caddy yet — it would try to grab certs for domains still pointing at old host
```

Verify services reach the chain via the new LB:
```bash
ssh hara-stateless-2 'docker logs hara-indexer --tail 20'   # should be tailing blocks
```

---

## 4. Phase C — the cutover (single switch, ~1-2 min)

This is the only step with user-visible impact. Do it fast.

1. **Stop Caddy on OLD hara-stateless** (releases the domains):
   ```bash
   ssh hara-stateless 'docker stop hara-caddy'
   ```
2. **Repoint DNS** at GoDaddy — the three A records → **hara-stateless-2 public IP**.
   (TTL is 300s from prep, so propagation is quick.)
3. **Start Caddy on hara-stateless-2:**
   ```bash
   ssh hara-stateless-2 'cd /opt/hara/hara-registry && docker compose -f deploy/edge/docker-compose.yml up -d'
   ```
   ACME HTTP-01 re-issues certs once DNS resolves to the new IP (needs :80 reachable).

---

## 5. Phase D — verify

```bash
# Public endpoints (allow a minute for DNS + cert issuance)
curl -sS -X POST https://rpc.ledger.haratrust.io/write/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
curl -sS -X POST https://rpc.ledger.haratrust.io/read/  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
curl -sI https://explorer.ledger.haratrust.io | head -1
curl -sI https://grafana.platform.haratrust.io | head -1

# Stability under load (the read pool should hold now — dedicated host + no Blockscout trace hammer)
for i in $(seq 1 60); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST https://rpc.ledger.haratrust.io/read/ \
    -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'; sleep 0.5
done; echo

# Indexer + Blockscout catching up
ssh hara-stateless-2 'docker logs hara-indexer --tail 10; docker logs hara-blockscout --tail 10 2>&1 | tail -5'
```

All 200s + indexer tailing + explorer loads = cutover good.

**Then re-run 200×500** with the read/write split — with RPC on its own CPU this
should finally complete cleanly:
```bash
DEPLOYER_PRIVATE_KEY=$(jq -r .private_key ~/hara-ops/loadtest-deployer.json) \
RPC_WRITE_URL=https://rpc.ledger.haratrust.io/write/ \
RPC_READ_URL=https://rpc.ledger.haratrust.io/read/ \
npx tsx ops/load-tests/scenario-stress-200x500.ts 200 500
```

---

## 6. Phase E — decommission old hara-stateless

Only after Phase D is green and you've watched it for a bit (a few hours / a day):
```bash
# stop everything on the old host
ssh hara-stateless 'docker ps -q | xargs -r docker stop'
# remove its WG peer from the other hosts (reuse wg-add-peer logic in reverse, or
# hand-delete the [Peer] block for 10.43.0.20 on each host + wg syncconf)
# then destroy the VPS in the Nevacloud panel
```
Raise DNS TTL back to a normal value (e.g. 3600s) once stable.

---

## Rollback (per phase)

- **Through Phase B:** nothing switched — just `docker compose down` on the new
  boxes; prod still on old hara-stateless. Zero impact.
- **Phase C:** revert the DNS A records to old hara-stateless's IP and restart
  `hara-caddy` on the old host. Old stack is intact (you only `docker stop`ped
  Caddy). ~5 min back to known-good.
- **After Phase E:** point of no return — the old VPS is gone. Don't decommission
  until you're confident.

---

## Gotchas

1. **Blockscout env is gitignored** (has SECRET_KEY_BASE + DB creds). `git pull`
   won't carry it. **Copy it from old hara-stateless** and re-apply the
   `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true` line + the new RPC URL:
   ```bash
   scp hara-stateless:/opt/hara/hara-registry/deploy/services/blockscout/envs/common-blockscout.env \
       hara-stateless-2:/opt/hara/hara-registry/deploy/services/blockscout/envs/
   # then edit ETHEREUM_JSONRPC_*_URL → 10.43.0.21, confirm the FETCHER flag is present
   ```
2. **Obs history is lost** on the fresh box — Prometheus/Loki/Grafana volumes
   don't migrate. Acceptable (it's observability history, not chain state). If
   you care, snapshot the volumes and restore, but usually not worth it.
3. **Vault AppRole for signer:** hara-stateless-2's signer needs the same Vault
   AppRole creds (role_id/secret_id) the old host used — they're in
   `deploy/services/.env`. `secrets-bootstrap.sh` regenerates, or copy the .env.
4. **rpc-cache placement:** kept on the services host (hara-stateless-2) for
   Phase 1 simplicity — its upstream crosses WG to the LB on hara-rpc-1 (<1ms
   same-DC, negligible). Co-locating it on hara-rpc-1 is a later optimization
   that needs compose surgery; not worth it now.
5. **Don't start the new Caddy before DNS flips** — it'll fail ACME (domains
   resolve to the old IP) and may hit Let's Encrypt rate limits on retries.
   Start it only in Phase C step 3, after the DNS change.
6. **Validator RAM bump (8→16GB)** is independent — do it whenever you're next
   touching the validators; not part of this cutover.
