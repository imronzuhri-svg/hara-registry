# Nevacloud Deployment Runbook

**Document type:** step-by-step procedure to provision the 6-VPS Nevacloud cluster and bring up the full HaraLedger stack.
**Companion docs:** `deploy/topology.md` (architecture), `doc/nevacloud-proposal.md` (cost rationale).
**Pre-reqs:** the 7 pre-VPS gates in `deploy/topology.md` §9 — all closed as of 2026-05-22.

This is the single source of truth for "what to type and in what order" when going from a blank Nevacloud account to a running chain. Keep it open during the deploy.

---

## 1. VPS inventory (Option B — recommended)

Order these from the Nevacloud panel. Total ~Rp 7.3M / month.

| # | Hostname | Role | vCPU | RAM | Disk | Monthly | WireGuard IP |
|---|---|---|---|---|---|---|---|
| 1 | `hara-v1` | Besu validator 1 | 4 | 8 GB | 100 GB NVMe | Rp 700K | `10.42.0.11` |
| 2 | `hara-v2` | Besu validator 2 | 4 | 8 GB | 100 GB NVMe | Rp 700K | `10.42.0.12` |
| 3 | `hara-v3` | Besu validator 3 | 4 | 8 GB | 100 GB NVMe | Rp 700K | `10.42.0.13` |
| 4 | `hara-v4` | Besu validator 4 | 4 | 8 GB | 100 GB NVMe | Rp 700K | `10.42.0.14` |
| 5 | `hara-stateful` | Vault Raft + Postgres + Redis + MinIO + chain init | 8 | 32 GB | **1 TB NVMe** | Rp 2.5M | `10.42.0.40` |
| 6 | `hara-stateless` | RPC nodes + LB + signer + broadcaster + indexer + rpc-cache + Blockscout + observability + Caddy + anchor-worker | 8 | 32 GB | 500 GB NVMe | Rp 1.7M | `10.42.0.20` |
| — | (object storage) | Snapshots (Postgres + Vault Raft + validator data) | — | — | 300 GB | Rp 300K | — |

**OS for all VPSes:** Ubuntu 24.04 LTS (the `cloud-init.yaml` is written against it). Ubuntu 22.04 also works.

**Region split (recommended):** put validators 1-2 in Jakarta, validators 3-4 in Surabaya. Stateful + stateless can go in either; keep them in the same region for low latency. This way a single-region outage costs ≤ 2 validators (QBFT still has quorum with 3 of 4).

**Why these specs:** `doc/nevacloud-proposal.md` §Bagian 2 sized them for the full 45-month projected workload (25,000 palm-oil batches × ~7,000 transfers each + 4M halal-passport NFTs). hara-stateful's 1 TB is sized to month 45; no mid-term resize required.

---

## 2. DNS records required (before TLS step)

Three A records, all pointing at `hara-stateless`'s public IP:

| Hostname | Type | Value |
|---|---|---|
| `rpc.haratrust.io` | A | `<hara-stateless public IP>` |
| `explorer.haratrust.io` | A | `<hara-stateless public IP>` |
| `grafana.haratrust.io` | A | `<hara-stateless public IP>` |

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

# 3. Make sure you can read the hara-ledger repo on the VPSes — either:
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
cd hara-ledger
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
5. **Paste the entire contents of `deploy/ops/cloud-init.yaml` into the User Data / Init Script field.** This is what makes the VPS come up with Docker, the hara user, WireGuard, UFW, fail2ban, node_exporter — all already configured.
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
cd hara-ledger
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
cd /opt/hara-ledger      # cloud-init clones the repo here

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
scp hara@hara-stateful:/opt/hara-ledger/vault-init-keys.json ~/hara-ops/
ssh hara@hara-stateful 'shred -u /opt/hara-ledger/vault-init-keys.json'
# After this, Vault is unsealed; service ready.

# 4d — Create AppRole policies + per-role credentials
ssh hara@hara-stateful
cd /opt/hara-ledger
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
# This generates QBFT genesis, writes 4 validator keys to Vault, and uploads
# genesis.json + static-nodes.json to the hara-chain-config MinIO bucket.
docker compose -f deploy/chain/docker-compose.yml \
               --env-file deploy/chain/.env run --rm init
# Expect: "✔ HaraLedger bootstrap complete" + 4 validator key paths in Vault.
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

cd /opt/hara-ledger

# 5a — Edit chain/.env with the per-host VALIDATOR_ID + AppRole creds
cat > chain/.env <<EOF
VALIDATOR_ID=1                        # use 2, 3, 4 on the other hosts
VAULT_ADDR=http://10.42.0.40:8200
VAULT_APPROLE_ID=<validator role_id from step 4d>
VAULT_APPROLE_SECRET=<validator secret_id from step 4d>
HARA_CHAIN_ID=131216
HARA_BLOCK_PERIOD_SECONDS=2
HARA_VALIDATOR_COUNT=4
EOF
chmod 600 chain/.env

# 5b — Bring up just this validator
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
cd /opt/hara-ledger

# 6a — Edit .env files for services + rpc + obs
# Most envs were pre-generated by secrets-bootstrap.sh on stateful in step 4a;
# scp them over OR regenerate locally:
scp hara@hara-stateful:/opt/hara-ledger/deploy/services/.env deploy/services/.env
scp hara@hara-stateful:/opt/hara-ledger/deploy/rpc/.env       deploy/rpc/.env
scp hara@hara-stateful:/opt/hara-ledger/deploy/platform/.env  deploy/platform/.env

