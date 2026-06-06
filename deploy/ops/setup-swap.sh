#!/usr/bin/env bash
# setup-swap.sh — add a swapfile as an OOM backstop on a host.
#
# WHY: the fleet runs no swap. On the memory-tight hosts (validators at 8GB, the
# RPC host running 3 co-located Besu JVMs) a transient heap/allocation spike has
# no cushion → the kernel OOM-kills a container instead of swapping. This adds a
# small swapfile with LOW swappiness (10) so swap is a backstop under pressure,
# NOT a path the kernel uses for routine paging (which would add latency).
#
# Idempotent — safe to re-run (skips if the swapfile is already active).
#
# Usage (on the host):  sudo ./setup-swap.sh
#   or remotely:        ssh <host> 'sudo bash -s' < setup-swap.sh
# Env: SWAP_SIZE (default 8G), SWAP_FILE (default /swapfile), SWAPPINESS (default 10).

set -euo pipefail

SWAP_SIZE="${SWAP_SIZE:-8G}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAPPINESS="${SWAPPINESS:-10}"

if swapon --show 2>/dev/null | grep -q "${SWAP_FILE}"; then
  echo "▶ $(hostname): ${SWAP_FILE} already active — leaving as-is"
else
  echo "▶ $(hostname): creating ${SWAP_SIZE} swap at ${SWAP_FILE}"
  # fallocate is instant; fall back to dd if the FS doesn't support it.
  fallocate -l "${SWAP_SIZE}" "${SWAP_FILE}" 2>/dev/null \
    || dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="$(( ${SWAP_SIZE%G} * 1024 ))" status=none
  chmod 600 "${SWAP_FILE}"
  mkswap "${SWAP_FILE}" >/dev/null
  swapon "${SWAP_FILE}"
fi

# Persist across reboots.
grep -q "^${SWAP_FILE}[[:space:]]" /etc/fstab || echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab

# Backstop, not active paging.
echo "vm.swappiness=${SWAPPINESS}" > /etc/sysctl.d/99-hara-swap.conf
sysctl -q "vm.swappiness=${SWAPPINESS}"

echo "  $(free -h | awk '/Swap:/{print "swap total "$2}')  swappiness=$(cat /proc/sys/vm/swappiness)"
