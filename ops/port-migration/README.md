# Port migration — resolve collisions across the 5 Claude-managed Docker projects

## Why this exists

Five compose projects share the same Docker host:

| Project | Compose file |
|---|---|
| hara-registry | `C:/Projects/claude projects/hara-registry/chain/docker-compose.yml` |
| erudio_flow | `C:/Projects/claude projects/erudio_flow/docker-compose.yml` |
| hara-halal-passport | `C:/Projects/claude projects/hara-halal-passport/docker-compose.yml` |
| hara-did | `C:/Projects/claude projects/hara-did/docker-compose.dev.yml` |
| hara-xchange | `C:/Projects/claude projects/hara-xchange/platform/infra/docker-compose.yml` |

11 host ports are claimed by more than one project. Docker silently lets the first one win and refuses subsequent bindings — so whichever project starts second appears to "work" but quietly fails on the conflicting service.

## Authoritative project

**hara-registry keeps all its current host ports.** It is the largest piece of infrastructure (chain + RPC + signer + broadcaster + indexer + monitoring) and other clusters reference its endpoints. Moving its ports would force changes in 4 other repos.

The 4 other projects move their conflicting ports.

## Final port allocation (host side)

### hara-registry (UNCHANGED)
- Chain P2P: 30303 (tcp+udp)
- Grafana: **3200** (was 3000 — moved earlier in this session)
- Loki: **3201** (was 3100 — moved earlier in this session)
- Postgres: 5432
- Redis: 6379
- Signer API: 7000
- Vault: 8200
- HAProxy stats: 8404
- RPC HTTP: 8545
- RPC WS: 8546
- Prometheus: 9090
- Alertmanager: 9093
- Indexer metrics: 9100

### erudio_flow
- Postgres: 5432 → **5433**

### hara-halal-passport
- Postgres: 5432 → **5434**
- MinIO API: 9000 → **9010**
- MinIO Console: 9001 → **9011**
- App: 3001 (unchanged — no conflict)

### hara-did
- Postgres: 5432 → **5435**
- Redis: 6379 → **6380**
- Anvil/EVM RPC: 8545 → **8547**
- MinIO API: 9000 → **9012**
- MinIO Console: 9001 → **9013**
- 3002, 3010, 3011 (unchanged — no conflict)

### hara-xchange
- Vault: 8200 → **8201**
- Prometheus: 9090 → **9091**
- All 7xxx, 8443-8447, 8543, 8080-8084, 9002-9004, 9101, 4318, 16686 (unchanged — no conflict)

## How to apply the changes

> **Update**: this work is now bundled with **Phase 1 of platform consolidation**
> (shared Vault + Prometheus + Grafana + Loki + Alertmanager). The combined
> prompts live in `C:/Projects/claude projects/_platform/migrations/` and
> handle both the port migration **and** the move to the shared platform in
> one refactor. Prefer those over the standalone port-only prompts below.

| Project | Combined Phase-1 prompt (recommended) | Port-only prompt (legacy) |
|---|---|---|
| erudio_flow | `_platform/migrations/phase-1-erudio_flow.prompt.md` | [`erudio_flow.prompt.md`](erudio_flow.prompt.md) |
| hara-halal-passport | `_platform/migrations/phase-1-hara-halal-passport.prompt.md` | [`hara-halal-passport.prompt.md`](hara-halal-passport.prompt.md) |
| hara-did | `_platform/migrations/phase-1-hara-did.prompt.md` | [`hara-did.prompt.md`](hara-did.prompt.md) |
| hara-xchange | `_platform/migrations/phase-1-hara-xchange.prompt.md` | [`hara-xchange.prompt.md`](hara-xchange.prompt.md) |

After each project's prompt finishes:
```bash
cd <project-root>
docker compose down
docker compose up -d
```

Once all 4 are migrated, every project can run simultaneously without `port is already allocated` errors.

## Verification

```bash
# No port appears twice in this output
docker ps --format '{{.Ports}}' | tr ',' '\n' | grep -oE '0\.0\.0\.0:[0-9]+' | sort | uniq -d
```

Empty output = all clear.