# 6b — Inject the SIGNER AppRole creds from step 4d into services/.env
cat >> deploy/services/.env <<EOF
VAULT_APPROLE_ID=<signer role_id from step 4d>
VAULT_APPROLE_SECRET=<signer secret_id from step 4d>
EOF

# 6c — Inject the ANCHOR-WORKER AppRole creds from step 4d into anchor-worker env
# (anchor-worker reads these from its own env block in compose)

# 6d — Bring up RPC tier
docker compose -f deploy/rpc/docker-compose.yml --env-file deploy/rpc/.env up -d

# Wait for RPC to be healthy
until curl -s -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       http://localhost:8545 | grep -q result
do sleep 5; done
echo "✓ RPC reachable"

# 6e — Bring up services
docker compose -f deploy/services/docker-compose.yml \
               --env-file deploy/services/.env up -d

# 6f — Bring up observability
docker compose -f deploy/platform/docker-compose.obs.yml up -d
# Grafana auto-provisions datasources for Prometheus + Loki + Tempo

# 6g — Bring up Caddy (TLS edge)
# Pre-check: DNS A records for rpc.haratrust.io / explorer.haratrust.io / grafana.haratrust.io
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
cd hara-ledger
# Tunnel through the WG mesh:
ssh -L 8545:10.42.0.20:8545 hara@hara-stateless &

# Now your local foundry talks to the prod chain via localhost:8545
DEPLOYER_PRIVATE_KEY=<production deployer key, NOT anvil-0> \
  make deploy-all
# Deploys 7 system contracts + auto-registers them in watched_contracts.
```

For the FIRST deploy you can use the anvil-0 well-known key just to validate the path; for any real anchor traffic, generate a new keypair, store it in Vault, pre-fund 1 wei.

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
curl -s -X POST https://rpc.haratrust.io/read/ \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# Expect: {"jsonrpc":"2.0","id":1,"result":"0x..."}

# Block explorer
curl -sI https://explorer.haratrust.io/ | head -1
# Expect: HTTP/2 200

# Grafana
curl -sI https://grafana.haratrust.io/ | head -1
# Expect: HTTP/2 200 (login page)

# WebSocket (will need wscat or similar — short connect test)
echo '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  | wscat -c wss://rpc.haratrust.io/ws
```

If any return 5xx: check Caddy logs (`docker logs hara-caddy` on hara-stateless) for cert / upstream errors.

---

### Step 9 — Snapshot crons (~5 minutes)

Set up nightly snapshots on hara-stateful via systemd timers:

```bash
ssh hara@hara-stateful
sudo tee /etc/systemd/system/hara-postgres-snapshot.service > /dev/null <<EOF
[Unit]
Description=Nightly Postgres backup to object storage
[Service]
Type=oneshot
WorkingDirectory=/opt/hara-ledger
ExecStart=/opt/hara-ledger/deploy/ops/snapshot-postgres.sh
User=hara
EOF
sudo tee /etc/systemd/system/hara-postgres-snapshot.timer > /dev/null <<EOF
[Unit]
Description=Run postgres snapshot nightly at 02:00 local
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now hara-postgres-snapshot.timer

# Repeat for vault-raft-snapshot.sh at 04:00
```

On each validator VPS, schedule `snapshot-validator.sh` nightly at staggered times (03:00 for v1, 03:15 for v2, etc.) so only one validator is briefly offline at a time.

---

### Step 10 — Apply branch protection on GitHub (~2 minutes — operator UI task)

This isn't a VPS step but it should happen before any non-maintainer pushes to main:

1. https://github.com/imronzuhri-svg/hara-ledger/settings/branches → Add rule.
2. Pattern: `main`.
3. Required status checks:
   - `secret-scan`
   - `services / docker build + scan + sign (anchor-worker)`
   - `services / docker build + scan + sign (broadcaster)`
   - `services / docker build + scan + sign (indexer)`
   - `services / docker build + scan + sign (migrate)`
   - `services / docker build + scan + sign (rpc-cache)`
   - `services / docker build + scan + sign (signer)`
   - `services / typecheck + build (anchor-worker)`
   - `services / typecheck + build (broadcaster)`
   - `services / typecheck + build (indexer)`
   - `services / typecheck + build (migrate)`
   - `services / typecheck + build (rpc-cache)`
   - `services / typecheck + build (shared)`
   - `services / typecheck + build (signer)`
   - `contracts / forge build + test`
   - `slither / Slither static analysis`
   - `echidna / HaraPalmOilFuzz`
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
| Caddy "certificate not obtained" | DNS A record points elsewhere OR port 80 blocked | Verify `dig +short rpc.haratrust.io` returns hara-stateless IP; open port 80 |
| Indexer shows no events | watched_contracts empty after wipe + redeploy | `make register-watched` |
| Anchor-worker refuses to start (zero balance) | Anchor signer not pre-funded | `cast send` 1 wei to the anchor address from the deployer |
| Chain halts after a single VPS reboot | QBFT lost quorum (2 of 4 down) | Bring the dead validators back; chain auto-resumes when 3 of 4 alive |

---

## 7. What this runbook does NOT cover

Tracked elsewhere, follow up after the initial bring-up:

- **Huawei DR layer** (P2 — month ~12). See `doc/nevacloud-proposal.md` §Bagian DR.
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
