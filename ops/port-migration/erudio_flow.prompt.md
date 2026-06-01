# Paste this into a fresh Claude Code session opened in `C:/Projects/claude projects/erudio_flow/`

---

I need you to resolve a host-port collision with another Docker project on this machine.

## Context

This machine runs five Docker compose projects. Several of them currently bind the same host port, which means only the first one to start works — the rest silently fail. I am migrating the conflicting ports in 4 of the 5 projects (hara-registry stays canonical).

This project's collision: **Postgres on host port 5432** conflicts with `hara-registry`, `hara-halal-passport`, and `hara-did`.

## The change

| Service | Current host port | New host port |
|---|---|---|
| Postgres | 5432 | **5433** |

The **container-side** port stays 5432 — only the host-side changes. So in docker-compose the mapping becomes `"5433:5432"`.

## What I want you to do

1. Read `docker-compose.yml` and confirm the current mapping is `"5432:5432"` (or similar).
2. Edit it to `"5433:5432"`.
3. Search the entire `erudio_flow/` project for any of these strings that reference Postgres as a *host-side* connection (i.e., from outside the docker network):
   - `localhost:5432`
   - `127.0.0.1:5432`
   - `:5432` (anywhere that's not inside a docker-compose internal reference like `postgres:5432`)
   - `DATABASE_URL`, `POSTGRES_PORT`, `POSTGRES_HOST` env defaults
4. Update each occurrence to use port `5433` — but ONLY where the connection is from the host. **Do NOT change** internal-to-docker-network references (e.g., `postgres:5432` in another service's env config — those use Docker DNS and stay on 5432).
5. Update `.env.example` (or equivalent) if it documents the host port.
6. Update README / docs that mention the port.
7. Show me a summary of every file changed and the before/after.
8. **Do not run any docker commands.** I'll bring the stack up myself after reviewing.

## Why 5433 specifically

The port-allocation plan across the 5 projects is:

- hara-registry: 5432 (canonical, unchanged)
- erudio_flow: **5433** ← this project
- hara-halal-passport: 5434
- hara-did: 5435

This keeps Postgres ports clustered together for ops sanity.

## Verification you can run

After your edits, the only host-port mapping in docker-compose.yml that touches Postgres should be `"5433:5432"`. No other 5432-on-host references should remain.

Begin.
