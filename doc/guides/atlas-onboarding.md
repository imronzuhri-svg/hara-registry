# HARA Atlas — Registry Onboarding Packet

Onboarding reference for HARA Atlas integrating against the Hara Registry sovereign
chain (Besu QBFT, chain id **131216**) for on-chain anchoring plus deploying and
registering its own contract family.

> Source of truth: [`hara-registry-facts.md`](../api/hara-registry-facts.md). All
> addresses/roles below were verified live on-chain (chain 131216) on 2026-06-20.

## PQ-anchoring model — (c): Atlas runs its OWN PQAnchorRegistry instance

The shared `PQAnchorRegistry` (`0x8A79…C318`) is **multi-tenant**: its
`currentPQKeyHash` is `keccak256(`the platform anchor-worker's ML-DSA-65 public
key`)` = `0xa7dca428…`, with 3,300+ anchors, and the matching ML-DSA **secret** key
lives only in platform Vault (`secret/haraledger/signer-keys/anchor-worker`). The
contract does **not** verify the PQ signature on-chain — `recordAnchor` stores the
`pqSignatureHash` and freezes `pqKeyHash = currentPQKeyHash`; verification is
**off-chain** (auditor fetches the pubkey at `pqKeyHash` + the signature at
`pqSignatureHash` from CAS and runs `ml_dsa65.verify`).

