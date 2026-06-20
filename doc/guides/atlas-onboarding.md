# HARA Atlas — Registry Onboarding Packet

Onboarding reference for granting **HARA Atlas** the access it needs to anchor and
deploy/register its own contract family on the Hara Registry sovereign chain
(Besu QBFT, chain id **131216**).

> Source of truth: [`hara-registry-facts.md`](../api/hara-registry-facts.md). All
> addresses/roles below were verified live on-chain (chain 131216) on 2026-06-20.
> Atlas mints on **its own** deployed contracts — no `MINTER_ROLE` on the platform
> `HaraPalmOil` token is required.

Atlas signer: `ATLAS_SIGNER = 0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8`
Atlas mesh IP: `10.43.0.51`

---

## 1. Chain + connection (for the Atlas side)

```ini
CHAIN_ID=131216                # legacy (type-0) txs ONLY; EVM London (no PUSH0); gasPrice 0
GAS_PRICE=0
# Public RPC (trailing slash is MANDATORY):
RPC_READ_URL=https://rpc.ledger.haratrust.io/read/     # rpc-cache-backed (~99% hit); use for read-heavy public verify
RPC_WRITE_URL=https://rpc.ledger.haratrust.io/write/   # eth_sendRawTransaction
RPC_WS_URL=wss://rpc.ledger.haratrust.io/ws
# In-mesh (after WireGuard is up, from 10.43.0.51 -> HAProxy on rpc-1):
RPC_READ_URL_MESH=http://10.43.0.21:8545/rpc/read/
RPC_WRITE_URL_MESH=http://10.43.0.21:8545/rpc/write/
RPC_WS_URL_MESH=ws://10.43.0.21:8546/rpc/read
# Contracts Atlas uses:
PQ_ANCHOR_REGISTRY=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
CONTRACT_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
ATLAS_SIGNER=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
```

## 2. The three rules that bite everyone

1. **Legacy txs, `gasPrice 0`, `chainId 131216`.** EIP-1559 fields are rejected.
   Foundry: `--legacy --skip-simulation`.
2. **Pre-fund >= 1 wei** before a wallet's first tx — Besu silently drops
   zero-balance senders even at gasPrice 0. (Atlas signer is funded with 1 HARA.)
3. **Check `receipt.status == 0x1`** — a mined tx can still have reverted.

## 3. Access granted to `ATLAS_SIGNER`

| Role | Contract | Enables |
|---|---|---|
| `ANCHOR_ROLE` | PQAnchorRegistry `0x8A79…C318` | `recordAnchor(...)`, `confirmExternalAnchor(...)` |
| `KEY_ROTATOR_ROLE` | PQAnchorRegistry `0x8A79…C318` | `rotatePQKey(...)` — **one-time PQ-key ceremony, then revoked** |
| `REGISTRAR_ROLE` | ContractRegistry `0xe7f1…0512` | `register(name,version,addr)` for the Atlas contract family |

