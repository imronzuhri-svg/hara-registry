.PHONY: help bootstrap up down logs deploy deploy-all register-watched reset-indexer clean test status platform-up platform-down sim-up sim-down sim-purge sim-status

COMPOSE := docker compose -f chain/docker-compose.yml --env-file chain/.env
PLATFORM := docker compose -f ../_platform/docker-compose.yml --env-file ../_platform/.env

help:
	@echo "HaraLedger — local development"
	@echo ""
	@echo "  make platform-up   Bring up shared platform (Vault, Prometheus, Grafana, Loki, ...)"
	@echo "  make platform-down Stop shared platform (data persists)"
	@echo "  make bootstrap     Generate validator keys, load Vault, write genesis (one-shot)"
	@echo "  make up            Start hara-ledger services (chain + RPC + signer + indexer)"
	@echo "  make down          Stop hara-ledger services (data persists)"
	@echo "  make logs          Tail logs from hara-ledger services"
	@echo "  make deploy        Deploy ContractRegistry, AnchorRegistry, GovernanceContract"
	@echo "  make deploy-all    Deploy all 6 contracts + register in watched_contracts"
	@echo "  make register-watched  Re-register from existing broadcast files (no redeploy)"
	@echo "  make reset-indexer Wipe indexer state + cursor (keeps watched_contracts)"
	@echo "  make test          Run Foundry contract tests"
	@echo "  make status        Show running services + block height"
	@echo "  make clean         Stop and DESTROY hara-ledger data (chain reset)"
	@echo ""
	@echo "Order: 'make platform-up' once → 'make bootstrap' → 'make up'"
	@echo ""
	@echo "Production-shape simulation (mimics 6-VPS Nevacloud topology):"
	@echo "  make sim-up        Bring up all 6 'VPSes' as named container groups"
	@echo "  make sim-down      Stop sim (volumes kept — fast restart)"
	@echo "  make sim-purge     Stop AND nuke volumes (full chain reset)"
	@echo "  make sim-status    Show what's running with topology labels"

platform-up:
	@test -f ../_platform/.env || cp ../_platform/.env.example ../_platform/.env
	$(PLATFORM) up -d
	@echo "✔ Platform up. Grafana: http://localhost:3200  Vault: http://localhost:8200"

platform-down:
	$(PLATFORM) down

bootstrap:
	@echo "▶ Bootstrapping HaraLedger network (requires platform Vault running)..."
	@test -f chain/.env || cp chain/.env.example chain/.env
	@docker inspect hara-vault --format '{{.State.Health.Status}}' 2>/dev/null | grep -q healthy || (echo "✗ Vault not healthy. Run 'make platform-up' first." && exit 1)
	$(COMPOSE) run --rm init
	@echo "✔ Bootstrap complete. Run 'make up' to start validators."

up:
	$(COMPOSE) up -d
	@echo "✔ Chain services started."
	@echo ""
	@echo "  RPC HTTP:  http://localhost:8545"
	@echo "  RPC WS:    ws://localhost:8546"
	@echo "  Vault UI:  http://localhost:8200  (token: haraledger-dev-root)"
	@echo "  Grafana:   http://localhost:3200  (admin/admin)"
	@echo "  Loki:      http://localhost:3201"
	@echo "  Prometheus: http://localhost:9090"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