Consequences:
- **(a) rotate the shared key → rejected.** `rotatePQKey` is registry-global. If Atlas
  rotated it, every *new* anchor (platform's, Numira's, Atlas's) would be tagged with
  Atlas's key hash while those other integrators keep signing with the existing key →
  off-chain verification breaks for everyone, plus rotate-thrash against the worker's
  bootstrap.
- **(b) use the shared key → impossible.** Atlas can't hold the platform ML-DSA secret.
- **(c) own instance → chosen.** Deployment is open (no genesis permissioning), and Atlas
  already deploys its own family. Atlas deploys its own `PQAnchorRegistry`; the
  constructor makes `ATLAS_SIGNER` the admin **and** `ANCHOR_ROLE`/`KEY_ROTATOR_ROLE`
  holder *on that instance* — so Atlas self-administers with zero coupling to the shared
  registry. Atlas registers its instance in the shared `ContractRegistry` for discovery.

Atlas signer: `ATLAS_SIGNER = 0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8`
Atlas mesh IP: `10.43.0.51`

---

## 1. Chain + connection (Atlas side)

```ini
CHAIN_ID=131216                # legacy (type-0) txs ONLY; EVM London (no PUSH0); gasPrice 0
GAS_PRICE=0
# Public RPC (trailing slash is MANDATORY):
RPC_READ_URL=https://rpc.ledger.haratrust.io/read/     # rpc-cache-backed (~99% hit); read-heavy verify
RPC_WRITE_URL=https://rpc.ledger.haratrust.io/write/   # eth_sendRawTransaction
RPC_WS_URL=wss://rpc.ledger.haratrust.io/ws
# In-mesh (after WireGuard is up, from 10.43.0.51 -> HAProxy on rpc-1):
RPC_READ_URL_MESH=http://10.43.0.21:8545/rpc/read/
RPC_WRITE_URL_MESH=http://10.43.0.21:8545/rpc/write/
RPC_WS_URL_MESH=ws://10.43.0.21:8546/rpc/read
# Shared contracts (read / register only — do NOT mutate the shared PQAnchorRegistry):
CONTRACT_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
SHARED_PQ_ANCHOR_REGISTRY=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318   # platform/Numira's; do NOT call
ATLAS_SIGNER=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
```

Foundry deploys/sends MUST use `--legacy --skip-simulation` (gas price 0).

## 2. The three rules that bite everyone

1. **Legacy txs, `gasPrice 0`, `chainId 131216`** — EIP-1559 fields are rejected.
2. **Pre-fund >= 1 wei** before a wallet's first tx — Besu drops zero-balance senders
   even at gasPrice 0. (Atlas signer is funded with 1 HARA.)
3. **Check `receipt.status == 0x1`** — a mined tx can still have reverted.

## 3. Access on the SHARED infra

Under model (c), the only shared-infra access Atlas needs:

| Role / action | Where | Why |
|---|---|---|
| funding (1 HARA) | `ATLAS_SIGNER` | deploy + send txs |
| `REGISTRAR_ROLE` | ContractRegistry `0xe7f1…0512` | register the Atlas contract family for discovery |

`REGISTRAR_ROLE = 0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238`.
**No `ANCHOR_ROLE`/`KEY_ROTATOR_ROLE` on the shared `0x8A79…C318`** — Atlas holds those
on its own instance via the constructor.

Atlas self-check (after the operator runs fund + grant):

```bash
R=https://rpc.ledger.haratrust.io/read/ ; A=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
cast balance $A --rpc-url $R                                              # expect 1000000000000000000
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 "hasRole(bytes32,address)(bool)" \
  0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238 $A --rpc-url $R   # REGISTRAR_ROLE -> true
```

## 4. Atlas's own PQAnchorRegistry instance

```solidity
// PQAnchorRegistry (Apache-2.0, OZ AccessControl) — deploy your own copy.
// constructor grants `admin` DEFAULT_ADMIN_ROLE + ANCHOR_ROLE + KEY_ROTATOR_ROLE.
constructor(address admin, bytes32 initialPQKeyHash, string initialAlgorithm);
function recordAnchor(bytes32 merkleRoot, bytes32 sha3Root, uint64 blockFrom, uint64 blockTo,
                      uint64 eventCount, bytes32 anchorChain, bytes32 pqSignatureHash) returns (uint256); // ANCHOR_ROLE
function confirmExternalAnchor(uint256 anchorId, bytes32 anchorTxHash);   // ANCHOR_ROLE
function rotatePQKey(bytes32 newKeyHash, string newAlgorithm);            // KEY_ROTATOR_ROLE (own instance only)
```

Deploy with `admin = ATLAS_SIGNER`, `initialPQKeyHash = keccak256(AtlasPublicKey)`,
`initialAlgorithm = "ML-DSA-65"`. Keep the ML-DSA seed/secret in Atlas's own Vault/KMS;
publish `AtlasPublicKey` to Atlas CAS keyed by `keccak256(pubkey)`.

### How Atlas computes `pqSignatureHash` (match the platform scheme)

ML-DSA-65 (Dilithium3, FIPS 204): pub 1952 B, secret 4032 B, sig 3309 B
(`@noble/post-quantum` `ml_dsa65`).

```
canonicalMessage = uint16BE(len("ML-DSA-65")) ‖ utf8("ML-DSA-65") ‖ merkleRoot(32B)
                   ‖ u64BE(blockFrom) ‖ u64BE(blockTo) ‖ u64BE(eventCount) ‖ anchorChain(32B)
sig              = ml_dsa65.sign(AtlasSecretKey, canonicalMessage)   // 3309 bytes
pqSignatureHash  = keccak256(sig)                                    // bytes32 passed to recordAnchor
```

- `merkleRoot`: keccak256 Merkle tree over the batch's leaves (deterministic leaf, e.g.
  `keccak256(txHash ‖ logIndex)`).
- `sha3Root`: second hash-agility commit (platform currently duplicates the keccak root).
- Store each raw `sig` off-chain in CAS keyed by the anchor; the contract does **not**
  verify on-chain — auditors fetch pubkey (at `pqKeyHash`) + sig (at `pqSignatureHash`)
  and run `ml_dsa65.verify`.

## 5. Register the family in the shared ContractRegistry

```solidity
// REGISTRAR_ROLE. name = keccak256("<utf8 contract name>") — NOT formatBytes32String; first version auto-activates.
function register(bytes32 name, uint64 version, address addr);
function getActive(bytes32 name) view returns (address);
```

