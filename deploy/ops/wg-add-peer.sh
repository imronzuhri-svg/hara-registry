#!/usr/bin/env bash
# wg-add-peer.sh — incrementally add a new WireGuard peer to the HaraLedger
# mesh, without rebuilding the whole mesh (vs wg-bootstrap.sh which is a
# full reset).
#
# Two-phase onboarding to avoid race conditions:
#
#   $ wg-add-peer.sh prepare hara-did-stg 10.43.0.50
#     → prints an onboarding packet to send to the new peer's operator.
#       Includes our 5 hosts' public keys, public IPs, and the wg0.conf
#       template they fill in. They generate their keypair, share their
#       public key back.
#
#   $ wg-add-peer.sh finalize hara-did-stg 10.43.0.50 103.169.206.116 <PUBKEY>
#     → adds the new peer as [Peer] on all 5 existing hosts, reloads
#       wg-quick. Verifies each host knows the new peer. The new peer
#       can then start their wg-quick@wg0 and pings start working.
#
# Re-running finalize with the same args is idempotent (skips hosts that
# already know the peer, based on grep match on pubkey).

set -euo pipefail

# ─── Constants ──────────────────────────────────────────────────────────────
SSH_USER="${SSH_USER:-hara}"
WG_PORT="${WG_PORT:-51820}"

# Existing hosts in the mesh — keep in sync with wg-bootstrap.sh's MESH_IP.
# Format: "ssh-alias:mesh-ip:role-label"
# Post-migration topology: the old single hara-stateless (10.43.0.20) was split
# into hara-rpc-1 (RPC tier + HAProxy, .21) and hara-stateless-2 (services +
# observability + edge, .25). A new peer MUST be added to .21 to reach the chain RPC.
declare -a EXISTING_HOSTS=(
  "hara-v1:10.43.0.11:hara-v1 (validator)"
  "hara-v2:10.43.0.12:hara-v2 (validator)"
  "hara-v3:10.43.0.13:hara-v3 (validator)"
  "hara-v4:10.43.0.14:hara-v4 (validator)"
  "hara-rpc-1:10.43.0.21:hara-rpc-1 (RPC tier + HAProxy)"
  "hara-stateless-2:10.43.0.25:hara-stateless-2 (services + observability + edge)"
  "hara-stateful:10.43.0.40:hara-stateful (Vault, Postgres, Redis, MinIO)"
)

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  cat >&2 <<USAGE
Usage:
  $0 prepare  <new-peer-name>  <new-peer-mesh-ip>
  $0 finalize <new-peer-name>  <new-peer-mesh-ip>  <new-peer-public-ip>  <new-peer-pubkey>

Examples:
  $0 prepare hara-did-stg 10.43.0.50
  $0 finalize hara-did-stg 10.43.0.50 103.169.206.116 AbCdEf...XyZ=
USAGE
  exit 2
}

