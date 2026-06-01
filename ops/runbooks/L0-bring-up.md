# L0 — Chain bring-up runbook

This runbook gets a developer from a fresh clone to a running 4-validator HaraLedger network with deployed contracts.

## Prerequisites

- Docker Desktop running
- Foundry installed (`forge --version` works)
- GNU Make installed (`make --version` works)
- Node 20+ (used by services in later stages; not strictly required for L0)

## First-time setup

### 1. Install Foundry dependencies

```bash
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
cd ..
```

### 2. Copy env template

```bash
cp chain/.env.example chain/.env
# Edit chain/.env if you want to change chain ID, block period, etc.
```

### 3. Bootstrap the network

```bash
make bootstrap
```

What this does:
1. Starts Vault in dev mode
2. Runs the init container, which:
   - Calls `besu operator generate-blockchain-config` to produce 4 validator keypairs + a QBFT genesis
   - Loads each validator's key into Vault at `secret/haraledger/validators/{1..4}`
   - Writes `static-nodes.json` to the shared volume
   - Writes `genesis.json` to the shared genesis volume
   - **Wipes all key material from local disk** — Vault is now the only source of truth

Expected output ends with:
```
═══════════════════════════════════════════════════════════════
  HaraLedger bootstrap complete.
  Validators: 4
  Vault keys: secret/haraledger/validators/{1..4}
  Genesis:    /work/genesis/genesis.json
═══════════════════════════════════════════════════════════════
```

### 4. Start the chain

```bash
make up
```

This brings up:
- 4 Besu QBFT validators (each fetches its key from Vault on startup)
- 1 RPC node (combined read/write — split happens at L1)
- Postgres, Redis (idle in L0; wired in L3)
- Prometheus + Grafana

### 5. Verify the chain is alive

```bash
make status
```

You should see all containers running and block height incrementing. You can also:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545
```

Block height should increment every ~2 seconds.

### 6. Deploy contracts

```bash
make deploy
```

Deploys `ContractRegistry`, `AnchorRegistry`, `GovernanceContract` and self-registers all three in `ContractRegistry`. The deployer address used is Foundry's default anvil key #0, which is pre-funded in genesis.

### 7. Verify dashboards

- Grafana: http://localhost:3200 (admin / admin → HaraLedger folder → Besu overview)
- Prometheus: http://localhost:9090 (target list should show 5 healthy Besu instances)
- Vault UI: http://localhost:8200 (token: `haraledger-dev-root` → secret/haraledger/validators)

## L0 exit criteria

Tick each box before declaring L0 done and moving to L1:

- [ ] All 4 validators show "Active" peer count of 4 (themselves + 3 peers) in Grafana
- [ ] Block height incrementing at ~2s intervals
- [ ] `make deploy` completes with 3 contracts registered
- [ ] `make test` passes all Foundry tests
- [ ] Killing any single validator (`docker stop hara-validator2`) → network keeps producing blocks (QBFT byzantine fault tolerance demo)
- [ ] Restarting the killed validator → it rejoins and catches up
- [ ] Vault UI shows 4 validator secrets; no key material exists in `chain/data/` or anywhere on disk outside Vault

## Common issues

### "Init container fails with `besu: command not found`"

The init image needs to be rebuilt. Run:
```bash
docker compose -f chain/docker-compose.yml build init
make bootstrap
```

### "Validators start but no blocks are produced"

Check that all 4 validators see each other:
```bash
docker logs hara-validator1 2>&1 | grep -i "peer"
```

If peer count is <3, the static-nodes.json is wrong. Run `make clean && make bootstrap && make up`.

### "Deploy script fails: insufficient funds"

The genesis allocates funds to Foundry default keys. If you've changed `DEPLOYER_PRIVATE_KEY`, make sure that address is pre-funded in `chain/qbft-config.json` under `genesis.alloc`.

### "Vault not reachable from validators"

Vault is in dev mode and only persists in memory. If you've restarted Vault between bootstrap and `make up`, the validator keys are lost. Run `make clean && make bootstrap`.

## What L0 does NOT include

These are intentionally deferred to later stages — do not try to add them in L0:

- Read/write RPC split (L1)
- Signer service, nonce manager, queue, broadcaster (L2)
- Event indexer + Postgres state DB (L3)
- Public anchoring to IOTA (L8)
- Multi-validator consortium across multiple operators (L6 / P1)
- Production secrets handling — Vault is in dev mode (L7+)

## Next step

Once all L0 exit criteria are ticked, move to L1 — RPC read/write separation. See `doc/hara-registry-roadmap.md`.
