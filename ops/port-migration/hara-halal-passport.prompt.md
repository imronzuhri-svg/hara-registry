# Paste this into a fresh Claude Code session opened in `C:/Projects/claude projects/hara-halal-passport/`

---

I need you to resolve host-port collisions with other Docker projects on this machine.

## Context

This machine runs five Docker compose projects. Several share host ports, which means only the first to start works — the rest silently fail. I am migrating the conflicting ports in 4 of the 5 projects (hara-ledger stays canonical).

This project's collisions:
- **Postgres :5432** conflicts with hara-ledger + erudio_flow + hara-did
- **MinIO :9000 + :9001** conflict with hara-did

The local app port `3001` is unique to this project and stays as-is.

## The changes

| Service | Current host port | New host port |
|---|---|---|
| Postgres | 5432 | **5434** |
| MinIO API | 9000 | **9010** |
| MinIO Console | 9001 | **9011** |
| App | 3001 | 3001 (unchanged) |

Container-side ports stay the same. Only host bindings change. So compose mappings become:

```yaml
# Postgres
- "5434:5432"
# MinIO
- "9010:9000"
- "9011:9001"
```

## What I want you to do

1. Read `docker-compose.yml` and confirm the current mappings.
2. Update the three port lines as shown above.
3. Search the entire `hara-halal-passport/` project for *host-side* references to the old ports:
   - For Postgres: `localhost:5432`, `127.0.0.1:5432`, `:5432` outside compose-internal context, `DATABASE_URL`, `POSTGRES_PORT`, `POSTGRES_HOST`, any seed/migration script that connects from outside
   - For MinIO: `localhost:9000`, `localhost:9001`, `127.0.0.1:9000`, `127.0.0.1:9001`, `S3_ENDPOINT`, `MINIO_ENDPOINT`, any console URL strings in docs
4. Update each occurrence to the new port — but **only where the connection is from the host**, not inside the docker network. Internal references like `postgres:5432` or `minio:9000` (Docker DNS names) MUST stay on the original port.
5. Update `.env.example` (or equivalent) for host-side defaults.
6. Update README / docs that mention any of these ports.
7. Show me a summary of every file changed and before/after.
8. **Do not run any docker commands.** I'll bring the stack up after reviewing.

## Why these specific ports

The port-allocation plan across the 5 projects:

**Postgres**:
- hara-ledger: 5432 (canonical, unchanged)
- erudio_flow: 5433
- hara-halal-passport: **5434** ← this project
- hara-did: 5435

**MinIO** (this project + hara-did both run MinIO):
- hara-halal-passport: **9010 / 9011** ← this project
- hara-did: 9012 / 9013

This keeps related services clustered for ops sanity.

## Verification after edits

In `docker-compose.yml`:
- `"5434:5432"` appears exactly once (for Postgres)
- `"9010:9000"` appears exactly once (for MinIO API)
- `"9011:9001"` appears exactly once (for MinIO Console)
- No raw `5432`, `9000`, or `9001` on the LEFT side of any `host:container` mapping

Begin.
