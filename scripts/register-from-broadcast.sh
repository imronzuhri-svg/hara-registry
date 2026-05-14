#!/usr/bin/env bash
# register-from-broadcast.sh — parse a forge broadcast file and register
# every CREATE'd contract into watched_contracts via register-watched.sh.
#
# Usage:
#   ./scripts/register-from-broadcast.sh contracts/broadcast/Deploy.s.sol/131216/run-latest.json
#
# Requires: jq.
#
# Filed alongside register-watched.sh during 2026-05-14 fix for hardcoded
# migration-3 addresses. Reads addresses from the source of truth (forge's
# own broadcast log) instead of guessing.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <path-to-run-latest.json>" >&2
  exit 1
fi

BROADCAST="$1"
[ -f "$BROADCAST" ] || { echo "✗ $BROADCAST not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "✗ jq required" >&2; exit 1; }

# Pull every CREATE transaction's (contractName, contractAddress) pair.
# `tr -d '\r'` strips Windows CRLF from broadcast files generated on Windows
# hosts — jq preserves them and the resulting hidden CR breaks downstream
# regex validation in register-watched.sh.
mapfile -t pairs < <(
  jq -r '
    .transactions[]
    | select(.transactionType == "CREATE")
    | select(.contractName != null and .contractAddress != null)
    | "\(.contractName)=\(.contractAddress)"
  ' "$BROADCAST" | tr -d '\r'
)

if [ "${#pairs[@]}" -eq 0 ]; then
  echo "(no CREATE transactions found in $BROADCAST — nothing to register)"
  exit 0
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/register-watched.sh" "${pairs[@]}"
