#!/usr/bin/env bash
# rotate-anvil0-admin.sh — replace anvil-0 (well-known dev key) with a fresh
# admin key across all 5 HaraLedger platform contracts.
#
# Phases:
#   1. PREP    — generate new admin key (if not exists), grant all 12 roles
#   2. VERIFY  — smoke-test new admin can grant/revoke a throwaway role
#   3. ROTATE  — drain anvil-0, renounce roles, verify zeroed
#
# Default behavior: dry-run (prints what it WOULD do but submits nothing).
# Pass --execute to actually submit txs.
#
# Idempotent: safe to re-run. Each grant/renounce checks hasRole first.
#
# Created 2026-05-27 to rotate the well-known anvil-0 key out of admin role
# now that hara-did is integrating against the production chain.

set -euo pipefail

# ─── Constants ──────────────────────────────────────────────────────────────
ANVIL0_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ANVIL0_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RPC="${RPC:-https://rpc.ledger.haratrust.io/write/}"
CHAIN="${CHAIN:-131216}"

# Contracts and roles (role-hash:contract-name:contract-address tuples)
declare -a GRANTS=(
  "DEFAULT_ADMIN_ROLE:ContractRegistry:0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  "REGISTRAR_ROLE:ContractRegistry:0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  "DEFAULT_ADMIN_ROLE:AnchorRegistry:0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
  "ANCHOR_ROLE:AnchorRegistry:0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
  "DEFAULT_ADMIN_ROLE:PQAnchorRegistry:0x8A791620dd6260079BF849Dc5567aDC3F2FdC318"
  "ANCHOR_ROLE:PQAnchorRegistry:0x8A791620dd6260079BF849Dc5567aDC3F2FdC318"
  "KEY_ROTATOR_ROLE:PQAnchorRegistry:0x8A791620dd6260079BF849Dc5567aDC3F2FdC318"
  "DEFAULT_ADMIN_ROLE:GovernanceContract:0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
  "DEFAULT_ADMIN_ROLE:HaraPalmOil:0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
  "MINTER_ROLE:HaraPalmOil:0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
  "CERTIFIER_ROLE:HaraPalmOil:0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
)

NEW_ADMIN_FILE="${HOME}/hara-ops/new-admin-2026-05-27.json"
EXECUTE=false

for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=true ;;
    *) echo "Unknown arg: $arg"; exit 2 ;;
  esac
done

if [[ "$EXECUTE" == "false" ]]; then
  echo "════════════════════════════════════════════════════════════════"
  echo "  DRY-RUN MODE — no txs will be submitted"
  echo "  Pass --execute to actually do it"
  echo "════════════════════════════════════════════════════════════════"
else
  echo "════════════════════════════════════════════════════════════════"
  echo "  EXECUTE MODE — txs WILL be submitted to $RPC"
  echo "  Press Ctrl-C in the next 5 seconds to abort"
  echo "════════════════════════════════════════════════════════════════"
  sleep 5
fi

role_hash() {
  if [[ "$1" == "DEFAULT_ADMIN_ROLE" ]]; then
    echo "0x0000000000000000000000000000000000000000000000000000000000000000"
  else
    cast keccak "$1"
  fi
}

# Wrap cast send so dry-run prints, execute runs
do_send() {
  if [[ "$EXECUTE" == "true" ]]; then
    cast send --private-key "$1" --rpc-url "$RPC" --chain "$CHAIN" \
      --gas-price 0 --legacy "$2" "$3" "$4" "$5" 2>&1 | tail -3
  else
    echo "   [dry-run] cast send $2 \"$3\" $4 $5"
  fi
}

# ─── Phase 1: prep — generate new key + grant all 12 roles ──────────────────
echo ""
echo "═══ Phase 1: PREP ═══"

if [[ -f "$NEW_ADMIN_FILE" ]]; then
  echo "✓ New admin key already exists at $NEW_ADMIN_FILE — reusing"
  # cast wallet new --json returns an ARRAY [{...}]; older/manual files may be
  # a bare object. Handle both.
  NEW_ADMIN_ADDR=$(jq -r 'if type=="array" then .[0] else . end | .address' "$NEW_ADMIN_FILE")
  NEW_ADMIN_KEY=$(jq -r 'if type=="array" then .[0] else . end | .private_key' "$NEW_ADMIN_FILE")
