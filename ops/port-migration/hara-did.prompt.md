# Paste this into a fresh Claude Code session opened in `C:/Projects/claude projects/hara-did/`

---

I need you to resolve host-port collisions with other Docker projects on this machine.

## Context

This machine runs five Docker compose projects (hara-registry, erudio_flow, hara-halal-passport, hara-did, hara-xchange) that share a single Docker host. Several bind the same host port and the second one to start fails silently. I'm migrating the conflicting ports in 4 of the 5 projects (hara-registry stays canonical because it's the largest infra cluster).

This project has 5 collisions:
- **Postgres :5432** with hara-registry + erudio_flow + hara-halal-passport
- **Redis :6379** with hara-registry
- **EVM RPC :8545** (Anvil/Hardhat or similar) with hara-registry
- **MinIO :9000 + :9001** with hara-halal-passport

The local app ports `3002`, `3010`, `3011` are unique to this project — leave them alone.

## Compose file location

`C:/Projects/claude projects/hara-did/docker-compose.dev.yml` (also check for any other `docker-compose*.yml` in the repo).

## The changes

| Service | Current host port | New host port |
|---|---|---|
| Postgres | 5432 | **5435** |
| Redis | 6379 | **6380** |
| EVM RPC (Anvil/Hardhat) | 8545 | **8547** |
| MinIO API | 9000 | **9012** |
| MinIO Console | 9001 | **9013** |
| App ports 3002, 3010, 3011 | unchanged | unchanged |

Container-side ports stay the same. Only host bindings change. Resulting compose mappings:

```yaml
- "5435:5432"   # Postgres
- "6380:6379"   # Redis
- "8547:8545"   # EVM RPC
- "9012:9000"   # MinIO API
- "9013:9001"   # MinIO Console
```

## What I want you to do

1. Find every `docker-compose*.yml` in the project and read each.
2. Update the five port mappings as shown above.
3. Search the entire `hara-did/` project for *host-side* references to the old ports. Be thorough — services like wallet, indexer, gateway, oracle, contracts, issuer-portal, admin-console, verifier-demo may each have their own env file or hardcoded constants. Look for:

   **Postgres**: `localhost:5432`, `127.0.0.1:5432`, `DATABASE_URL`, `POSTGRES_PORT`, `POSTGRES_HOST`, `PG_HOST`, `PG_PORT`, drizzle/prisma config, migration scripts that run from the host.

   **Redis**: `localhost:6379`, `REDIS_URL`, `REDIS_PORT`, `REDIS_HOST`, Bull/BullMQ config, ioredis config.

   **EVM RPC**: `localhost:8545`, `127.0.0.1:8545`, `RPC_URL`, `ETH_RPC_URL`, `ANVIL_URL`, `HARDHAT_URL`, hardhat.config.ts networks, foundry.toml rpc_endpoints, viem/ethers public client configs, `forge script --rpc-url`, wagmi config, frontend env (NEXT_PUBLIC_RPC_URL etc.), wallet SDK config, deployment scripts.

   **MinIO**: `localhost:9000`, `localhost:9001`, `S3_ENDPOINT`, `MINIO_ENDPOINT`, `MINIO_CONSOLE_URL`, console URLs in docs/screenshots-of-text.

4. Update each occurrence to the new port — but **only where the connection is from the host**. **Do NOT change** internal Docker DNS references like `postgres:5432`, `redis:6379`, `anvil:8545`, `minio:9000`. Those stay on the original port because they cross the docker bridge, not the host.

5. Update every `.env.example`, `.env.development`, `.env.local.example`, and `.env.test.example` that documents the host port.

6. Update README and any per-app README in `apps/<name>/` that mentions a localhost URL.

7. **HaraDID is a frontend-heavy project** — pay extra attention to:
   - `apps/wallet/` (React Native / Expo)
   - `apps/issuer-portal/` (Next.js)
   - `apps/admin-console/` (Next.js)
   - `apps/verifier-demo/` (static HTML or Next.js)
   Each of these probably has an env file pointing to a localhost RPC and possibly a localhost gateway. Audit them all.

8. **HaraDID is also a contracts project** — check:
   - `packages/contracts/foundry.toml` `[rpc_endpoints]` section
   - `packages/contracts/hardhat.config.ts` networks
   - Any `forge script --rpc-url ...` calls in package.json scripts or shell scripts

9. Show me a complete summary of every file changed: path, line numbers, before/after.

10. **Do not run any docker commands** and **do not bring the stack up.** I'll review your changes first.

## Why these specific ports

| Service | Cross-project port plan |
|---|---|
| Postgres | hara-registry 5432 (canonical) / erudio_flow 5433 / hara-halal-passport 5434 / **hara-did 5435** |
| Redis | hara-registry 6379 (canonical) / **hara-did 6380** |
| EVM RPC | hara-registry 8545 (canonical, Besu) / **hara-did 8547** (Anvil/Hardhat) |
| MinIO API | hara-halal-passport 9010 / **hara-did 9012** |
| MinIO Console | hara-halal-passport 9011 / **hara-did 9013** |

Note: 8546 is hara-registry's WebSocket RPC, so hara-did's RPC skips to 8547.

## Verification after edits

In every `docker-compose*.yml`:
- `"5435:5432"` for Postgres (exactly once across all compose files)
- `"6380:6379"` for Redis (exactly once)
- `"8547:8545"` for EVM RPC (exactly once)
- `"9012:9000"` for MinIO API
- `"9013:9001"` for MinIO Console
- No raw `5432`, `6379`, `8545`, `9000`, or `9001` appears on the LEFT side of any `host:container` port mapping

Sanity grep on the host side: `grep -rn "localhost:5432\|localhost:6379\|localhost:8545\|localhost:9000\|localhost:9001"` should return zero results outside `node_modules`/`.git`/`dist`/build artifacts.

Begin.