Role IDs (verified equal to the live contracts' constants):

```
ANCHOR_ROLE      = 0x08b5ce2e3163e37059f807346dad4dd6235ed44f92dced22992662cb45706362
KEY_ROTATOR_ROLE = 0x55c05ddad8d728263a0a7974b9297f5cdfb53044b9a72a6dc5b27e5be010358d
REGISTRAR_ROLE   = 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238
```

**Contract deployment is open** — genesis has no permissioning (`zeroBaseFee: true`).
Once funded, the Atlas signer (or any deployer it controls) deploys freely via
Foundry `--legacy --skip-simulation`. No deploy grant is needed; `REGISTRAR_ROLE`
only covers registering names in `ContractRegistry`.

Atlas self-check once grants land:

```bash
R=https://rpc.ledger.haratrust.io/read/
A=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
cast call 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 "hasRole(bytes32,address)(bool)" 0x08b5ce2e3163e37059f807346dad4dd6235ed44f92dced22992662cb45706362 $A --rpc-url $R  # ANCHOR_ROLE
cast call 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 "hasRole(bytes32,address)(bool)" 0x55c05ddad8d728263a0a7974b9297f5cdfb53044b9a72a6dc5b27e5be010358d $A --rpc-url $R  # KEY_ROTATOR_ROLE
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 "hasRole(bytes32,address)(bool)" 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 $A --rpc-url $R  # REGISTRAR_ROLE
cast balance $A --rpc-url $R   # expect 1000000000000000000
```

## 4. Contract interfaces (verified against deployed source)

**PQAnchorRegistry** `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`

```solidity
// ANCHOR_ROLE. pqSignatureHash MUST be non-zero (reverts MissingPQCommitment). blockTo >= blockFrom.
function recordAnchor(bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo,
                      uint64 eventCount, bytes32 anchorChain, bytes32 pqSignatureHash) returns (uint256 anchorId);
function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash);          // ANCHOR_ROLE
function rotatePQKey(bytes32 newKeyHash, string calldata newAlgorithm);          // KEY_ROTATOR_ROLE (one-time)
```

**ContractRegistry** `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`

```solidity
// REGISTRAR_ROLE. name = keccak256(<utf8 contract name>) — NOT formatBytes32String. First version auto-activates.
function register(bytes32 name, uint64 version, address addr);                   // reverts ZeroAddress / AlreadyRegistered
function getActive(bytes32 name) view returns (address);
```

> Registry name gotcha: `name` is **`keccak256("YourContractName")`**, e.g.
> `cast keccak "AtlasAnchor"`. Using `formatBytes32String` was a real prior bug.

## 5. Network — WireGuard mesh (action required from Atlas)

Assigned mesh IP: **`10.43.0.51`** (partners sit at `.50+`; hara-did is `.50`).
The Hara operator runs `wg-add-peer.sh prepare hara-atlas 10.43.0.51` and sends the
onboarding packet (our hosts' public keys + endpoints + the `wg0.conf` template).
Atlas then:

```bash
# On the Atlas host, as root:
sudo apt-get update -qq && sudo apt-get install -y wireguard-tools
sudo install -m 700 -d /etc/wireguard
sudo sh -c 'umask 077 && wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key'
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/public.key     # <- send this back
```

Send back to the Hara operator: **(1) the WireGuard public key, (2) the host's
public IP.** Fill the `wg0.conf` template (Address `10.43.0.51/24`) but do **not**
`wg-quick up` until the operator confirms `finalize` is done. Then:

```bash
sudo systemctl enable --now wg-quick@wg0
ping -c3 10.43.0.21    # hara-rpc-1 (chain RPC tier)
```

---

## Hara-operator runbook (keys / SSH required)

All chain writes are propose-only from tooling — the operator signs with the
`DEFAULT_ADMIN_ROLE` key (the Vault-held admin; verified **not** an anvil key).
`roleAdmin` for all three roles is `DEFAULT_ADMIN_ROLE`.

```bash
PQ=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
CR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
ATLAS=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
WRITE=https://rpc.ledger.haratrust.io/write/
ADMIN_PK=<DEFAULT_ADMIN_ROLE private key>   # NOT an anvil key

cast send $PQ "grantRole(bytes32,address)" 0x08b5ce2e3163e37059f807346dad4dd6235ed44f92dced22992662cb45706362 $ATLAS --rpc-url $WRITE --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216  # ANCHOR_ROLE
cast send $PQ "grantRole(bytes32,address)" 0x55c05ddad8d728263a0a7974b9297f5cdfb53044b9a72a6dc5b27e5be010358d $ATLAS --rpc-url $WRITE --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216  # KEY_ROTATOR_ROLE
cast send $CR "grantRole(bytes32,address)" 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 $ATLAS --rpc-url $WRITE --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216  # REGISTRAR_ROLE

# Fund the signer (1 HARA buffer; at gasPrice 0 it never depletes):
cast send $ATLAS --value 1ether --rpc-url $WRITE --private-key $FUNDER_PK --legacy --gas-price 0 --chain 131216
```

If gas estimation balks on the zero-fee chain, add `--gas-limit 100000`.

**Post-ceremony — revoke `KEY_ROTATOR_ROLE`** once Atlas has done its one-time
`rotatePQKey` (least privilege):

```bash
cast send $PQ "revokeRole(bytes32,address)" 0x55c05ddad8d728263a0a7974b9297f5cdfb53044b9a72a6dc5b27e5be010358d $ATLAS \
  --rpc-url $WRITE --private-key $ADMIN_PK --legacy --gas-price 0 --chain 131216
```

WireGuard provisioning (host list corrected to the post-migration topology in PR #61):

```bash
deploy/ops/wg-add-peer.sh prepare  hara-atlas 10.43.0.51
deploy/ops/wg-add-peer.sh finalize hara-atlas 10.43.0.51 <ATLAS_PUBLIC_IP> <ATLAS_WG_PUBKEY>
```

### Security notes

- `KEY_ROTATOR_ROLE` is high-blast-radius (it sets the PQ key all *new* anchors are
  tagged with). Grant it for the one-time ceremony, then revoke (command above).
- Fund Atlas from a real operator key. The genesis funder `0x7099…79C8` is the
  well-known anvil#1 account (public private key); it holds no roles, but should be
  swept/retired rather than relied on.
- The `DEFAULT_ADMIN_ROLE` key was correctly re-keyed off the anvil defaults — keep
  it Vault-held and operator-only.
