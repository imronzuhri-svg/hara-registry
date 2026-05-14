.PHONY: help bootstrap up down logs deploy clean test status platform-up platform-down

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
	@echo "  make test          Run Foundry contract tests"
	@echo "  make status        Show running services + block height"
	@echo "  make clean         Stop and DESTROY hara-ledger data (chain reset)"
	@echo ""
	@echo "Order: 'make platform-up' once → 'make bootstrap' → 'make up'"

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
		--broadcast \
		--private-key $${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}

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