[ $# -ge 1 ] || usage
CMD="$1"; shift

case "$CMD" in
  # ──────────────────────────────────────────────────────────────────────────
  prepare)
    [ $# -eq 2 ] || usage
    NEW_NAME="$1"
    NEW_MESH_IP="$2"

    # Sanity: new mesh IP must be in 10.43.0.0/24 and not collide with existing
    [[ "$NEW_MESH_IP" =~ ^10\.43\.0\.[0-9]+$ ]] \
      || die "Mesh IP must be in 10.43.0.0/24 (got: $NEW_MESH_IP)"
    for entry in "${EXISTING_HOSTS[@]}"; do
      IFS=':' read -r _ existing_ip _ <<< "$entry"
      [ "$existing_ip" = "$NEW_MESH_IP" ] \
        && die "Mesh IP $NEW_MESH_IP already used by an existing host"
    done

    cat <<HEADER
════════════════════════════════════════════════════════════════
 WG peer onboarding packet for: $NEW_NAME  (mesh IP $NEW_MESH_IP)
════════════════════════════════════════════════════════════════

Send this to the operator of $NEW_NAME. Public keys & IPs below are
public information — secure channel not required, but secure channel
also fine.

HEADER

    # Phase 1: collect existing hosts' public keys + public IPs
    PEER_BLOCKS=""
    log "Collecting public keys + public IPs from $((${#EXISTING_HOSTS[@]})) existing hosts" >&2
    for entry in "${EXISTING_HOSTS[@]}"; do
      IFS=':' read -r alias mesh_ip label <<< "$entry"
      pub=$(ssh -o StrictHostKeyChecking=accept-new "$SSH_USER@$alias" \
              'sudo cat /etc/wireguard/public.key' 2>/dev/null) \
        || die "Failed to read /etc/wireguard/public.key on $alias"
      pub_ip=$(ssh "$SSH_USER@$alias" 'curl -fsS ifconfig.me' 2>/dev/null) \
        || die "Failed to fetch public IP for $alias"

      PEER_BLOCKS+="
[Peer]
# $label
PublicKey = $pub
AllowedIPs = $mesh_ip/32
Endpoint = $pub_ip:$WG_PORT
PersistentKeepalive = 25
"
      ok "  collected $alias: pub=${pub:0:16}… ip=$pub_ip" >&2
    done

    cat <<INSTRUCTIONS

────────────────────────────────────────────────────────────────
On $NEW_NAME, as root:
────────────────────────────────────────────────────────────────

# 1. Install + generate your keypair
sudo apt-get update -qq && sudo apt-get install -y wireguard-tools
sudo install -m 700 -d /etc/wireguard
sudo sh -c 'umask 077 && wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key'
sudo chmod 600 /etc/wireguard/private.key

# 2. Reply with the output of:
sudo cat /etc/wireguard/public.key

# 3. Write wg0.conf below. Replace <PRIVKEY> with your private key.
#    DO NOT start wg-quick yet — wait until we confirm we've added you
#    as a peer on our 5 hosts.

sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
[Interface]
# $NEW_NAME
Address = $NEW_MESH_IP/24
ListenPort = $WG_PORT
PrivateKey = <PASTE_YOUR_PRIVATE_KEY_HERE>
SaveConfig = false
$PEER_BLOCKS
EOF

sudo chmod 600 /etc/wireguard/wg0.conf

# 4. After we confirm finalize, start the interface:
sudo systemctl enable --now wg-quick@wg0

# 5. Verify mesh connectivity:
ping -c3 10.43.0.21   # hara-rpc-1 (chain RPC tier)
ping -c3 10.43.0.40   # hara-stateful (Vault, Postgres)

────────────────────────────────────────────────────────────────
END
────────────────────────────────────────────────────────────────
INSTRUCTIONS
    ;;

  # ──────────────────────────────────────────────────────────────────────────
  finalize)
    [ $# -eq 4 ] || usage
    NEW_NAME="$1"
    NEW_MESH_IP="$2"
    NEW_PUB_IP="$3"
    NEW_PUBKEY="$4"

    [[ "$NEW_MESH_IP" =~ ^10\.43\.0\.[0-9]+$ ]] \
      || die "Mesh IP must be in 10.43.0.0/24 (got: $NEW_MESH_IP)"
    [[ "$NEW_PUBKEY" =~ ^[A-Za-z0-9+/]{42,44}=?$ ]] \
      || die "PublicKey doesn't look like a WireGuard pubkey (expected base64-ish 44-char string)"

    log "Adding peer '$NEW_NAME' ($NEW_MESH_IP, endpoint $NEW_PUB_IP:$WG_PORT, pubkey ${NEW_PUBKEY:0:16}…) to ${#EXISTING_HOSTS[@]} existing hosts"

    PEER_BLOCK="
[Peer]
# $NEW_NAME
PublicKey = $NEW_PUBKEY
AllowedIPs = $NEW_MESH_IP/32
Endpoint = $NEW_PUB_IP:$WG_PORT
PersistentKeepalive = 25
"

    for entry in "${EXISTING_HOSTS[@]}"; do
      IFS=':' read -r alias mesh_ip label <<< "$entry"

      # Check if already known (idempotent)
      already=$(ssh "$SSH_USER@$alias" "sudo wg show wg0 peers 2>/dev/null | grep -F '$NEW_PUBKEY' || true")
      if [ -n "$already" ]; then
        ok "[$alias] already knows $NEW_NAME, skipping"
        continue
      fi

      log "[$alias] appending peer block + reloading wg0"
      ssh "$SSH_USER@$alias" "sudo tee -a /etc/wireguard/wg0.conf > /dev/null" <<<"$PEER_BLOCK"
      # systemctl reload doesn't always work for wg-quick; use a full restart
      # via wg syncconf to avoid dropping existing peers
      ssh "$SSH_USER@$alias" "sudo bash -c 'wg syncconf wg0 <(wg-quick strip /etc/wireguard/wg0.conf)' 2>/dev/null \
        || sudo systemctl restart wg-quick@wg0"
      ok "[$alias] done"
    done

    log "Verifying all hosts know about $NEW_NAME"
    fail=0
    for entry in "${EXISTING_HOSTS[@]}"; do
      IFS=':' read -r alias _ _ <<< "$entry"
      if ssh "$SSH_USER@$alias" "sudo wg show wg0 peers | grep -qF '$NEW_PUBKEY'"; then
        ok "  [$alias] peer present"
      else
        printf '  \033[1;31m✗\033[0m [%s] peer MISSING\n' "$alias" >&2
        fail=$((fail+1))
      fi
    done

    [ "$fail" -eq 0 ] || die "$fail hosts failed to add the peer. Investigate before telling $NEW_NAME to start wg-quick."

    ok ""
    ok "All ${#EXISTING_HOSTS[@]} hosts now know about $NEW_NAME."
    ok ""
    ok "Tell them they can now:"
    ok "  sudo systemctl enable --now wg-quick@wg0"
    ok "  ping -c3 10.43.0.21  # should reply within ~1-50ms"
    ;;

  # ──────────────────────────────────────────────────────────────────────────
  *)
    usage
    ;;
esac
