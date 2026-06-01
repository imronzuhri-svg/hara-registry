# hara-xchange — Deploying Your Own Contract on Hara Registry

> **Audience:** hara-xchange engineers deploying a smart contract onto the Hara
> Registry chain (the shared permissioned Besu/QBFT chain, chain ID **131216**).
> **Time:** ~10 minutes once Foundry is installed.

This is a permissioned, **free-gas** chain — you deploy with a normal EVM
toolchain (Foundry), there are no gas costs, and you only need a deployer key
that the chain will accept.

---

## 1. Your deployer key

HARA ops has provisioned a **dedicated deployer account for hara-xchange**:

| | |
|---|---|
| **Address** | `0xFB146120F459E041a9d450300cd34661a6aEAF4e` |
| Private key | **delivered to you separately** by HARA ops (1Password / secure channel) — *not* in this document |
| Roles | none (a plain deployer; it cannot touch platform-admin functions) |

> ⚠️ **Why the private key isn't printed here:** the `hara-registry` repo is
> **public**, so any key committed to a doc is instantly leaked. Keep your copy
> of the private key in a secret manager — never commit it, never paste it into
> chat/issues/CI logs. If it leaks, tell HARA ops and we'll rotate it.

**Prefer to use your own key instead?** Generate one and send us *only the
address* — we'll make sure the chain accepts it:

```bash
cast wallet new
# Address: 0x....   ← send this to HARA ops
# Private key: 0x... ← keep secret
```

> ⚠️ **Your deployer MUST hold a non-zero balance (≥ 1 wei).** Even though gas is
> free (`gasPrice = 0`), Besu **silently skips zero-balance senders** — the tx
> sits in the pool unmined and your deploy tool hangs waiting for a receipt that
> never comes (see integration manual §17.4). HARA ops **pre-funds** this
> dedicated deployer, so you don't need to do anything. The balance is never
> consumed (gas is free), so a one-time funding lasts forever.
>
> If you bring your **own** key instead, send us the address and we'll fund it
> with a small amount before your first deploy.

---

## 2. Chain connection

| | |
|---|---|
| Chain ID | **131216** |
| RPC (writes — deploy here) | `https://rpc.ledger.haratrust.io/write/` |
| RPC (reads) | `https://rpc.ledger.haratrust.io/read/` |
| WebSocket | `wss://rpc.ledger.haratrust.io/ws/` |
| Block explorer | `https://explorer.ledger.haratrust.io` |
| Tx type | **legacy**, `gasPrice = 0` |
| Block time | ~2 s (QBFT, instant finality) |

> **Always use legacy txs with `--gas-price 0`.** This is a zero-base-fee chain;
> EIP-1559 (`maxFeePerGas`) style fees are not used.
>
> ⚠️ **The trailing slash matters.** The public routes are `/read/` and
> `/write/` — `…/read` (no slash) returns `404 Route not found`.

Quick connectivity check:

```bash
cast chain-id --rpc-url https://rpc.ledger.haratrust.io/read/
# → 131216
```

---

## 3. Foundry project setup

Install Foundry if you haven't:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

In your contracts repo:

```bash
forge init --no-git .        # or use your existing project
forge build
```

`foundry.toml` essentials:

```toml
[profile.default]
solc_version = "0.8.26"      # match the platform's compiler
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
hara = "https://rpc.ledger.haratrust.io/write/"
```

---

## 4. Deploy your contract

Put your deployer private key in an env var (don't inline it on the command line
where it lands in shell history):

```bash
export HARA_XCHANGE_PK=0x...        # the key delivered to you (or your own)
```

Deploy with `forge create` (note `--legacy` and `--gas-price 0`):

```bash
forge create \
  --rpc-url https://rpc.ledger.haratrust.io/write/ \
  --private-key "$HARA_XCHANGE_PK" \
  --legacy --gas-price 0 \
  src/YourContract.sol:YourContract \
  --constructor-args <arg1> <arg2>
```

Or, for anything non-trivial, use a deploy **script** (`forge script`):

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.ledger.haratrust.io/write/ \
  --private-key "$HARA_XCHANGE_PK" \
  --legacy --with-gas-price 0 \
  --broadcast
```

After it confirms, **verify the receipt status is success** — a mined tx can
still have reverted:

```bash
cast receipt <txHash> --rpc-url https://rpc.ledger.haratrust.io/read/ \
  | grep -E 'status|contractAddress'
# status must be 1 (0x1)
```

Record your deployed address from `contracts/broadcast/<script>/131216/run-latest.json`.

---

## 5. (Optional) Register your contract for discoverability

Hara Registry has a `ContractRegistry` (`0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`)
that maps a name → address so other services can look your contract up. Writing
to it needs `REGISTRAR_ROLE`, which only the platform admin can grant.

If you want your contract registered, send HARA ops:
- the **name** (e.g. `HaraXchangeOrderBook`),
- the **deployed address**,

and we'll register it for you (or grant your deployer `REGISTRAR_ROLE` if you
expect to register often).

---

## 6. (Optional) Verify source on the explorer

Blockscout verification makes your source + ABI visible at
`explorer.ledger.haratrust.io`:

```bash
forge verify-contract \
  --rpc-url https://rpc.ledger.haratrust.io/read/ \
  --verifier blockscout \
  --verifier-url https://explorer.ledger.haratrust.io/api/ \
  <deployedAddress> \
  src/YourContract.sol:YourContract
```

---

## 7. Dos & don'ts

- ✅ Use **legacy txs, `gasPrice 0`, chain ID `131216`**.
- ✅ Always check the receipt `status == 1` before treating a deploy as done.
- ✅ Keep your deployer private key in a secret manager; rotate via HARA ops if exposed.
- ❌ Don't commit the private key anywhere (the chain repo is **public**).
- ❌ Don't assume EIP-1559 fees — they're not used here.
- ❌ Don't try to call platform-admin/role-gated functions on HARA's core
  contracts; your deployer has no roles by design.

---

## 8. Getting help

- **Chain / RPC reference:** `doc/hara-registry-technical-manual.md`
- **Deeper integration (Vault, indexing, observability, conventions):**
  `doc/hara-registry integration manual.md`
- **Operational source of truth:** `PRODUCTION-READINESS.md`
- Anything blocked (key rejected, need a role, need registration): contact HARA ops.
