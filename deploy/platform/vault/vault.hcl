# Vault server config — Raft (integrated) storage mode.
#
# Used in production (hara-stateful VPS). Local dev still uses `server -dev`
# via docker-compose.yml. This file is consumed by the secrets compose stack
# (deploy/platform/docker-compose.secrets.yml).
#
# After first boot, you MUST initialise + unseal Vault. See
# deploy/ops/vault-raft-init.sh for the canonical one-shot ritual.

# Web UI on the same port as the API. Caddy terminates TLS in front; Vault
# itself runs plaintext on the WireGuard mesh.
ui = true

storage "raft" {
  path    = "/vault/data"
  node_id = "hara-vault-1"

  # On a single-node Raft setup (where we are at P0–P1), no other peers exist.
  # Multi-node Vault HA arrives at P2+ and adds retry_join blocks here.
  performance_multiplier = 1
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true  # Caddy terminates TLS at the edge; Vault is mesh-internal.

  # Allow Prometheus to scrape /v1/sys/metrics without a token. Safe because the
  # listener is mesh-internal (WireGuard only) and metrics expose no secrets —
  # just operational counters + seal status. Avoids persisting a scrape token.
  telemetry {
    unauthenticated_metrics_access = true
  }

  # When we move to multi-node HA, replace tls_disable=true with proper
  # client cert auth on a separate internal port (8201) for raft peers.
}

# api_addr / cluster_addr — used by leader-election and CLI redirects.
# In single-node mode they point at this node's WireGuard IP.
api_addr     = "http://10.42.0.40:8200"
cluster_addr = "http://10.42.0.40:8201"

# Disable mlock if running unprivileged. We DO grant IPC_LOCK via cap_add in
# the compose file, so leave this commented out — mlock keeps the encryption
# keys out of swap, which is the whole point on a shared VPS host.
# disable_mlock = true

# Telemetry — scraped by Prometheus on hara-stateless.
telemetry {
  prometheus_retention_time = "24h"
  disable_hostname = true
}