e.g. `cast keccak "AtlasPQAnchorRegistry"` → `name`; `version=1`; `addr=<your instance>`.
Register the instance and any other discoverable family contracts.

## 6. Network — WireGuard mesh (action required from Atlas)

Assigned mesh IP: **`10.43.0.51`**. The Hara operator runs
`wg-add-peer.sh prepare hara-atlas 10.43.0.51` and sends the onboarding packet (our
hosts' public keys + endpoints + the `wg0.conf` template). Atlas:

```bash
sudo apt-get update -qq && sudo apt-get install -y wireguard-tools
sudo install -m 700 -d /etc/wireguard
sudo sh -c 'umask 077 && wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key'
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/public.key     # <- send back
```

Send back: **(1) the WireGuard public key, (2) the host's public IP.** Fill the
`wg0.conf` template (Address `10.43.0.51/24`) but do **not** `wg-quick up` until the
operator confirms `finalize`. Then `sudo systemctl enable --now wg-quick@wg0` and
`ping -c3 10.43.0.21`.

## 7. Deliver back to the Hara operator

- WireGuard public key + Atlas host public IP (for mesh `finalize`).
- Deployed PQAnchorRegistry instance address + `keccak256(AtlasPublicKey)` and its CAS location.
- ContractRegistry name(s) registered (the keccak256 preimage strings) + tx hashes.
- First `recordAnchor` tx hash (on the Atlas instance) + the `anchorId`.

---

## Hara-operator runbook (keys / SSH required)

Chain writes are propose-only from tooling — the operator signs. Under model (c) the
only shared-infra writes are **fund + `REGISTRAR_ROLE`** (`roleAdmin` =
`DEFAULT_ADMIN_ROLE`, held by the Vault admin key — verified **not** an anvil key).

```bash
WRITE=https://rpc.ledger.haratrust.io/write/ ; READ=https://rpc.ledger.haratrust.io/read/
CR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 ; ATLAS=0xec76fa92b6bcc042b0ccd52a5f64dbc3e8946fa8
REGISTRAR=0xedcc084d3dcd65a1f7f23c65c46722faca6953d28e43150a467cf43e5c309238
C="--legacy --gas-price 0 --chain 131216 --rpc-url $WRITE"
: "${ADMIN_PK:?DEFAULT_ADMIN_ROLE key from Vault, NOT an anvil key}"
: "${FUNDER_PK:?a funded operator key}"

cast send $ATLAS --value 1ether --private-key $FUNDER_PK $C                          # fund
cast send $CR "grantRole(bytes32,address)" $REGISTRAR $ATLAS --private-key $ADMIN_PK $C  # REGISTRAR_ROLE

# confirm:
cast balance $ATLAS --rpc-url $READ                                                  # expect 1000000000000000000
cast call $CR "hasRole(bytes32,address)(bool)" $REGISTRAR $ATLAS --rpc-url $READ     # expect true
```

If gas estimation balks on the zero-fee chain, add `--gas-limit 100000`.

WireGuard provisioning (host list corrected to the post-migration topology in PR #61):

```bash
deploy/ops/wg-add-peer.sh prepare  hara-atlas 10.43.0.51
deploy/ops/wg-add-peer.sh finalize hara-atlas 10.43.0.51 <ATLAS_PUBLIC_IP> <ATLAS_WG_PUBKEY>
```

### Security notes

- **Do not grant `ANCHOR_ROLE`/`KEY_ROTATOR_ROLE` on the shared `0x8A79…C318`.** Atlas
  holds these on its own instance; granting on the shared one (especially
  `KEY_ROTATOR_ROLE`) would let one tenant break PQ verification for all others.
- Fund Atlas from a real operator key. The genesis funder `0x7099…79C8` is the
  well-known anvil#1 account (public private key); it holds no roles but should be
  swept/retired rather than relied on.
- The `DEFAULT_ADMIN_ROLE` key was correctly re-keyed off the anvil defaults — keep it
  Vault-held and operator-only.