else
  if [[ "$EXECUTE" == "false" ]]; then
    echo "   [dry-run] would generate new key via 'cast wallet new'"
    echo "   [dry-run] would store at $NEW_ADMIN_FILE (mode 0600)"
    NEW_ADMIN_ADDR="0x<NEW_ADMIN_WILL_BE_GENERATED>"
    NEW_ADMIN_KEY="<NEW_KEY>"
  else
    mkdir -p "$(dirname "$NEW_ADMIN_FILE")"
    # Normalize cast's array output to a bare object on disk
    cast wallet new --json | jq 'if type=="array" then .[0] else . end' > "$NEW_ADMIN_FILE"
    chmod 600 "$NEW_ADMIN_FILE"
    NEW_ADMIN_ADDR=$(jq -r '.address' "$NEW_ADMIN_FILE")
    NEW_ADMIN_KEY=$(jq -r '.private_key' "$NEW_ADMIN_FILE")
    echo "✓ Generated new admin key. Address: $NEW_ADMIN_ADDR"
    echo "✓ Stored at $NEW_ADMIN_FILE (mode 0600)"
    echo "  ⚠  Also store this in Vault at secret/haraledger/admin-keys/admin-2026-05-27"
  fi
fi

echo "New admin address: $NEW_ADMIN_ADDR"
echo ""
echo "Granting all 12 roles from anvil-0 to new admin..."

for grant in "${GRANTS[@]}"; do
  IFS=':' read -r ROLE NAME ADDR <<< "$grant"
  HASH=$(role_hash "$ROLE")
  if [[ "$EXECUTE" == "true" ]]; then
    HAS=$(cast call "$ADDR" "hasRole(bytes32,address)(bool)" "$HASH" "$NEW_ADMIN_ADDR" --rpc-url "$RPC")
    if [[ "$HAS" == "true" ]]; then
      echo "  ✓ $NAME / $ROLE → already granted, skipping"
      continue
    fi
  fi
  echo "  + $NAME / $ROLE"
  do_send "$ANVIL0_KEY" "$ADDR" "grantRole(bytes32,address)" "$HASH" "$NEW_ADMIN_ADDR"
done

echo ""
echo "Verifying all 12 grants..."
ALL_OK=true
if [[ "$EXECUTE" == "true" ]]; then
  for grant in "${GRANTS[@]}"; do
    IFS=':' read -r ROLE NAME ADDR <<< "$grant"
    HASH=$(role_hash "$ROLE")
    HAS=$(cast call "$ADDR" "hasRole(bytes32,address)(bool)" "$HASH" "$NEW_ADMIN_ADDR" --rpc-url "$RPC")
    if [[ "$HAS" == "true" ]]; then
      echo "  ✓ $NAME / $ROLE = true"
    else
      echo "  ✗ $NAME / $ROLE = false  — ABORT"
      ALL_OK=false
    fi
  done
  $ALL_OK || { echo "Phase 1 FAILED. Anvil-0 still has all power; no harm done. Investigate."; exit 1; }
fi

# ─── Phase 2: verification — new admin grants + revokes a throwaway role ───
echo ""
echo "═══ Phase 2: VERIFY (smoke-test new admin) ═══"
# Use a burn address to verify new admin can grant + revoke
BURN_ADDR="0x000000000000000000000000000000000000dEaD"
TEST_HASH=$(cast keccak "REGISTRAR_ROLE")
TEST_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"  # ContractRegistry

echo "  Granting REGISTRAR_ROLE to $BURN_ADDR (via new admin)..."
do_send "$NEW_ADMIN_KEY" "$TEST_CONTRACT" "grantRole(bytes32,address)" "$TEST_HASH" "$BURN_ADDR"

if [[ "$EXECUTE" == "true" ]]; then
  HAS=$(cast call "$TEST_CONTRACT" "hasRole(bytes32,address)(bool)" "$TEST_HASH" "$BURN_ADDR" --rpc-url "$RPC")
  [[ "$HAS" == "true" ]] || { echo "✗ smoke-test grant FAILED — new admin lacks power. ABORT."; exit 1; }
  echo "  ✓ Burn address now has REGISTRAR_ROLE"
fi

echo "  Revoking REGISTRAR_ROLE from $BURN_ADDR (cleanup)..."
do_send "$NEW_ADMIN_KEY" "$TEST_CONTRACT" "revokeRole(bytes32,address)" "$TEST_HASH" "$BURN_ADDR"

