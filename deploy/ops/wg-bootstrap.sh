#!/usr/bin/env bash
# wg-bootstrap.sh — establish the WireGuard mesh across the 6 Nevacloud VPSes.
#
# Cloud-init installs the wireguard package on each host (see
# deploy/ops/cloud-init.yaml) but cannot peer them — it doesn't know the
# other hosts' public keys at boot. This script closes that gap.
#
# Run ONCE from your operator laptop, after all 6 VPSes are provisioned and
# accept SSH at your hara user. Re-running is safe (idempotent — uses
# existing keys if they're already on the host).
#
# What it does, for each VPS:
#   1. SSH in, install wireguard-tools if not present.
#   2. Generate keypair at /etc/wireguard/{private,public}.key (chmod 600).
#   3. Collect the public key.
# After collecting all 6 public keys:
#   4. SSH back into each VPS and write /etc/wireguard/wg0.conf with peers
#      for every OTHER host.
#   5. systemctl enable + start wg-quick@wg0.
#   6. Verify mesh: each host can ping every other host's WG IP.
#
# IP plan (post-redesign 2026-05-27):
#   WG MESH lives on 10.43.0.0/24 — this is the cross-host service endpoint
#   space. Each host has ONE wg0 IP. Services on that host bind their ports
#   to this IP so other hosts can reach them via WG.
#
#   DOCKER BRIDGE (per host) stays on 10.42.0.0/24 — container-local only.
#   Containers within a host find each other via Docker DNS (unchanged).
#
#   Why split: prior plan put both on 10.42.0.0/24, causing kernel route
#   ambiguity (two interfaces claiming the same /24). Container outbound
#   randomly broke. See git log around 2026-05-27 for the diagnosis.
#
#   hara-v1         10.43.0.11
#   hara-v2         10.43.0.12
#   hara-v3         10.43.0.13
#   hara-v4         10.43.0.14
#   hara-stateless  10.43.0.20
#   hara-stateful   10.43.0.40
#
#   No more wg0 aliases needed — each cross-host service has a unique port
#   on the single wg0 IP (vault:8200, postgres:5432, redis:6379, minio:9000
#   all live on 10.43.0.40 with different ports).
#
# Required input: a hosts file mapping role → public IP, e.g.:
#   hara-v1=203.0.113.11
#   hara-v2=203.0.113.12
#   hara-v3=203.0.113.13
#   hara-v4=203.0.113.14
#   hara-stateful=203.0.113.40
#   hara-stateless=203.0.113.20

set -euo pipefail

HOSTS_FILE="${HOSTS_FILE:-./vps-hosts.env}"
SSH_USER="${SSH_USER:-hara}"
WG_PORT="${WG_PORT:-51820}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

[ -f "$HOSTS_FILE" ] \
  || die "HOSTS_FILE not found: $HOSTS_FILE. See header comment for format."

