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

## Layout

- `console/` — the web SPA (this package)
- `console/server/` — the **Console API** (Fastify), a read-only aggregator that
  exposes `GET /api/overview` (chain, validators, accounts/watchlist, RPC tier,
  services, vault seal, alerts, backups). See `server/` for config.

## Run (web + API)

```bash
# 1) Console API (read-only aggregator)
cd console/server && pnpm install && pnpm start    # http://localhost:8910

# 2) Web (in another shell)
cd console && pnpm install
cp .env.example .env        # optional; defaults work
pnpm dev                    # http://localhost:5273  (proxies /api -> :8910)
```

**What's live in dev:** chain, validators, and the account watchlist read live
through the API (which talks to the public RPC). The internal-mesh sources
(RPC-tier/HAProxy, services/indexer-lag, Vault seal, Alertmanager) show
`unavailable` from a laptop and resolve automatically when the API runs on the
WireGuard mesh (hara-stateless-2). Backups need a small status agent
(`BACKUPS_STATUS_URL`). Every section degrades independently — one unreachable
source never blanks the page.

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

## Deploy (production — hara-stateless-2)

Two containers behind the edge Caddy, on the `hara-platform` bridge; internal
data sources reached over the WireGuard mesh. Nothing is published to the host.

```bash
# on hara-stateless-2, from the repo root
docker compose -f deploy/services/docker-compose.console.yml up -d --build
# edge: add the console.platform.haratrust.io site (already in deploy/edge/Caddyfile)
#       set the basic_auth bcrypt hash on-host, then reload/recreate Caddy.
```

- `console/Dockerfile` → static SPA served by nginx (`hara-console-web`).
- `console/server/Dockerfile` → the read-only API (`hara-console-api`), env-wired
  to the mesh (RPC/Prometheus/Vault/HAProxy/Alertmanager + `BACKUPS_AGENT_URLS`).
- Caddy `console.platform.haratrust.io`: `/api/*` → API, `/*` → web, gated by
  basic_auth (P0 stopgap) — replace with Hara Numira dSSO + WG/VPN restriction.

### Backups-status agent
Backups span multiple hosts (hara-stateful + validators), so a tiny read-only
agent (`console/agent/`) runs on each and reports its `hara-*-snapshot` timer
status; the API aggregates them via `BACKUPS_AGENT_URLS`.

```bash
# on each host that runs snapshot timers (hara-stateful, hara-v1..v4):
sudo ./deploy/ops/install-console-agent.sh        # systemd service on :8911 (wg0)
# then restrict the port to the mesh:
sudo ufw allow from 10.43.0.0/24 to any port 8911 proto tcp
```

## Auth (later)
Production auth is **Hara Numira** (hara-did decentralized SSO) — `did:hara`
login, RBAC bound to the DID. P0 runs behind the WireGuard/VPN gate with an auth
stub.