if [[ "$EXECUTE" == "true" ]]; then
  HAS=$(cast call "$TEST_CONTRACT" "hasRole(bytes32,address)(bool)" "$TEST_HASH" "$BURN_ADDR" --rpc-url "$RPC")
  [[ "$HAS" == "false" ]] || { echo "✗ smoke-test revoke FAILED. ABORT."; exit 1; }
  echo "  ✓ Burn address no longer has role. New admin is fully functional."
fi

# ─── Phase 3: point of no return ────────────────────────────────────────────
echo ""
echo "═══ Phase 3: ROTATE — drain + renounce ═══"
echo "    From this point on, anvil-0 loses its power. Last chance to abort."

if [[ "$EXECUTE" == "true" ]]; then
  echo "  Sleeping 10s. Ctrl-C to abort."
  sleep 10
fi

# 3a. Drain anvil-0 balance (keep nothing — gas is free, just sweep)
echo "  Draining anvil-0 balance to new admin..."
if [[ "$EXECUTE" == "true" ]]; then
  ANVIL0_BAL=$(cast balance "$ANVIL0_ADDR" --rpc-url "$RPC")
  echo "  Anvil-0 balance: $ANVIL0_BAL wei"
  # Leave 1 wei. NOTE: balances are >9e21 wei — bash 64-bit arithmetic overflows
  # (max ~9.2e18), so use python3 for the subtraction. (Bug hit 2026-05-28.)
  AMOUNT=$(python3 -c "print($ANVIL0_BAL - 1)")
  cast send --private-key "$ANVIL0_KEY" --rpc-url "$RPC" --chain "$CHAIN" \
    --gas-price 0 --legacy "$NEW_ADMIN_ADDR" --value "$AMOUNT" 2>&1 | tail -3
else
  echo "   [dry-run] would sweep anvil-0 balance to $NEW_ADMIN_ADDR"
fi

# 3b. Renounce all 12 roles from anvil-0
echo ""
echo "  Renouncing all 12 roles from anvil-0..."
for grant in "${GRANTS[@]}"; do
  IFS=':' read -r ROLE NAME ADDR <<< "$grant"
  HASH=$(role_hash "$ROLE")
  echo "  - renounce $NAME / $ROLE"
  do_send "$ANVIL0_KEY" "$ADDR" "renounceRole(bytes32,address)" "$HASH" "$ANVIL0_ADDR"
done

# 3c. Verify anvil-0 has nothing left
echo ""
echo "Verifying anvil-0 has no roles..."
if [[ "$EXECUTE" == "true" ]]; then
  FAIL=false
  for grant in "${GRANTS[@]}"; do
    IFS=':' read -r ROLE NAME ADDR <<< "$grant"
    HASH=$(role_hash "$ROLE")
    HAS=$(cast call "$ADDR" "hasRole(bytes32,address)(bool)" "$HASH" "$ANVIL0_ADDR" --rpc-url "$RPC")
    if [[ "$HAS" == "false" ]]; then
      echo "  ✓ $NAME / $ROLE = false"
    else
      echo "  ✗ $NAME / $ROLE = still true — UNEXPECTED"
      FAIL=true
    fi
  done
  echo ""
  echo "Anvil-0 final balance: $(cast balance "$ANVIL0_ADDR" --rpc-url "$RPC") wei"
  echo "New admin final balance: $(cast balance "$NEW_ADMIN_ADDR" --rpc-url "$RPC") wei"
  $FAIL && { echo ""; echo "✗ Some roles persist on anvil-0. Investigate."; exit 1; }
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ✓ Rotation complete"
echo "  New admin: $NEW_ADMIN_ADDR"
echo "  Key file:  $NEW_ADMIN_FILE  (chmod 600)"
echo ""
echo "  Next steps:"
echo "  1. Store the new admin key in Vault under"
echo "     secret/haraledger/admin-keys/admin-2026-05-27"
echo "  2. Update any operational scripts that hardcode anvil-0"
echo "     (grep 'ac0974' under deploy/)"
echo "  3. Tell hara-did the admin address has changed (informational only — "
echo "     their REGISTRAR_ROLE + DEFAULT_ADMIN_ROLE grants remain intact)"
echo "════════════════════════════════════════════════════════════════"
