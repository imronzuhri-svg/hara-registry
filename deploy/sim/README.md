# Local 6-VPS Simulation

This dir brings up the **exact production topology** on your local Docker
host, so you can develop and test against the same container layout
you'll have on Nevacloud.

```
                    hara-platform (10.42.0.0/24 Docker bridge)
                                    │
       ┌────────────┬───────────────┼───────────────┬────────────┐
       │            │               │               │            │
   hara-v1      hara-v2         hara-v3         hara-v4       hara-stateful
   validator    validator       validator       validator     • vault (dev)
   .11          .12             .13             .14           • postgres .30
                                                              • redis .31
                                                              • minio .42
                                                              • vault .40
                                    │
                              hara-stateless
                              • signer .41
                              • broadcaster .43
                              • indexer .44
                              • rpc-cache .45
                              • blockscout .46/.47
                              • anchor-worker .48
                              • HAProxy LB .50
                              • prometheus .3
                              • grafana .5
                              • loki .6
```

## How it differs from production

|                | Local sim              | Nevacloud production         |
|----------------|------------------------|------------------------------|
| Hosts          | 1 Docker daemon        | 6 VPSes joined by WireGuard  |
| Vault          | dev-mode, auto-unsealed | Raft mode, sealed by default |
| Image source   | `docker compose build` locally | `docker pull` from GHCR |
| TLS edge       | none (direct ports)    | Caddy + Let's Encrypt        |
| Backups        | not cron'd             | age-encrypted nightly        |
| AppRole auth   | bypassed (uses VAULT_DEV_ROOT_TOKEN) | required (per-service AppRoles) |
| Network        | Docker bridge          | WireGuard mesh (same IPs)    |

Everything else (compose files, service code, contract addresses,
indexer schema, anchor cadence, blockscout setup) is **byte-identical**
to production. When you push to main and CI publishes new images to
GHCR, switching from local-build to GHCR-pull is one line in
`.env.sim`:

```
IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/
```

## Bring up

```bash
./deploy/sim/sim-up.sh
```

Brings up the 5 stacks in production order:
1. `_platform` (Vault dev + observability)
2. `deploy/data` (Postgres + Redis)
3. `deploy/data/minio` (MinIO + bucket init)
4. `deploy/chain` (init + 4 validators)
5. `deploy/rpc` (HAProxy LB)
6. `deploy/services` (signer/broadcaster/indexer/rpc-cache/blockscout — anchor-worker deferred)

Then **deploy contracts** (this is the same as before):
```bash
make deploy-all
```

Capture the PQAnchorRegistry address and start anchor-worker:
```bash
ADDR=$(jq -r '.transactions[] | select(.contractName=="PQAnchorRegistry") | .contractAddress' \
  chain/deploy/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json)
sed -i "s|^PQ_ANCHOR_REGISTRY_ADDRESS=.*|PQ_ANCHOR_REGISTRY_ADDRESS=$ADDR|" deploy/sim/.env.sim
./deploy/sim/sim-up.sh anchor
```

## Tear down

```bash
./deploy/sim/sim-down.sh             # stop containers, keep volumes
./deploy/sim/sim-down.sh --purge     # nuke volumes too (full chain reset)
```

## Switching between local-build and GHCR-pull

Default (`IMAGE_REGISTRY=`): on first `sim-up`, docker builds each
`hara-ledger-*` image from your local source tree. Slower but reflects
your uncommitted changes.

To pull production images instead (faster, validates exactly what CI
shipped):
```bash
sed -i 's|^IMAGE_REGISTRY=.*|IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/|' deploy/sim/.env.sim
./deploy/sim/sim-down.sh
./deploy/sim/sim-up.sh
```

## Coexistence with `make up` (legacy local dev)

`make up` uses the older monolithic `chain/docker-compose.yml`. It
conflicts with this sim because both want the same container names.
Don't run both at once — pick one:

| Goal                              | Use          |
|-----------------------------------|--------------|
| Fast iteration on Solidity / TS   | `make up`    |
| Test the production deploy shape  | `sim-up.sh`  |

When IPs land on Nevacloud, `sim-up.sh` is also your dress rehearsal
for the actual VPS bring-up — same compose files, same order.
