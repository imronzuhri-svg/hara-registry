# Nevacloud Deployment Runbook

**Document type:** step-by-step procedure to provision the 6-VPS Nevacloud cluster and bring up the full HaraLedger stack.
**Companion docs:** `deploy/topology.md` (architecture), `doc/product/nevacloud-proposal.md` (cost rationale).
**Pre-reqs:** the 7 pre-VPS gates in `deploy/topology.md` §9 — all closed as of 2026-05-22.

This is the single source of truth for "what to type and in what order" when going from a blank Nevacloud account to a running chain. Keep it open during the deploy.

> **2026-05-26 sim dry-run incorporated.** Every step in this runbook was
> rehearsed locally against the production-shape compose files
> (`deploy/sim/sim-up.sh`). 12 production-blocking bugs surfaced and were
> fixed — see `git log --grep "dry-run"` for the trail. The flow you're
> about to follow has been exercised end-to-end including: Vault Raft init
> + unseal, AppRole bootstrap, validator peering, RPC tier startup,
> services tier, anchor-worker PQ-key rotation, first PQ anchor on-chain
> (signature blob in MinIO + on-chain commitment + Postgres index row).
> If a step misbehaves, the sim is your first line of debugging — re-run
> `make sim-up` locally to reproduce.

---

## 1. VPS inventory

> **Current production topology (post RPC-host split, 2026-06-01).** The single
> `hara-stateless` host below was later split into a dedicated RPC tier
> (`hara-rpc-1`) and a services/observability/edge host (`hara-stateless-2`) — see
> `deploy/runbook-rpc-host-migration.md` for that migration and
> `deploy/topology.md` for the authoritative current map. The table below reflects
> the **current** split. The WireGuard mesh is **`10.43.0.0/24`** (each host also
> has a local `10.42.0.0/24` Docker bridge for same-host container DNS).
>
> ⚠ **The step-by-step bring-up below (Steps 4–9) was written for the original
> single `hara-stateless` host and still names it.** When provisioning the current
> split, map the **RPC nodes + HAProxy/LB** steps onto `hara-rpc-1` and the
> **signer / broadcaster / indexer / rpc-cache / Blockscout / observability /
> Caddy / anchor-worker** steps onto `hara-stateless-2` — or bring up the single
> host as written and then apply `deploy/runbook-rpc-host-migration.md`.

Order these from the Nevacloud panel.

| # | Hostname | Role | vCPU | RAM | Disk | WireGuard IP |
|---|---|---|---|---|---|---|
| 1 | `hara-v1` | Besu validator 1 | 4 | 8 GB | 100 GB NVMe | `10.43.0.11` |
| 2 | `hara-v2` | Besu validator 2 | 4 | 8 GB | 100 GB NVMe | `10.43.0.12` |
| 3 | `hara-v3` | Besu validator 3 | 4 | 8 GB | 100 GB NVMe | `10.43.0.13` |
| 4 | `hara-v4` | Besu validator 4 | 4 | 8 GB | 100 GB NVMe | `10.43.0.14` |
| 5 | `hara-rpc-1` | RPC tier: rpc-write + 2× rpc-read + HAProxy LB + autoheal | 8 | 23 GB | 300 GB NVMe | `10.43.0.21` |
| 6 | `hara-stateless-2` | signer + broadcaster + indexer + rpc-cache + Blockscout + observability + Caddy + anchor-worker | 6 | 15 GB | 200 GB NVMe | `10.43.0.25` |
| 7 | `hara-stateful` | Vault Raft + Postgres + Redis + MinIO + chain init | 8 | 32 GB | **1 TB NVMe** | `10.43.0.40` |
| — | (object storage) | Snapshots (Postgres + Vault Raft + validator data), off-host via rclone | — | — | 300 GB | — |

> Partner host `hara-did-stg` (`10.43.0.50`) also joins the mesh but is operated
> by the partner (not our SSH). For the original single-`hara-stateless`
> (8 vCPU / 32 GB / 500 GB, `10.43.0.20`, **now destroyed**) bring-up, see git
> history of this file before 2026-06-01.

**OS for all VPSes:** Ubuntu 24.04 LTS (the `cloud-init.yaml` is written against it). Ubuntu 22.04 also works.

**Region split (recommended):** put validators 1-2 in Jakarta, validators 3-4 in Surabaya. Stateful + stateless can go in either; keep them in the same region for low latency. This way a single-region outage costs ≤ 2 validators (QBFT still has quorum with 3 of 4).

**Why these specs:** `doc/product/nevacloud-proposal.md` §Bagian 2 sized them for the full 45-month projected workload (25,000 palm-oil batches × ~7,000 transfers each + 4M halal-passport NFTs). hara-stateful's 1 TB is sized to month 45; no mid-term resize required.