deploy:
	cd contracts && forge script script/Deploy.s.sol:Deploy \
		--rpc-url http://localhost:8545 \
		--broadcast --legacy --skip-simulation \
		--private-key $${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
	@./scripts/register-from-broadcast.sh contracts/broadcast/Deploy.s.sol/131216/run-latest.json

# Deploy everything: base contracts + palm-oil + PQAnchor, then register all.
# CONTRACT_REGISTRY for DeployPQAnchor is read from the freshly-deployed
# ContractRegistry's broadcast file, so PQAnchor gets registered there too.
deploy-all: deploy
	cd contracts && forge script script/DeployPalmOil.s.sol:DeployPalmOil \
		--rpc-url http://localhost:8545 \
		--broadcast --legacy --skip-simulation \
		--private-key $${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
	@./scripts/register-from-broadcast.sh contracts/broadcast/DeployPalmOil.s.sol/131216/run-latest.json
	@CR=$$(jq -r '.transactions[] | select(.contractName=="ContractRegistry") | .contractAddress' \
		contracts/broadcast/Deploy.s.sol/131216/run-latest.json); \
	cd contracts && CONTRACT_REGISTRY=$$CR \
		ANCHOR_WORKER_ADDRESS=$${ANCHOR_WORKER_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8} \
		forge script script/DeployPQAnchor.s.sol:DeployPQAnchor \
		--rpc-url http://localhost:8545 \
		--broadcast --legacy --skip-simulation \
		--private-key $${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
	@./scripts/register-from-broadcast.sh contracts/broadcast/DeployPQAnchor.s.sol/131216/run-latest.json

# Re-register watched_contracts from existing broadcast files without redeploying.
# Useful after a chain wipe + manual contract redeploys.
register-watched:
	@for s in Deploy.s.sol DeployPalmOil.s.sol DeployPQAnchor.s.sol; do \
	  f=contracts/broadcast/$$s/131216/run-latest.json; \
	  [ -f $$f ] && ./scripts/register-from-broadcast.sh $$f || echo "(skip $$s — no broadcast)"; \
	done

test:
	cd contracts && forge test -vv

status:
	@$(COMPOSE) ps
	@echo ""
	@echo "▶ Block height:"
	@curl -s -X POST -H "Content-Type: application/json" \
		--data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
		http://localhost:8545 | grep -oE '"result":"[^"]+"' || echo "  (RPC not reachable yet)"

clean:
	$(COMPOSE) down -v
	rm -rf chain/data chain/generated chain/genesis/genesis.json chain/static-nodes.json
	@echo "✔ All data destroyed. Run 'make bootstrap' to start fresh."

# Reset just the indexer state. Useful after a chain wipe where you DON'T
# want to lose Postgres entirely (e.g. you redeployed contracts but the
# `_migrations` history is still valid). The indexer will re-scan from
# block 0 on next start.
#
# Idempotent. Safe to run against a stopped or running stack — but if the
# indexer is running, it'll race the truncate and may re-add rows; prefer
# stopping it first:
#   docker compose -f chain/docker-compose.yml stop indexer
#   make reset-indexer
#   docker compose -f chain/docker-compose.yml start indexer
reset-indexer:
	@echo "▶ Truncating indexer tables + resetting cursor on hara-postgres..."
	@docker exec hara-postgres psql -U hara -d hara_indexer -q -c "TRUNCATE indexed_events RESTART IDENTITY"
	@docker exec hara-postgres psql -U hara -d hara_indexer -q -c "TRUNCATE indexed_blocks"
	@docker exec hara-postgres psql -U hara -d hara_indexer -q -c "UPDATE indexer_state SET last_indexed_block = -1, last_indexed_at = now() WHERE id = 1"
	@docker exec hara-postgres psql -U hara -d hara_indexer -q -c "UPDATE pq_anchor_worker_state SET last_anchored_block = -1, last_anchor_id = NULL, updated_at = now() WHERE id = 1" 2>/dev/null || echo "  (pq_anchor_worker_state table not present yet — skipped)"
	@echo "✔ Indexer reset. On next indexer start it will re-scan from block 0."
	@echo "  watched_contracts is preserved; re-run 'make register-watched' only if addresses changed."

# ── Production-shape local simulation ───────────────────────────────────────
# Brings up all 6 logical "VPSes" (hara-stateful, hara-stateless, hara-v1..v4)
# as named container groups on the hara-platform Docker bridge. Same compose
# files used in production, with Vault in dev mode for local convenience.
# See deploy/sim/README.md for details.

sim-up:
	@bash deploy/sim/sim-up.sh

sim-down:
	@bash deploy/sim/sim-down.sh

sim-purge:
	@bash deploy/sim/sim-down.sh --purge

sim-status:
	@echo "── hara-stateful ───────────────────────────────────────"
	@docker ps --filter "name=hara-vault" --filter "name=hara-postgres" --filter "name=hara-redis" --filter "name=hara-minio" --format "  {{.Names}}\t{{.Status}}"
	@echo ""
	@echo "── hara-stateless ──────────────────────────────────────"
	@docker ps --filter "name=hara-signer" --filter "name=hara-broadcaster" --filter "name=hara-indexer" --filter "name=hara-rpc-cache" --filter "name=hara-blockscout" --filter "name=hara-anchor-worker" --filter "name=hara-lb" --filter "name=hara-rpc-" --filter "name=hara-prometheus" --filter "name=hara-grafana" --filter "name=hara-loki" --filter "name=hara-alertmanager" --filter "name=hara-promtail" --filter "name=hara-alert-sink" --format "  {{.Names}}\t{{.Status}}"
	@echo ""
	@echo "── hara-v1..v4 (validators) ────────────────────────────"
	@docker ps --filter "name=hara-validator" --format "  {{.Names}}\t{{.Status}}"
