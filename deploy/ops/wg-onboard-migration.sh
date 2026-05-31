#!/usr/bin/env bash
# One-shot full-mesh onboarding for the RPC-host migration: adds hara-rpc-1
# (10.43.0.21) and hara-stateless-2 (10.43.0.25) into the existing WG mesh as
# full peers of every other host. We control both new boxes, so this does BOTH
# sides (configures the new boxes AND adds them as peers everywhere).
#
# Safe + idempotent:
#   - private keys never leave the box (only public keys are collected)
#   - existing hosts updated with `wg syncconf` (delta apply; never drops the
#     interface or existing peers — safe for validators)
#   - re-runnable: skips hosts that already know a peer
set -euo pipefail

SSH_USER="${SSH_USER:-hara}"
WG_PORT="${WG_PORT:-51820}"

# alias:mesh_ip:public_ip  — the full target mesh (9 hosts during parallel run)
ALL_HOSTS=(
  "hara-v1:10.43.0.11:202.155.18.234"
  "hara-v2:10.43.0.12:103.169.206.46"
  "hara-v3:10.43.0.13:103.169.206.127"
  "hara-v4:10.43.0.14:160.19.166.23"
  "hara-stateless:10.43.0.20:202.155.91.66"
  "hara-stateful:10.43.0.40:103.67.244.250"
  # NOTE: hara-did-stg (10.43.0.50) is the PARTNER's box — we have no SSH there.
  # Its peering with hara-rpc-1 is handled separately via a partner onboarding
  # packet (they add us; we add their pubkey on hara-rpc-1 when they reply).
  "hara-rpc-1:10.43.0.21:103.169.206.237"
  "hara-stateless-2:10.43.0.25:103.169.206.239"
)
NEW_HOSTS=(
  "hara-rpc-1:10.43.0.21:103.169.206.237"
  "hara-stateless-2:10.43.0.25:103.169.206.239"
)

log(){ printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
ssh_h(){ ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_USER@$1" "$2"; }

is_new(){ for n in "${NEW_HOSTS[@]}"; do [ "${n%%:*}" = "$1" ] && return 0; done; return 1; }

peer_block(){ # alias mesh_ip public_ip pubkey
  printf '\n[Peer]\n# %s\nPublicKey = %s\nAllowedIPs = %s/32\nEndpoint = %s:%s\nPersistentKeepalive = 25\n' \
    "$1" "$4" "$2" "$3" "$WG_PORT"
}

# ── 1. ensure keypair exists on each NEW box ──────────────────────────────────
log "Ensuring WG keypairs on new boxes"
for entry in "${NEW_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  ssh_h "$alias" "sudo install -m700 -d /etc/wireguard; \
    test -f /etc/wireguard/private.key || sudo sh -c 'umask 077 && wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key'; \
    sudo chmod 600 /etc/wireguard/private.key"
  ok "[$alias] keypair present"
done

# ── 2. collect every host's public key ────────────────────────────────────────
log "Collecting public keys from all ${#ALL_HOSTS[@]} hosts"
declare -A PUB
for entry in "${ALL_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  PUB[$alias]=$(ssh_h "$alias" "sudo cat /etc/wireguard/public.key")
  [ -n "${PUB[$alias]}" ] || { echo "FAILED to read pubkey on $alias"; exit 1; }
  ok "[$alias] ${PUB[$alias]:0:16}…"
done

# ── 3. write full wg0.conf on each NEW box (peers = all others) ───────────────
log "Writing wg0.conf on new boxes"
for entry in "${NEW_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  peers_file="/tmp/peers-$alias.conf"
  : > "$peers_file"
  for o in "${ALL_HOSTS[@]}"; do
    IFS=: read -r oa om op <<<"$o"
    [ "$oa" = "$alias" ] && continue
    peer_block "$oa" "$om" "$op" "${PUB[$oa]}" >> "$peers_file"
  done
  scp -q -o BatchMode=yes "$peers_file" "$SSH_USER@$alias:/tmp/peers.conf"
  ssh_h "$alias" "sudo bash -c '
    umask 077
    { printf \"[Interface]\n# $alias\nAddress = $mip/24\nListenPort = $WG_PORT\nPrivateKey = %s\nSaveConfig = false\n\" \"\$(cat /etc/wireguard/private.key)\"
      cat /tmp/peers.conf
    } > /etc/wireguard/wg0.conf
    chmod 600 /etc/wireguard/wg0.conf
    rm -f /tmp/peers.conf'"
  rm -f "$peers_file"
  ok "[$alias] wg0.conf written ($((${#ALL_HOSTS[@]}-1)) peers)"
done

# ── 4. add the 2 new peers to every EXISTING host (idempotent, syncconf) ──────
log "Adding new peers to existing hosts"
for entry in "${ALL_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  is_new "$alias" && continue
  for n in "${NEW_HOSTS[@]}"; do
    IFS=: read -r na nm np <<<"$n"
    if ssh_h "$alias" "sudo wg show wg0 peers 2>/dev/null | grep -qF '${PUB[$na]}'"; then
      ok "[$alias] already knows $na"
      continue
    fi
    peer_block "$na" "$nm" "$np" "${PUB[$na]}" | ssh_h "$alias" "sudo tee -a /etc/wireguard/wg0.conf >/dev/null"
    ssh_h "$alias" "sudo bash -c 'wg syncconf wg0 <(wg-quick strip /etc/wireguard/wg0.conf)'"
    ok "[$alias] + $na"
  done
done

# ── 5. bring up wg on the new boxes ───────────────────────────────────────────
log "Starting wg-quick on new boxes"
for entry in "${NEW_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  ssh_h "$alias" "sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1; sudo systemctl restart wg-quick@wg0"
  ok "[$alias] wg0 up"
done

# ── 6. verify mesh reachability from the new boxes ────────────────────────────
log "Verifying mesh connectivity (give keepalives a moment)"
sleep 8
for entry in "${NEW_HOSTS[@]}"; do
  IFS=: read -r alias mip pip <<<"$entry"
  echo "  from $alias:"
  for o in "${ALL_HOSTS[@]}"; do
    IFS=: read -r oa om op <<<"$o"
    [ "$oa" = "$alias" ] && continue
    res=$(ssh_h "$alias" "ping -c1 -W2 $om >/dev/null 2>&1 && echo ok || echo FAIL")
    printf "    %-18s %s  %s\n" "$oa" "$om" "$res"
  done
done
ok "WG onboarding complete"
