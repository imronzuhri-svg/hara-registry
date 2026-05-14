#!/usr/bin/env bash
# register-watched.sh — upsert contract addresses into watched_contracts.
#
# Replaces the hardcoded INSERTs in services/migrations/003_traceability_view.sql,
# which broke on every chain wipe because the deterministic-address assumption
# from Foundry anvil #0 only held for the very first deploy order. After a
# rebuild with a different nonce sequence, the indexer was silently watching
# addresses that no longer existed. (Filed during 2026-05-14 health audit.)
#
# This script is the canonical post-deploy hook: called from `make deploy`
# after `forge script` returns, with the contract names + freshly-deployed
# addresses. Idempotent — re-running with the same args is a no-op; re-running
# with a NEW address for an existing name updates the row.
#
# Usage:
#   ./scripts/register-watched.sh \
#     ContractRegistry=0x... \
#     AnchorRegistry=0x... \
#     PQAnchorRegistry=0x... \
#     HaraPalmOil=0x... \
#     TraceabilityBatchRelay=0x... \
#     GovernanceContract=0x...
#
# Env:
#   HARA_PG_DSN   PostgreSQL DSN. Defaults to the dev wiring.
#   PG_DOCKER_CONTAINER  Container name to exec psql in when no host psql.
#                        Default: hara-postgres.
#
# Exit codes:
#   0  all pairs registered
#   1  bad arg format
#   2  Postgres unreachable
#   3  partial failure (some pairs failed)

set -euo pipefail

HARA_PG_DSN="${HARA_PG_DSN:-postgresql://hara:hara@localhost:5432/hara_indexer}"
PG_DOCKER_CONTAINER="${PG_DOCKER_CONTAINER:-hara-postgres}"

if [ $# -eq 0 ]; then
  echo "usage: $0 Name=0xAddress [Name=0xAddress ...]" >&2
  exit 1
fi

# Pick psql: host first, then docker exec fallback. Sidesteps the dev-on-Windows
# case where psql isn't on PATH but the container is reachable.
if command -v psql >/dev/null 2>&1; then
  PSQL=(psql "$HARA_PG_DSN" -v ON_ERROR_STOP=1 -q -t -A)
else
  if ! docker exec "$PG_DOCKER_CONTAINER" true 2>/dev/null; then
    echo "✗ no host psql and no reachable container '$PG_DOCKER_CONTAINER'" >&2
    exit 2
  fi
  PSQL=(docker exec -i "$PG_DOCKER_CONTAINER" psql -U hara -d hara_indexer -v ON_ERROR_STOP=1 -q -t -A)
fi

fail=0
for pair in "$@"; do
  name="${pair%%=*}"
  addr="${pair#*=}"
  if [ "$name" = "$pair" ] || [ -z "$addr" ]; then
    echo "✗ bad pair '$pair' (expected Name=0xAddr)" >&2
    fail=$((fail + 1))
    continue
  fi
  if ! [[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "✗ '$name' has malformed address '$addr'" >&2
    fail=$((fail + 1))
    continue
  fi
  lower=$(printf '%s' "$addr" | tr '[:upper:]' '[:lower:]')

  # UPSERT: if name exists at a different address (post-redeploy), update;
  # if address exists with a different name, update name.
  if ! "${PSQL[@]}" <<SQL
    INSERT INTO watched_contracts (contract_address, name)
    VALUES ('$lower', '$name')
    ON CONFLICT (contract_address) DO UPDATE SET name = EXCLUDED.name;

    -- If a previous deploy registered the same name at a different (now stale)
    -- address, retire the stale row so the indexer stops following dead code.
    UPDATE watched_contracts
       SET enabled = false
     WHERE name = '$name' AND contract_address <> '$lower';
SQL
  then
    echo "✗ failed to register $name=$lower" >&2
    fail=$((fail + 1))
    continue
  fi
  echo "✓ $name = $lower"
done

if [ "$fail" -gt 0 ]; then
  echo "✗ $fail pair(s) failed" >&2
  exit 3
fi
