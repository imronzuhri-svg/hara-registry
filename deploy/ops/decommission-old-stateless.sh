#!/usr/bin/env bash
# Phase E — decommission the OLD hara-stateless host. Run from the operator laptop.
#
# HARD GATE: must NOT run until hara-did has migrated off 10.43.0.20 onto
# hara-rpc-1 (10.43.0.21). This script refuses to proceed unless:
#   (a) the did-stg WG peer shows a recent handshake on hara-rpc-1 (partner is
#       actually talking to the new RPC host), AND
#   (b) you pass --confirm (you've gotten explicit "we're on .21" from the partner).
#
# Even then it is staged: `prep` is reversible (stops containers, leaves the VPS);
# `demesh` removes the .20 peer everywhere; the actual VPS destroy is left to you
# in the Nevacloud panel (intentionally manual — it's the point of no return).
set -euo pipefail

OLD=hara-stateless
OLD_MESH=10.43.0.20
DID_PUBKEY="5uSW/IIHCynsjdFbrbmXgbvJfCpqCib4z75TJwK1hy4="
MESH_HOSTS=(hara-v1 hara-v2 hara-v3 hara-v4 hara-stateful hara-rpc-1 hara-stateless-2)

confirm=0; [ "${2:-}" = "--confirm" ] && confirm=1

partner_ready() {
  # did-stg has a recent (<300s) handshake with hara-rpc-1 => partner is on .21
  local hs now age
  hs=$(ssh -o BatchMode=yes hara-rpc-1 "sudo wg show wg0 latest-handshakes | grep -F '$DID_PUBKEY' | awk '{print \$2}'")
  [ -n "$hs" ] && [ "$hs" -gt 0 ] || return 1
  now=$(ssh -o BatchMode=yes hara-rpc-1 'date +%s'); age=$((now - hs))
  echo "  did-stg↔hara-rpc-1 last handshake: ${age}s ago"
  [ "$age" -lt 300 ]
}

case "${1:-}" in
  check)
    echo "▶ Partner-readiness gate:"
    if partner_ready; then echo "✓ partner appears migrated to hara-rpc-1"; else
      echo "✗ NOT ready — did-stg has no recent handshake with hara-rpc-1. Do NOT decommission."; fi
    ;;

  prep)   # reversible: stop the old stack (RPC + leftovers), keep the VPS + WG
    partner_ready || { echo "✗ partner not on .21 yet — aborting (would break hara-did)"; exit 1; }
    [ "$confirm" = 1 ] || { echo "✗ pass --confirm once the partner has confirmed cutover"; exit 1; }
    echo "▶ Stopping ALL containers on $OLD…"
    ssh "$OLD" 'docker ps -q | xargs -r docker stop'
    echo "✓ old stack stopped. VPS + WG still intact (reversible). Next: demesh"
    ;;

  demesh) # remove the .20 peer from every remaining host
    partner_ready || { echo "✗ partner not on .21 yet — aborting"; exit 1; }
    [ "$confirm" = 1 ] || { echo "✗ pass --confirm"; exit 1; }
    for h in "${MESH_HOSTS[@]}"; do
      echo "▶ [$h] removing peer $OLD_MESH"
      ssh "$h" "sudo bash -c '
        cp /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak.\$(date +%s)
        awk -v drop=\"$OLD_MESH/32\" '\''
          /^\[Peer\]/{blk=\"\"; inpeer=1}
          inpeer{blk=blk\$0 ORS; if(\$0 ~ drop){skip=1}; if(\$0==\"\"){if(!skip)printf \"%s\",blk; blk=\"\"; inpeer=0; skip=0; next} next}
          {print}
          END{if(inpeer && !skip)printf \"%s\",blk}
        '\'' /etc/wireguard/wg0.conf > /etc/wireguard/wg0.conf.new && mv /etc/wireguard/wg0.conf.new /etc/wireguard/wg0.conf
        wg syncconf wg0 <(wg-quick strip /etc/wireguard/wg0.conf)'"
    done
    echo "✓ .20 peer removed everywhere. FINAL STEP (manual): destroy the VPS in the Nevacloud panel, then raise DNS TTL back to 3600s."
    ;;

  *) echo "usage: $0 {check | prep --confirm | demesh --confirm}"; exit 2;;
esac
