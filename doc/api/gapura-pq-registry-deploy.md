# Deploy the Gapura-scoped PQAnchorRegistry (operator runbook)

Gapura runs its **own** `PQAnchorRegistry` instance (model c, like Atlas) so its PQ key,
anchor id-space, and rotation are independent of the platform anchor-worker's shared
registry. This is the one-time deploy + wiring. **It requires keys — the operator runs the
signing steps; nothing here is auto-executed.**

Chain: id `131216`, gasPrice 0, legacy txs. Shared `ContractRegistry` =
`0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`.

---

## 0. Keys you need (from Vault / generate)

| Key | Purpose | Where |
|---|---|---|
| **Deployer** | broadcasts the deploy + registers in ContractRegistry. **Must hold `REGISTRAR_ROLE`** (the platform admin `0x944b…EC329` does). | Vault |
| **Gateway ECDSA key** (`ANCHOR_ECDSA_KEY`) | the Gateway's on-chain sender; gets `ANCHOR_ROLE` + `KEY_ROTATOR_ROLE` on the new instance; must be **funded > 0 HARA**. | Vault (Gateway) |
| **Gapura ML-DSA-65 seed** (`PQ_MLDSA_SEED`) | derives the instance's `currentPQKeyHash`; the Gateway signs anchors with it. | Vault (Gateway) |

## 1. Generate the Gapura PQ key + derive the hash

From `services/gapura-gateway/` (after `npm install`):

```bash
# generate a fresh seed + hash (seed to stderr, hash to stdout):
node scripts/derive-pq-key.mjs
```
- **Store the printed `PQ_MLDSA_SEED` in Vault** (Gateway secret) — never commit it.
- **Publish the ML-DSA-65 public key bytes to CAS/MinIO** keyed by the printed hash, so
  auditors can verify anchors off-chain.
- Keep the printed `INITIAL_PQ_KEY_HASH` for the deploy env.

(Already have a seed? `PQ_MLDSA_SEED=0x… node scripts/derive-pq-key.mjs` re-derives the hash.)

## 2. Deploy the instance

```bash
export DEPLOYER_PRIVATE_KEY=<admin key that holds REGISTRAR_ROLE, e.g. 0x944b…>
export ADMIN_ADDRESS=<DEFAULT_ADMIN for the instance — the admin key, or the gateway addr>
export GATEWAY_ANCHOR_ADDRESS=<address of ANCHOR_ECDSA_KEY>
export INITIAL_PQ_KEY_HASH=0x…                 # from step 1
export CONTRACT_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512

cd contracts
forge script script/DeployGapuraPQAnchor.s.sol:DeployGapuraPQAnchor \
  --rpc-url https://rpc.ledger.haratrust.io/write/ --broadcast --legacy --skip-simulation
```
The script deploys the instance, grants the Gateway key `ANCHOR_ROLE` + `KEY_ROTATOR_ROLE`
(when `ADMIN_ADDRESS == deployer`), and registers it as **`GapuraPQAnchorRegistry` v1** in
the shared ContractRegistry. Note the deployed address it prints.

> If you set `ADMIN_ADDRESS` to something other than the deployer, the script can't grant the
> roles — run these from the admin key afterward:
> ```bash
> cast send <instance> "grantRole(bytes32,address)" $(cast keccak "ANCHOR_ROLE")      $GATEWAY_ANCHOR_ADDRESS --rpc-url https://rpc.ledger.haratrust.io/write/ --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216
> cast send <instance> "grantRole(bytes32,address)" $(cast keccak "KEY_ROTATOR_ROLE") $GATEWAY_ANCHOR_ADDRESS --rpc-url https://rpc.ledger.haratrust.io/write/ --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216
> ```

## 3. Fund the Gateway sender

`recordAnchor` reverts for a zero-balance sender even at gasPrice 0. Fund it:
```bash
cast send $GATEWAY_ANCHOR_ADDRESS --value 1ether --rpc-url https://rpc.ledger.haratrust.io/write/ --private-key $FUNDER_PK --legacy --gas-price 0 --chain 131216
```

## 4. Point the Gateway at the instance

In the Gateway's env (`services/gapura-gateway/.env` / Vault):
```
PQ_ANCHOR_REGISTRY=<deployed Gapura instance address>   # NOT the shared 0x8A79…C318
ANCHOR_ECDSA_KEY=<from Vault>
PQ_MLDSA_SEED=<from Vault, the seed from step 1>
```

## 5. Verify (read-only)

```bash
R=https://rpc.ledger.haratrust.io/read/ ; INST=<instance>
# currentPQKeyHash matches your derived hash:
cast call $INST "currentPQKeyHash()(bytes32)" --rpc-url $R          # == INITIAL_PQ_KEY_HASH
# gateway key holds the roles:
cast call $INST "hasRole(bytes32,address)(bool)" $(cast keccak "ANCHOR_ROLE")      $GATEWAY_ANCHOR_ADDRESS --rpc-url $R  # true
cast call $INST "hasRole(bytes32,address)(bool)" $(cast keccak "KEY_ROTATOR_ROLE") $GATEWAY_ANCHOR_ADDRESS --rpc-url $R  # true
# discoverable in the shared registry:
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 "getActive(bytes32)(address)" $(cast keccak "GapuraPQAnchorRegistry") --rpc-url $R  # == $INST
# sender funded:
cast balance $GATEWAY_ANCHOR_ADDRESS --rpc-url $R                   # > 0
```

Once all five check out, the Gateway's anchor writes go live against Gapura's own instance —
anchors are tagged with Gapura's `currentPQKeyHash` and verify off-chain against the Gapura
pubkey published in step 1.

## Rotation (later)

Rotation is an explicit operator action on **Gapura's** instance (the Gateway never calls
`rotatePQKey` implicitly): generate a new seed (step 1), publish the new pubkey to CAS, then
`cast send <instance> "rotatePQKey(bytes32,string)" <newHash> "ML-DSA-65"` from the Gateway
key (holds `KEY_ROTATOR_ROLE`). New anchors freeze against the new hash; old anchors keep
their original key hash for verification.