---

## 2. DNS records required (before TLS step)

Three (now four) A records, all pointing at the **services/edge host's** public
IP — `hara-stateless-2` (`103.169.206.239`), where Caddy runs:

| Hostname | Type | Value |
|---|---|---|
| `rpc.ledger.haratrust.io` | A | `<hara-stateless-2 public IP>` |
| `explorer.ledger.haratrust.io` | A | `<hara-stateless-2 public IP>` |
| `trace.ledger.haratrust.io` | A | `<hara-stateless-2 public IP>` |
| `grafana.platform.haratrust.io` | A | `<hara-stateless-2 public IP>` |

Caddy needs port 80 reachable for the Let's Encrypt HTTP-01 challenge. If you're testing on Indonesian DNS, propagation is usually ≤ 10 min.

If you don't have `haratrust.io` yet, you can substitute any domain you control — just update `deploy/edge/Caddyfile` to match.

---

## 3. Operator-laptop prep (one-time)

Before touching the Nevacloud panel:

```bash
# 1. Generate an SSH keypair if you don't already have one
ssh-keygen -t ed25519 -C "ops@hara" -f ~/.ssh/hara_ops_ed25519

# 2. Have these tools installed locally
gh --version             # GitHub CLI (for repo clone via private key flow if needed)
ssh --version            # OpenSSH 8+
docker --version         # to verify .trivyignore + image references locally
jq --version             # used by ops scripts
rclone version           # for object-storage backup configuration
age --version            # encrypts nightly backups before upload
age-keygen --version     # one-time keypair generation (deploy/ops/backup-setup.sh)

# 3. Make sure you can read the hara-registry repo on the VPSes — either:
#    a. Public repo: no auth needed; cloud-init clones via HTTPS
#    b. Private repo: add a read-only deploy token to cloud-init.yaml
```

Edit `deploy/ops/cloud-init.yaml` BEFORE pasting into the panel:

```yaml
users:
  - name: hara
    groups: [docker, sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ssh-ed25519 AAAA…YOUR_PUBLIC_KEY…  ops@hara   # ← REPLACE
```

Without that replacement you can't SSH into your own VPSes.

---

## 4. Step-by-step deployment

Hard ordering — the cross-host dependencies are real.

### Step 0 — Pre-flight checklist (do this BEFORE ordering VPSes)

```bash
cd hara-registry
# All 7 gates from topology.md §9 must be ✓ — verify with the drill scripts:
./deploy/ops/wg-local-test.sh                            # mesh validation
./deploy/ops/snapshot-restore-drill.sh                   # Postgres round-trip
./deploy/ops/validator-snapshot-restore-drill.sh         # validator data round-trip
./deploy/ops/secrets-bootstrap.sh init  # (in a sandbox dir — dry-run)
```

All four should exit `0`. If any fail, fix locally before spending money on VPSes.

---

### Step 1 — Provision 6 VPSes in the Nevacloud panel (~15 minutes total)

For each of the 6 hostnames in §1:

1. Panel → Create VPS.
2. Choose Ubuntu 24.04 LTS.
3. Pick the region per §1 (Jakarta or Surabaya).
4. Pick the spec per §1 (4×4-core/8GB for validators, 2×8-core/32GB for stateful + stateless).
5. **If the panel has a User Data / Init Script field**: paste the entire contents of `deploy/ops/cloud-init.yaml`. This is what makes the VPS come up with Docker, the hara user, WireGuard, UFW, fail2ban, node_exporter — all already configured.

   **If the panel has no User Data field** (as of 2026-05, Nevacloud's standard plans don't): you'll bootstrap each VPS manually with the equivalent script. After the VPS is provisioned and you can SSH in (with whatever credentials Nevacloud emails you — typically root + a temporary password):

   ```bash
   # On operator laptop
   scp deploy/ops/bootstrap-vps.sh root@<vps-public-ip>:/root/
   ssh root@<vps-public-ip> 'bash /root/bootstrap-vps.sh'
   ```

   The script is idempotent — re-run safely if it fails partway. After it finishes, root password login is disabled and you can only reach the VPS as `ssh hara@<vps>` using your ed25519 ops key.

6. Submit.

Wait for all 6 to show **"running"** and accept SSH at port 22. Total elapsed: ~10–15 minutes.

**Verify each:**

```bash
ssh hara@<vps_public_ip> 'docker --version && wg --version'
# Expect: Docker 24+ and wireguard-tools 1.0+
```

---

### Step 2 — Build the hosts file (operator laptop)

