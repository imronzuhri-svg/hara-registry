# Strata Console

Unified admin / monitoring console for **Hara Registry**. See the full plan in
[`../doc/registry-console-plan.md`](../doc/registry-console-plan.md).

**This is P0 — read-only "glass."** It shows a single-pane dashboard and does
**no** privileged writes. Governance / funding / validator actions arrive in
P1+ (and the codebase extracts to a private repo at that point).

## Stack
- Vite + React + TypeScript
- Tailwind (Strata theme tokens in `tailwind.config.ts`, sourced from `doc/design`)
- `viem` (chain reads; richer use in later phases)

## Run

```bash
cd console
pnpm install
cp .env.example .env      # optional; defaults work
pnpm dev                  # http://localhost:5273
```

The dev server proxies `/rpc/*` to the public gateway (`VITE_RPC_UPSTREAM`) so
the browser avoids CORS. The **Chain** panel is wired live (chainId, latest
block, rough block time); the other panels are styled placeholders labelled with
the P0 sub-phase that will wire them (`P0.2` host/RPC/service health via the
Console API, `P0.3` backups/vault/alerts/watchlist).

## Build / typecheck

```bash
pnpm typecheck
pnpm build
```

## Branding
"Strata" identity from `doc/design/` — teal→blue→indigo ring gradient
(`#2BD4C0`→`#3B6BFF`→`#5A45E0`), warm amber core (`#FFC56E`/`#F39B24`), ink-navy
surfaces (`#070B18`/`#0C1226`/`#101A38`), Sora display + Inter body. The animated
core pulses while the chain is producing blocks.

## Auth (later)
Production auth is **Hara Numira** (hara-did decentralized SSO) — `did:hara`
login, RBAC bound to the DID. P0 runs behind the WireGuard/VPN gate with an auth
stub.