# Parse hosts file into bash assoc array.
declare -A HOSTS
while IFS='=' read -r role ip; do
  [[ -z "$role" || "$role" =~ ^# ]] && continue
  HOSTS["$role"]="$ip"
done < "$HOSTS_FILE"

# Role → mesh IP table (10.43.0.0/24 — see header for rationale)
declare -A MESH_IP=(
  [hara-v1]=10.43.0.11
  [hara-v2]=10.43.0.12
  [hara-v3]=10.43.0.13
  [hara-v4]=10.43.0.14
  [hara-stateless]=10.43.0.20
  [hara-stateful]=10.43.0.40
)

# Sanity: every role in hosts file must have a known mesh IP.
for role in "${!HOSTS[@]}"; do
  [[ -n "${MESH_IP[$role]:-}" ]] \
    || die "Unknown role in hosts file: $role. Valid roles: ${!MESH_IP[*]}"
done

# Sanity: every expected role must be in hosts file.
for role in "${!MESH_IP[@]}"; do
  [[ -n "${HOSTS[$role]:-}" ]] \
    || die "Missing role in hosts file: $role"
done

ssh_run() {
  local host="$1"; shift
  ssh -o StrictHostKeyChecking=accept-new "$SSH_USER@$host" "$@"
}

# ── Phase 1: generate keys on each VPS, collect public keys ─────────────────
declare -A PUBKEY
for role in "${!HOSTS[@]}"; do
  host="${HOSTS[$role]}"
  log "[$role @ $host] generating wireguard keys (if needed)"
  pubkey=$(ssh_run "$host" bash -s <<'REMOTE'
    set -e
    sudo apt-get -qq install -y wireguard-tools >/dev/null 2>&1 || true
    sudo install -m 700 -d /etc/wireguard
    if [ ! -f /etc/wireguard/private.key ]; then
      umask 077
      wg genkey | sudo tee /etc/wireguard/private.key > /dev/null
      sudo chmod 600 /etc/wireguard/private.key
      sudo sh -c 'wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key'
    fi
    sudo cat /etc/wireguard/public.key
REMOTE
  )
  PUBKEY["$role"]="$pubkey"
  ok "[$role] pubkey: ${pubkey:0:16}…"
done

# ── Phase 2: render wg0.conf on each VPS with peers for every OTHER host ────
for role in "${!HOSTS[@]}"; do
  host="${HOSTS[$role]}"
  mesh_ip="${MESH_IP[$role]}"

  log "[$role] writing /etc/wireguard/wg0.conf"

  # Build peer list (all roles EXCEPT this one).
  peers=""
  for other in "${!HOSTS[@]}"; do
    [ "$other" = "$role" ] && continue
    peers+="
[Peer]
# $other
PublicKey = ${PUBKEY[$other]}
AllowedIPs = ${MESH_IP[$other]}/32
Endpoint = ${HOSTS[$other]}:$WG_PORT
PersistentKeepalive = 25
"
  done

  # Post-redesign 2026-05-27: no more wg0 aliases. Each cross-host service
  # uses a unique port on the host's single wg0 IP.
  aliases=""

  ssh_run "$host" bash -s <<REMOTE
    set -e
    sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
[Interface]
# $role
Address = $mesh_ip/24
ListenPort = $WG_PORT
PrivateKey = \$(sudo cat /etc/wireguard/private.key)
SaveConfig = false$aliases
$peers
EOF
    sudo chmod 600 /etc/wireguard/wg0.conf
    sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
    sudo systemctl restart wg-quick@wg0
REMOTE
  ok "[$role] wg0 up at $mesh_ip"
done

# ── Phase 3: verify mesh (each host pings every other host's mesh IP) ───────
log "Verifying mesh connectivity"
fail=0
for src in "${!HOSTS[@]}"; do
  src_host="${HOSTS[$src]}"
  for dst in "${!HOSTS[@]}"; do
    [ "$src" = "$dst" ] && continue
    dst_ip="${MESH_IP[$dst]}"
    if ssh_run "$src_host" "ping -c1 -W2 $dst_ip" >/dev/null 2>&1; then
      printf '  ✓ %s → %s (%s)\n' "$src" "$dst" "$dst_ip" >&2
    else
      printf '  ✗ %s → %s (%s) FAILED\n' "$src" "$dst" "$dst_ip" >&2
      fail=$((fail + 1))
    fi
  done
done

[ "$fail" -eq 0 ] || die "$fail edges failed. Check WireGuard config + firewall (UDP $WG_PORT)" 3
ok "Mesh fully connected ($((6*5)) edges)"

echo
echo "Next step: create the Docker overlay network that uses the mesh."
echo "  On hara-stateful (where the secrets stack lives):"
echo "    docker network create --driver bridge \\"
echo "      --subnet 10.42.0.0/24 --gateway 10.42.0.1 hara-platform"
echo "  Then bring up secrets.yml, data, chain init, validators, stateless."
