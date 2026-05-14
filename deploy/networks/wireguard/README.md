# WireGuard mesh for cross-VPS overlay

5 VPS (P1a) → 5 peer entries in a full mesh. WireGuard handles authentication, encryption, and gives every host a stable IP on the `10.42.255.0/24` admin network.

## Why two subnets?

| Subnet | Purpose | Where it lives |
|---|---|---|
| `10.42.0.0/24` | Docker container DNS (`vault:8200`, `validator1:30303`, …) | Docker Swarm overlay |
| `10.42.255.0/24` | WireGuard mesh — actual physical-host IPs | Per-VPS WireGuard interface |

Containers don't see the WireGuard subnet. Hosts use WireGuard. The Swarm overlay uses the WireGuard tunnels as transport.

## Per-host config

Each VPS gets a `/etc/wireguard/wg0.conf`:

```ini
[Interface]
PrivateKey = <generated per host>
Address = 10.42.255.X/24      # X = 1..5
ListenPort = 51820

[Peer]
PublicKey = <peer 1's public key>
AllowedIPs = 10.42.255.1/32
Endpoint = <peer 1's public IP>:51820
PersistentKeepalive = 25

[Peer]
PublicKey = <peer 2's public key>
AllowedIPs = 10.42.255.2/32
Endpoint = <peer 2's public IP>:51820
PersistentKeepalive = 25

# ... 3 more peers for a 5-VPS mesh
```

## Generate keys + render configs

```bash
# On each VPS:
sudo wg genkey | sudo tee /etc/wireguard/privatekey | wg pubkey | sudo tee /etc/wireguard/publickey
sudo chmod 600 /etc/wireguard/privatekey

# Collect all 5 public keys, then render each host's wg0.conf from the template
# above with the right peer set.

# Start:
sudo systemctl enable --now wg-quick@wg0
sudo wg show    # should list 4 peers, all "handshake within last 2 minutes"
```

## After WireGuard is up

```bash
# Init Docker Swarm on hara-app (or whichever you nominate as manager)
docker swarm init --advertise-addr 10.42.255.1

# Note the join token, then on each other VPS:
docker swarm join --token <token> 10.42.255.1:2377

# Create the overlay network (run once on the manager)
docker network create --driver overlay --attachable \
  --subnet 10.42.0.0/24 hara-platform
```

Now every host can see every other host's containers by name. The `deploy/*/docker-compose.yml` files all declare `hara-platform` as `external: true` and Just Work.

## Security note

- Limit WireGuard's UDP/51820 port via UFW to the other 4 peer IPs only — see cloud-init.yaml.
- The mesh has no central control plane; if you add a 6th VPS, you regenerate everyone's wg0.conf with the new peer entry.
- For 10+ VPS, switch to Tailscale or Headscale (centrally-managed WireGuard).
