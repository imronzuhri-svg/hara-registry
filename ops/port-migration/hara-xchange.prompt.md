# Paste this into a fresh Claude Code session opened in `C:/Projects/claude projects/hara-xchange/`

---

I need you to resolve host-port collisions with other Docker projects on this machine.

## Context

This machine runs five Docker compose projects (hara-registry, erudio_flow, hara-halal-passport, hara-did, hara-xchange) that share a Docker host. Several bind the same host port and only the first one to start works — the rest fail silently. I'm migrating the conflicting ports in 4 of the 5 projects (hara-registry stays canonical because it's the largest cluster).

This project has 2 collisions with hara-registry:
- **Vault :8200**
- **Prometheus :9090**

Every other port hara-xchange uses (the 7xxx range, 8443-8447, 8543, 8080-8084, 9002-9004, 9101, 4318, 16686, 3030) is fine and stays unchanged.

## Compose file location

`C:/Projects/claude projects/hara-xchange/platform/infra/docker-compose.yml`

There may also be other compose files in subdirectories — please check.

## The changes

| Service | Current host port | New host port |
|---|---|---|
| Vault | 8200 | **8201** |
| Prometheus | 9090 | **9091** |

Container-side ports stay the same. Only host bindings change:

```yaml
ports: ["8201:8200"]   # Vault
ports: ["9091:9090"]   # Prometheus
```

## What I want you to do

1. Read `platform/infra/docker-compose.yml`. Find the Vault and Prometheus service definitions.
2. Update both port mappings as shown above.
3. Also search for any other compose files in the repo that might define a Vault or Prometheus service.
4. Search the entire `hara-xchange/` project for *host-side* references to the old ports. Look for:

   **Vault**: `localhost:8200`, `127.0.0.1:8200`, `VAULT_ADDR=http://localhost:8200`, any documentation that links to `http://localhost:8200`, any client/SDK config that targets the host (not internal `vault:8200`).

   **Prometheus**: `localhost:9090`, `127.0.0.1:9090`, `PROMETHEUS_URL`, any Grafana datasource that points at the host (vs internal `prometheus:9090`), README references, dashboards-as-code that hardcode the URL.

5. Update each occurrence to the new port — but **only where the connection is from the host**. **Do NOT change** internal Docker DNS references like `vault:8200` or `prometheus:9090` between containers on the same network. Those keep using the original port because they cross the docker bridge, not the host.

6. Update `.env.example` (or whatever this project uses for env defaults) if it documents the host port.

7. Update README, runbooks, and any setup docs that mention the localhost URLs.

8. Show me a complete summary of every file changed: path, line numbers, before/after.

9. **Do not run any docker commands.** I'll bring the stack up after reviewing.

## Why these specific ports

| Service | Cross-project port plan |
|---|---|
| Vault | hara-registry 8200 (canonical) / **hara-xchange 8201** |
| Prometheus | hara-registry 9090 (canonical) / **hara-xchange 9091** |

8201 and 9091 are confirmed not used elsewhere on this host.

## Why hara-xchange is keeping most of its ports

hara-xchange's port allocation already uses a distinctive 7xxx scheme that doesn't collide with anything. Only 8200 and 9090 are common-name ports that conflicted with hara-registry.

## Verification after edits

In the compose file(s):
- `"8201:8200"` for Vault appears exactly once
- `"9091:9090"` for Prometheus appears exactly once
- No raw `8200` or `9090` appears on the LEFT side of any `host:container` port mapping

Sanity grep: `grep -rn "localhost:8200\|localhost:9090"` should return zero results outside `node_modules`/`.git`/`dist`/build artifacts.

Begin.