Create `vps-hosts.env` on your laptop (DO NOT commit this file — public IPs are sensitive enough that you don't want them in git):

```bash
cat > ~/hara-ops/vps-hosts.env <<EOF
hara-v1=<public IP of hara-v1>
hara-v2=<public IP of hara-v2>
hara-v3=<public IP of hara-v3>
hara-v4=<public IP of hara-v4>
hara-stateful=<public IP of hara-stateful>
hara-stateless=<public IP of hara-stateless>
EOF
chmod 600 ~/hara-ops/vps-hosts.env
```

---

### Step 3 — WireGuard mesh bootstrap (~2 minutes)

From operator laptop:

```bash
cd hara-registry
HOSTS_FILE=~/hara-ops/vps-hosts.env SSH_USER=hara ./deploy/ops/wg-bootstrap.sh
```

This SSHes to each VPS, generates a WireGuard keypair, collects public keys, renders `/etc/wireguard/wg0.conf` on every host with peers for every other host, and pings all 30 mesh edges (6 × 5) at the end.

**Expected output (last line):**

```
✓ Mesh fully connected (30 edges)
```

If it fails: the most common cause is UDP port 51820 being blocked. Open it in Nevacloud's firewall panel for each VPS, then re-run.

---

### Step 4 — Bring up `hara-stateful` (~10 minutes)

This VPS must be up FIRST because everything else needs Vault keys + Postgres + MinIO bucket layout that comes from here.

```bash
ssh hara@hara-stateful
cd /opt/hara-registry      # cloud-init clones the repo here

# 4a — Generate the 5 .env files
./deploy/ops/secrets-bootstrap.sh init
# Will print: Vault token, Grafana password, Postgres password, MinIO password.
# COPY ALL FOUR TO YOUR PASSWORD MANAGER right now.
# Then append IMAGE_REGISTRY to every .env so docker compose pulls images
# from GHCR instead of trying to build them locally:
for f in deploy/{platform,data,services,chain,rpc}/.env; do
  echo 'IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/' >> "$f"
done
# After copying, secure the files: chmod 600 deploy/*/.env
ls -la deploy/{platform,data,services,chain,rpc}/.env
# All should be -rw-------

# 4b — Bring up Vault (Raft mode, sealed initially)
docker compose -f deploy/platform/docker-compose.secrets.yml \
               --env-file deploy/platform/.env up -d
# Verify Vault container is healthy (it will be 'unhealthy' until you init+unseal):
docker ps --filter name=hara-vault

# 4c — Initialise + unseal Vault (one-time)
./deploy/ops/vault-raft-init.sh
# Outputs vault-init-keys.json with 5 unseal keys + root token.
# CRITICAL: copy this OUT of the VPS now. Each key goes in your team's
# password manager as a SEPARATE item (so one compromise yields ≤ 1 key).
scp hara@hara-stateful:/opt/hara-registry/vault-init-keys.json ~/hara-ops/
ssh hara@hara-stateful 'shred -u /opt/hara-registry/vault-init-keys.json'
# After this, Vault is unsealed; service ready.

# 4d — Create AppRole policies + per-role credentials
ssh hara@hara-stateful
cd /opt/hara-registry
VAULT_TOKEN=$(jq -r .root_token ~/hara-ops/vault-init-keys.json) \
  ./deploy/ops/vault-approle-bootstrap.sh
# Outputs validator / signer / anchor-worker role_id + secret_id pairs.
# Save these — they go into the per-VPS .env files in steps 5 + 6 + 7.

# 4e — Bring up Postgres + Redis
docker compose -f deploy/data/docker-compose.yml --env-file deploy/data/.env up -d
# Wait for healthy:
until docker exec hara-postgres pg_isready -U hara -d hara_indexer; do sleep 2; done

# 4f — Bring up MinIO + create buckets
docker compose -f deploy/data/docker-compose.minio.yml \
               --env-file deploy/data/.env up -d
# The hara-minio-init sidecar creates buckets hara-chain-config + hara-pq-anchors.
docker logs hara-minio-init  # Look for "✓ MinIO bucket bootstrap complete"

# 4g — Run the chain init container
# This generates QBFT genesis at deploy/chain/genesis/genesis.json (host
# bind-mount), writes 4 validator keys to Vault, and produces
# static-nodes.json on the chain-shared docker volume.
docker compose -f deploy/chain/docker-compose.yml \
               --env-file deploy/chain/.env run --rm init
# Expect: "✔ HaraLedger bootstrap complete" + 4 validator key paths in Vault.

# 4h — Upload genesis.json to MinIO so validator + rpc VPSes can pull it later.
# The hara-chain-config bucket is anonymous-download inside the mesh
# (configured by minio-init in docker-compose.minio.yml).
docker run --rm --network hara-platform \
  -v /opt/hara-registry/deploy/chain/genesis:/work:ro \
  --entrypoint sh minio/mc:RELEASE.2025-08-13T08-35-41Z \
  -c "mc alias set h http://hara-minio:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" &&
      mc cp /work/genesis.json h/hara-chain-config/genesis.json"
# Validators + hara-stateless will pull this in steps 5a / 6e.
# (scp from hara-stateful is the equivalent backup path if MinIO isn't reachable.)
```

**Verification after Step 4:**

```bash
# Vault unsealed
docker exec hara-vault vault status | grep Sealed
# Sealed: false

# 4 validator keys in Vault
VAULT_TOKEN=$(jq -r .root_token ~/hara-ops/vault-init-keys.json) \
  docker exec -e VAULT_TOKEN hara-vault \
  vault kv list secret/haraledger/validators/
# Lists 1, 2, 3, 4

# MinIO buckets exist
docker exec hara-minio mc ls hara/
# hara-chain-config/ + hara-pq-anchors/

# Postgres reachable
docker exec hara-postgres psql -U hara -d hara_indexer -c 'SELECT 1'
```

---

### Step 5 — Bring up validators (4 VPSes in parallel, ~5 min total)

On each of `hara-v1`, `hara-v2`, `hara-v3`, `hara-v4`:

```bash
ssh hara@hara-v1     # repeat for v2, v3, v4 — same procedure, different ID

cd /opt/hara-registry

# 5a — Pull genesis.json from MinIO BEFORE the validator starts.
# Validators bind-mount ./genesis from disk; chain init writes it on
# hara-stateful but it's not in the repo on validator VPSes by default.
# Distribute via MinIO (hara-chain-config bucket — public-read inside mesh):
mkdir -p deploy/chain/genesis
docker run --rm --network host \
  --entrypoint sh minio/mc:RELEASE.2025-08-13T08-35-41Z \
  -c "mc alias set h http://10.42.0.42:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD &&
      mc cp h/hara-chain-config/genesis.json /tmp/genesis.json"
# Then copy out of the throwaway container — OR scp from hara-stateful:
scp hara@hara-stateful:/opt/hara-registry/deploy/chain/genesis/genesis.json \
    deploy/chain/genesis/genesis.json

# 5b — Edit chain/.env with the per-host VALIDATOR_ID + AppRole creds
cat > chain/.env <<EOF
VALIDATOR_ID=1                        # use 2, 3, 4 on the other hosts
VAULT_ADDR=http://10.42.0.40:8200
VAULT_APPROLE_ID=<validator role_id from step 4d>
VAULT_APPROLE_SECRET=<validator secret_id from step 4d>
HARA_CHAIN_ID=131216
HARA_BLOCK_PERIOD_SECONDS=2
HARA_VALIDATOR_COUNT=4
IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/
BACKUP_AGE_RECIPIENT=age1...    # from deploy/ops/backup-setup.sh
EOF
chmod 600 chain/.env

# 5c — Bring up just this validator
docker compose -f deploy/chain/docker-compose.validator-only.yml \
               --env-file chain/.env up -d

# 5c — Watch logs until "Imported #N" appears (consensus running)
docker logs -f hara-validator${VALIDATOR_ID}
```

**Verify all 4 are peered:**

After all 4 validators are up, on hara-stateless (we'll bring it up next, but for verification you can also probe directly):

```bash
# From any validator
ssh hara@hara-v1 'curl -s --connect-timeout 2 -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"qbft_getValidatorsByBlockNumber\",\"params\":[\"latest\"],\"id\":1}" \
  http://localhost:8545'
# Should return 4 addresses
```

The chain starts producing blocks as soon as 3 of 4 validators are peered.

---

### Step 6 — Bring up `hara-stateless` (~10 minutes)

```bash
ssh hara@hara-stateless
cd /opt/hara-registry

# 6a — Edit .env files for services + rpc + obs + data
# Most envs were pre-generated by secrets-bootstrap.sh on stateful in step 4a;
# scp them over OR regenerate locally:
scp hara@hara-stateful:/opt/hara-registry/deploy/services/.env deploy/services/.env
scp hara@hara-stateful:/opt/hara-registry/deploy/rpc/.env       deploy/rpc/.env
scp hara@hara-stateful:/opt/hara-registry/deploy/platform/.env  deploy/platform/.env
scp hara@hara-stateful:/opt/hara-registry/deploy/data/.env      deploy/data/.env

# 6b — Inject the SIGNER AppRole creds from step 4d into services/.env
cat >> deploy/services/.env <<EOF
VAULT_APPROLE_ID=<signer role_id from step 4d>
VAULT_APPROLE_SECRET=<signer secret_id from step 4d>
EOF

# 6c — Generate the anchor-worker signer key (fresh ECDSA wallet) + pre-fund it.
# Vault has the AppRole *policy* allowing read at
# secret/haraledger/signer-keys/anchor-worker, but the *secret* itself isn't
# seeded by vault-approle-bootstrap.sh. seed-anchor-key.sh handles both.
ANCHOR_INFO=$(docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  wallet new --json)
ANCHOR_ADDR=$(echo "$ANCHOR_INFO" | jq -r '.[0].address')
ANCHOR_KEY=$(echo  "$ANCHOR_INFO" | jq -r '.[0].private_key')
echo "Anchor-worker address: $ANCHOR_ADDR"
echo "Anchor-worker key:     $ANCHOR_KEY"
# Save BOTH to your password manager NOW. Losing the key means re-deploying
# PQAnchorRegistry with a fresh ANCHOR_WORKER_ADDRESS.

# Seed Vault (from hara-stateless, reaching Vault over the mesh)
ANCHOR_ADDRESS=$ANCHOR_ADDR ANCHOR_PRIVATE_KEY=$ANCHOR_KEY \
  VAULT_ADDR=http://10.42.0.40:8200 \
  VAULT_TOKEN=$(ssh hara@hara-stateful 'cat ~/hara-ops/vault-init-keys.json | jq -r .root_token') \
  ./deploy/ops/seed-anchor-key.sh

# Pre-fund the anchor-worker (deploys silently drop zero-balance txs on Besu)
docker run --rm --network host --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  send --legacy --gas-price 0 --value 1ether $ANCHOR_ADDR \
  --rpc-url http://localhost:8545 \
  --private-key <production deployer key>

# Stash for step 7
echo "ANCHOR_WORKER_ADDRESS=$ANCHOR_ADDR" >> deploy/services/.env

# 6d — Inject the ANCHOR-WORKER AppRole creds from step 4d into anchor-worker env
cat >> deploy/services/.env <<EOF
ANCHOR_APPROLE_ID=<anchor-worker role_id from step 4d>
ANCHOR_APPROLE_SECRET=<anchor-worker secret_id from step 4d>
EOF

# 6e — Pull genesis.json (needed by rpc-read-1/2/3 + rpc-write — they share
# the same compose mount as the validators do)
mkdir -p deploy/chain/genesis
scp hara@hara-stateful:/opt/hara-registry/deploy/chain/genesis/genesis.json \
    deploy/chain/genesis/genesis.json

# 6f — Bring up RPC tier
docker compose -f deploy/rpc/docker-compose.yml --env-file deploy/rpc/.env up -d

# Wait for RPC to be healthy
until curl -s -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       http://localhost:8545 | grep -q result
do sleep 5; done
echo "✓ RPC reachable"

# 6g — Bring up services (anchor-worker is included; it will refuse to start
# until step 7 deploys PQAnchorRegistry with ANCHOR_WORKER_ADDRESS set)
docker compose -f deploy/services/docker-compose.yml \
               --env-file deploy/services/.env up -d \
               migrate signer broadcaster indexer rpc-cache \
               blockscout-db-init blockscout blockscout-fe
# anchor-worker started separately after step 7

# 6h — Bring up observability
docker compose -f deploy/platform/docker-compose.obs.yml \
               --env-file deploy/platform/.env up -d
# Grafana auto-provisions datasources for Prometheus + Loki + Tempo

# 6i — Bring up Caddy (TLS edge)
# Pre-check: DNS A records for rpc.ledger.haratrust.io / explorer.ledger.haratrust.io / grafana.platform.haratrust.io
# MUST already point at this VPS. Caddy needs port 80 reachable for ACME.
docker compose -f deploy/edge/docker-compose.yml up -d
# Wait for Caddy to issue certs:
docker logs -f hara-caddy | grep -E 'certificate obtained|error'
# Expect 3 "certificate obtained" lines (one per hostname).
```

---

### Step 7 — Deploy contracts (~3 minutes)

From operator laptop (or any host with foundry installed):

```bash
cd hara-registry
# Tunnel through the WG mesh to the RPC tier's HAProxy on hara-rpc-1:
ssh -L 8545:10.43.0.21:8545 hara@hara-rpc-1 &

# CRITICAL: ANCHOR_WORKER_ADDRESS must match the address you seeded into
# Vault in step 6c. Without it, the PQAnchorRegistry deploys WITHOUT the
# ANCHOR_ROLE / KEY_ROTATOR_ROLE grants and anchor-worker will fail-loop
# trying to rotate the placeholder PQ key hash.
DEPLOYER_PRIVATE_KEY=<production deployer key, NOT anvil-0> \
  ANCHOR_WORKER_ADDRESS=<same ANCHOR_ADDR from step 6c> \
  make deploy-all
# Deploys 7 system contracts, grants on-chain roles to anchor-worker,
# and auto-registers all contracts in watched_contracts.
```

For the FIRST deploy you can use the anvil-0 well-known key just to validate the path; for any real anchor traffic, generate a new deployer keypair, store it in Vault, pre-fund 1 wei.

**Verify the role grants succeeded:**

```bash
# Look for these two transactions in the broadcast file:
grep -c '"function": "grantRole(bytes32,address)"' \
  contracts/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json
# Expect: 2  (one for ANCHOR_ROLE, one for KEY_ROTATOR_ROLE)
```

**Capture the PQAnchorRegistry address and start the anchor-worker:**

```bash
# On operator laptop (or wherever you ran make deploy-all)
ADDR=$(jq -r '.transactions[] | select(.contractName=="PQAnchorRegistry") | .contractAddress' \
  contracts/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json | head -1)
echo "PQAnchorRegistry: $ADDR"

# Push the address into hara-stateless's services env and start the worker
ssh hara@hara-stateless "
  echo 'PQ_ANCHOR_REGISTRY_ADDRESS=$ADDR' >> /opt/hara-registry/deploy/services/.env
  cd /opt/hara-registry
  docker compose -f deploy/services/docker-compose.yml \
                 --env-file deploy/services/.env up -d anchor-worker
"

# Confirm anchor-worker is healthy (NOT crash-looping)
ssh hara@hara-stateless 'docker logs hara-anchor-worker --tail 10'
# Expect: 'rotated PQ key on-chain' then 'entering main loop'.
```

**Verify all 7 contracts on chain:**

```bash
docker exec hara-postgres psql -U hara -d hara_indexer \
  -c "SELECT name, contract_address FROM watched_contracts ORDER BY name"
# Expect 7 rows: AnchorRegistry, ContractRegistry, GovernanceContract,
# HaraPalmOil, IssuerRegistry, PQAnchorRegistry, TraceabilityBatchRelay.
```

---

### Step 8 — Public-health verification (~5 minutes)

From operator laptop, NOT via SSH tunnel:

```bash
# RPC read endpoint
curl -s -X POST https://rpc.ledger.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# Expect: {"jsonrpc":"2.0","id":1,"result":"0x..."}

# Block explorer
curl -sI https://explorer.ledger.haratrust.io/ | head -1
# Expect: HTTP/2 200

# Grafana
curl -sI https://grafana.platform.haratrust.io/ | head -1
# Expect: HTTP/2 200 (login page)

# WebSocket (will need wscat or similar — short connect test)
echo '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  | wscat -c wss://rpc.ledger.haratrust.io/ws
```

If any return 5xx: check Caddy logs (`docker logs hara-caddy` on hara-stateless) for cert / upstream errors.

**Wait one anchor cycle (~10 min default) and verify the PQ audit chain end-to-end:**

```bash
# 1. On-chain anchor count should increment (was 0 right after step 7)
ssh hara@hara-stateless 'docker run --rm --network hara-platform \
  --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  call <PQAnchorRegistry-addr> "anchorCount()(uint256)" \
  --rpc-url http://lb:8545/rpc/read'
# Expect: 1 or higher

# 2. Signature blob in MinIO
ssh hara@hara-stateful 'docker exec hara-minio mc ls h/hara-pq-anchors/ml-dsa-65/'
# Expect: at least one *.sig file (~3 KiB each)

# 3. Postgres index row
ssh hara@hara-stateful "docker exec hara-postgres psql -U hara -d hara_indexer -c \
  \"SELECT encode(commitment_hash,'hex'), algo, encode(anchor_tx_hash,'hex'), object_key, size_bytes
    FROM pq_anchor_signatures ORDER BY created_at DESC LIMIT 3\""
# Expect: at least one row with algo='ML-DSA-65' and size_bytes ~3300
```

If anchor-worker logs show "anchor cycle: ready to submit" but no on-chain
record after one cycle, check that the address from step 6c was actually
funded (`cast balance $ANCHOR_ADDR`) — Besu silently drops zero-balance
transactions.

---

### Step 9 — Snapshot timers (~5 minutes)

All three nightly snapshot timers are installed by one role-aware script,
`deploy/ops/install-backup-timers.sh`. It detects the host's role from the
hostname, writes the `*.service`/`*.timer` units, and enables the timer. Run it
**on each host** with sudo:

```bash
# hara-stateful: Postgres (02:00) + Vault Raft (04:00)
ssh hara@hara-stateful 'cd /opt/hara-registry && \
  sudo ./deploy/ops/install-backup-timers.sh postgres && \
  sudo ./deploy/ops/install-backup-timers.sh vault'

# each validator: chain-data snapshot, auto-staggered 03:00/03:15/03:30/03:45
for v in hara-v1 hara-v2 hara-v3 hara-v4; do
  ssh hara@$v 'cd /opt/hara-registry && sudo ./deploy/ops/install-backup-timers.sh'
done
```

Each unit reads its config from `deploy/ops/backup.env` (referenced as an
optional `EnvironmentFile`). Populate it **before** the first run:

- `BACKUP_AGE_RECIPIENT=age1…` — required on every host (from `backup-setup.sh`).
- **hara-stateful (vault):** `RCLONE_TARGET=nevacloud-s3:hara-backups-vault`,
  `SNAPSHOT_DIR=/var/backups/hara/vault` (keeps snapshots out of the repo dir,
  alongside the Postgres backups), plus the **non-root snapshotter** AppRole from
  `vault-approle-bootstrap.sh`: `VAULT_APPROLE_ID=…` / `VAULT_APPROLE_SECRET=…`
  (the `[vault-snapshot]` pair). `vault-raft-snapshot.sh` logs in with it per
  run — the root token is never used.

Validator timers stagger by index so only one validator is briefly stopped at a
time (QBFT keeps quorum with 3 of 4). Verify on any host:

```bash
systemctl list-timers 'hara-*-snapshot.timer'
# dry-run one immediately and read the log:
sudo systemctl start hara-vault-snapshot.service
journalctl -u hara-vault-snapshot.service -n 40 --no-pager
```

> Note: the script auto-detects the repo path (`/opt/hara-registry`,
> `/opt/hara/hara-registry`, or the legacy `/opt/hara/hara-ledger`); override
> with `REPO=` if your checkout is elsewhere.

---

### Step 10 — Apply branch protection on GitHub (~2 minutes — operator UI task)

This isn't a VPS step but it should happen before any non-maintainer pushes to main:

1. https://github.com/imronzuhri-svg/hara-registry/settings/branches → Add rule.
2. Pattern: `main`.
3. Required status checks — use the **stable per-workflow gate jobs**. Each
   gate always runs on every PR (even when its area is untouched) and reports a
   single conclusion, so a path-filtered PR no longer hangs forever "waiting"
   for a check that never starts:
   - `Gitleaks` (the secret-scan workflow's job — already required)
   - `Analyze (actions)` + `Analyze (javascript-typescript)` (CodeQL — already required)
   - `contracts-gate`
   - `services-gate`
   - `slither-gate`
   - `echidna-gate`

   > Do **not** add the individual matrix jobs (`services / typecheck + build
   > (signer)`, `contracts / forge build + test`, etc.) to the required set —
   > they're path-gated and skip silently when their area is untouched, which
   > would block unrelated PRs. The `*-gate` jobs aggregate them: a gate is green
   > when its underlying jobs passed **or** were skipped, red when any failed.
4. Require linear history: ON.
5. Require PR before merge with 1 approval: ON (raise to 2 when team grows).
6. Allow force pushes: OFF. Allow deletions: OFF.

---

## 5. Total time

If everything goes smoothly: **~60-90 minutes** from "ordering VPSes" to "consumer can scan a QR and hit the verification API."

Realistic with one or two stumbles: ~3 hours for first-time operator.

| Step | Time |
|---|---|
| 1. Provision 6 VPSes in panel | 15 min |
| 2. Build vps-hosts.env | 2 min |
| 3. WireGuard mesh bootstrap | 2 min |
| 4. hara-stateful bring-up | 10 min |
| 5. Validators (parallel) | 5 min |
| 6. hara-stateless bring-up | 10 min |
| 7. Deploy contracts | 3 min |
| 8. Public-health verification | 5 min |
| 9. Snapshot crons | 5 min |
| 10. Branch protection (parallel) | 2 min |
| Total | ~60 min |

---

## 6. Failure-mode quick reference

| Symptom | Diagnosis | Fix |
|---|---|---|
| `wg-bootstrap.sh` reports unreachable peers | UDP 51820 blocked by Nevacloud firewall | Open UDP 51820 in panel for all 6 VPSes |
| Validators stuck "Fetching validator N key from Vault" + 404 | Vault sealed OR Raft re-init wiped keys | `vault operator unseal <key>` × 3 OR re-run init |
| `make deploy-all` fails with "zero balance sender" | Deployer wallet has 0 wei native HARA | `cast send --value 1 --legacy --gas-price 0 <addr>` from a pre-funded account |
| RPC returns 503 | All upstream Besu RPC nodes down OR LB can't resolve them | `docker ps | grep rpc-` to find the dead one; `docker logs hara-rpc-read-1` |
| Caddy "certificate not obtained" | DNS A record points elsewhere OR port 80 blocked | Verify `dig +short rpc.ledger.haratrust.io` returns hara-stateless IP; open port 80 |
| Indexer shows no events | watched_contracts empty after wipe + redeploy | `make register-watched` |
| Anchor-worker refuses to start (zero balance) | Anchor signer not pre-funded | `cast send` 1 wei to the anchor address from the deployer |
| Chain halts after a single VPS reboot | QBFT lost quorum (2 of 4 down) | Bring the dead validators back; chain auto-resumes when 3 of 4 alive |
| Besu boots and crash-loops with `Unable to load genesis file ... /opt/besu/genesis/genesis.json` | `deploy/chain/genesis/` is empty on this VPS (init ran on hara-stateful only) | `scp hara@hara-stateful:/opt/hara-registry/deploy/chain/genesis/genesis.json deploy/chain/genesis/` then restart |
| Anchor-worker crash-loops with `Vault fetch failed: 404` | The anchor-worker signer key isn't seeded yet | Run `deploy/ops/seed-anchor-key.sh` with `ANCHOR_ADDRESS` + `ANCHOR_PRIVATE_KEY` env vars set; restart worker |
| Anchor-worker crash-loops with `rotatePQKey reverted ... 0xe2517d3f` | `AccessControlUnauthorizedAccount` — worker address doesn't have `KEY_ROTATOR_ROLE` | Either: (a) redeploy with `ANCHOR_WORKER_ADDRESS=<addr>` set, or (b) `cast send <PQAnchorRegistry> grantRole(bytes32,address) $(cast keccak ANCHOR_ROLE) <addr>` then again for `KEY_ROTATOR_ROLE` |
| `external volume "chain-shared" not found` when starting rpc tier | `chain-shared` volume not yet created (chain init hasn't run on this host) | Either run chain init here first, or scp `genesis.json` over and start without the shared volume |
| `docker compose ... up` fails with `required variable X is missing` | One of the per-role .env files is incomplete (added env var, .env not regenerated) | Re-run `secrets-bootstrap.sh init` on hara-stateful and `scp` the updated .env files |

---

## 7. What this runbook does NOT cover

Tracked elsewhere, follow up after the initial bring-up:

- **Huawei DR layer** (P2 — month ~12). See `doc/product/nevacloud-proposal.md` §Bagian DR.
- **K3s migration** for the stateless tier. P1 work.
- **HSM-backed Vault** (Cloud KMS). P2+.
- **IOTA L1 anchoring** for the audit anchors. P1+.
- **CDN edge** (Cloudflare Workers) for the hara-passport public verification API. Month 18+.
- **hara-did + hara-halal-passport** deployment — separate repos, similar pattern, use reserved IPs `10.42.0.50-69` and `.70-89`.

---

## 8. Roll-back

If the deploy goes badly enough that you want to start over:

```bash
# On hara-stateful:
docker compose -f deploy/data/docker-compose.minio.yml down -v
docker compose -f deploy/data/docker-compose.yml down -v
docker compose -f deploy/platform/docker-compose.secrets.yml down -v
rm -rf chain/data chain/generated chain/genesis/genesis.json chain/static-nodes.json
shred -u vault-init-keys.json   # if not already removed

# On each validator VPS:
docker compose -f deploy/chain/docker-compose.validator-only.yml down -v

# On hara-stateless:
docker compose -f deploy/edge/docker-compose.yml down -v
docker compose -f deploy/platform/docker-compose.obs.yml down -v
docker compose -f deploy/services/docker-compose.yml down -v
docker compose -f deploy/rpc/docker-compose.yml down -v
```

This leaves the VPSes themselves intact (you don't lose your panel-provisioned hosts), just wipes the application + chain state. Re-run from Step 4.

If you want to delete the VPSes entirely: do that from the Nevacloud panel one by one. Charges stop at deletion.

---

## 9. Done. Now what?

- Subscribe BPJPH / LPH / MUI staff as registered issuers via `IssuerRegistry.register(...)`.
- Wire hara-did and hara-halal-passport into the deployed `PQ_ANCHOR_REGISTRY_ADDRESS` (it's in `make deploy-all`'s broadcast output).
- Run the first real palm-oil batch end-to-end as a verification: mint → 3 hops → verify via `/trace/batch/:id/graph` on the Grafana dashboard.
