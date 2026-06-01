#!/usr/bin/env bash
# minter-role.sh — grant/revoke/check MINTER_ROLE on HaraPalmOil, signing with the
# platform admin key read from Vault AT RUN TIME (never stored, never printed).
#
# Run ON hara-stateless-2 (reaches Vault @10.43.0.40 + RPC @10.43.0.21, has viem).
#   export VAULT_TOKEN='hvs....'          # the Vault root token
#   bash deploy/ops/minter-role.sh check  0xc9064736be2715060e79472795d759907b408bf5
#   bash deploy/ops/minter-role.sh grant  0xc9064736be2715060e79472795d759907b408bf5
#   bash deploy/ops/minter-role.sh revoke 0xc9064736be2715060e79472795d759907b408bf5
set -euo pipefail

CMD="${1:?pass a command - check, grant or revoke - plus a target address}"
TARGET="${2:?target address required}"
: "${VAULT_TOKEN:?export VAULT_TOKEN=<root token> first}"
VADDR="${VAULT_ADDR:-http://10.43.0.40:8200}"
REPO="${REPO:-/opt/hara/hara-registry}"

echo "▶ reading admin key from Vault (not printed)…"
AK=$(curl -s -H "X-Vault-Token: $VAULT_TOKEN" "$VADDR/v1/secret/data/haraledger/admin-keys/admin-2026-05-27" \
       | jq -r '.data.data.private_key // .data.data.privateKey // .data.data.key // empty')
if [ -z "$AK" ]; then
  AK=$(curl -s -H "X-Vault-Token: $VAULT_TOKEN" "$VADDR/v1/secret/haraledger/admin-keys/admin-2026-05-27" \
         | jq -r '.data.private_key // .data.privateKey // .data.key // empty')
fi
if [ -z "$AK" ]; then
  echo "✗ couldn't extract the private key. Field names found at the v2 path:"
  curl -s -H "X-Vault-Token: $VAULT_TOKEN" "$VADDR/v1/secret/data/haraledger/admin-keys/admin-2026-05-27" \
    | jq -r '.data.data | keys[]?' 2>/dev/null || echo "  (path/token error — check VAULT_TOKEN and path)"
  exit 1
fi
[[ "$AK" == 0x* ]] || AK="0x$AK"

cat > "$REPO/ops/load-tests/.minter-role.mjs" <<'MJS'
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeFunctionData } from "viem";
const TOKEN = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
const CHAIN_ID = 131216;
const RPC_R = "http://10.43.0.21:8545/rpc/read";
const RPC_W = "http://10.43.0.21:8545/rpc/write";
const ROLE = keccak256(toHex("MINTER_ROLE"));
const abi = [
  { name:"grantRole",  type:"function", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"address"}], outputs:[] },
  { name:"revokeRole", type:"function", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"address"}], outputs:[] },
  { name:"hasRole",    type:"function", stateMutability:"view",       inputs:[{type:"bytes32"},{type:"address"}], outputs:[{type:"bool"}] },
];
const cmd = process.argv[2], target = process.argv[3];
const acct = privateKeyToAccount(process.env.AK);
const pub = createPublicClient({ transport: http(RPC_R) });
const wal = createWalletClient({ account: acct, transport: http(RPC_W) });
const has = () => pub.readContract({ address: TOKEN, abi, functionName: "hasRole", args: [ROLE, target] });
console.log("  admin:", acct.address);
console.log("  target:", target, "hasRole(before):", await has());
if (cmd === "check") process.exit(0);
const fn = cmd === "grant" ? "grantRole" : "revokeRole";
const data = encodeFunctionData({ abi, functionName: fn, args: [ROLE, target] });
const nonce = await pub.getTransactionCount({ address: acct.address });
const signed = await acct.signTransaction({ type:"legacy", chainId: CHAIN_ID, nonce, to: TOKEN, data, value: 0n, gasPrice: 0n, gas: 120000n });
const hash = await pub.sendRawTransaction({ serializedTransaction: signed });
console.log(`  ${fn} tx:`, hash);
const r = await pub.waitForTransactionReceipt({ hash });
console.log("  status:", r.status, "gasUsed:", r.gasUsed.toString());
console.log("  hasRole(after):", await has());
if (r.status !== "success") process.exit(1);
MJS

trap 'rm -f "$REPO/ops/load-tests/.minter-role.mjs"' EXIT
sudo docker run --rm --network host -v "$REPO":/app -w /app/ops/load-tests \
  -e AK="$AK" node:22 node .minter-role.mjs "$CMD" "$TARGET"
