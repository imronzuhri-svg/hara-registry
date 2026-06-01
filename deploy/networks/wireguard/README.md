# WireGuard mesh for cross-VPS networking

Every production VPS joins a full WireGuard mesh. WireGuard handles
authentication + encryption and gives each host a stable IP on the
**`10.43.0.0/24`** mesh. There is **no Docker Swarm / overlay** — each host runs
its own `docker compose`, and services reach off-host dependencies by the peer's
**mesh IP** (not by container DNS, which is per-host only).

## Two subnets — what's what

| Subnet | Purpose | Where it lives |
|---|---|---|
| `10.43.0.0/24` | WireGuard mesh — physical-host IPs; the path for **all cross-host** traffic | Per-VPS `wg0` interface |
| `10.42.0.0/24` | Docker bridge `hara-platform` — container DNS (`vault:8200`, `rpc-write:8545`, …) | **Local to each host** (per-host bridge, NOT shared) |

Containers don't see the WireGuard subnet directly; the host does. Same-host
containers talk by service name on the `10.42.0.0/24` bridge; cross-host they
talk over the `10.43.0.0/24` mesh IPs. The two `10.42.0.x` bridges on different
hosts are independent — a container on host A cannot resolve a container on host
B by name (that's why cross-host config uses mesh IPs).

## Current mesh members

| Host | Mesh IP | Role |
|---|---|---|
| `hara-v1`..`hara-v4` | `10.43.0.11`–`14` | Besu QBFT validators |
| `hara-rpc-1` | `10.43.0.21` | RPC tier (rpc-write + 2× rpc-read + HAProxy) |
| `hara-stateless-2` | `10.43.0.25` | services + observability + edge (Caddy) |
| `hara-stateful` | `10.43.0.40` | Vault / Postgres / Redis / MinIO |
| `hara-did-stg` (partner) | `10.43.0.50` | hara-did (peered, not our SSH) |

## Per-host config

Each VPS gets a `/etc/wireguard/wg0.conf`:

```ini
[Interface]
PrivateKey = <generated per host>
Address    = 10.43.0.X/24       # X = this host's octet from the table above
ListenPort = 51820

[Peer]
PublicKey  = <peer's public key>
AllowedIPs = 10.43.0.Y/32       # Y = that peer's octet
Endpoint   = <peer's public IP>:51820
PersistentKeepalive = 25

# ... one [Peer] block per other host (full mesh)
```

## Tooling (don't hand-render in prod)

The repo automates all of the above — prefer these over manual edits:

- `deploy/ops/wg-bootstrap.sh` — generate keys + render every host's `wg0.conf` for the initial mesh.
- `deploy/ops/wg-add-peer.sh` — add one new peer to every existing host (used when onboarding a VPS).
- `deploy/ops/wg-onboard-migration.sh` — the onboarding flow used to add `hara-rpc-1` + `hara-stateless-2` during the RPC-host split.

Manual key-gen, for reference:

```bash
# On each VPS:
sudo wg genkey | sudo tee /etc/wireguard/privatekey | wg pubkey | sudo tee /etc/wireguard/publickey
sudo chmod 600 /etc/wireguard/privatekey

# Bring the interface up:
sudo systemctl enable --now wg-quick@wg0
sudo wg show    # every peer should show a handshake within the last ~2 minutes
```

## Security notes

- Limit WireGuard's UDP `51820` via ufw to the other peer IPs only — see `deploy/ops/cloud-init.yaml`.
- ⚠ **ufw does not filter Docker's published ports** — Docker writes its own iptables rules that bypass ufw. ufw guards host-level ports (SSH, WG); container port exposure is controlled in the compose `ports:` and by binding to `127.0.0.1`/the mesh IP rather than `0.0.0.0`.
- The mesh has no central control plane; adding a host means re-rendering every peer's `wg0.conf` with the new entry (`wg-add-peer.sh` does this).
- For 10+ VPS, consider Tailscale / Headscale (centrally-managed WireGuard).
