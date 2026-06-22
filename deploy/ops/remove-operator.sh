#!/usr/bin/env bash
# remove-operator.sh — offboard a teammate added with add-operator.sh.
#
# Deletes the named account (and home) and its sudoers drop-in on each host,
# killing any live sessions first. Single-command revocation of all access.
#
# Usage:
#   remove-operator.sh <username>
#   HOSTS="hara-v1 hara-v2" remove-operator.sh alice      # scope override
#
# From Windows PowerShell, run via Git Bash:
#   & "C:\Program Files\Git\bin\bash.exe" deploy/ops/remove-operator.sh alice
#
# Use the SAME HOSTS scope you used to add them (default = the four validators).
set -euo pipefail

SSH_USER="${SSH_USER:-hara}"
HOSTS="${HOSTS:-hara-v1 hara-v2 hara-v3 hara-v4}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

[ $# -eq 1 ] || die "usage: $0 <username>"
USERNAME="$1"
[[ "$USERNAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "invalid username '$USERNAME'"
# Guard against nuking the fleet's own service account.
[ "$USERNAME" != "$SSH_USER" ] || die "refusing to remove the login user '$SSH_USER'"
[ "$USERNAME" != "root" ] || die "refusing to remove root"

log "Removing operator '$USERNAME' from: $HOSTS"
fail=0
for alias in $HOSTS; do
  log "[$alias] removing"
  if ssh "$SSH_USER@$alias" "sudo bash -s" <<REMOTE
set -e
u='$USERNAME'
rm -f "/etc/sudoers.d/\$u"
if id "\$u" >/dev/null 2>&1; then
  pkill -KILL -u "\$u" 2>/dev/null || true
  deluser --remove-home "\$u" >/dev/null 2>&1 || userdel -r -f "\$u" >/dev/null 2>&1 || true
fi
id "\$u" >/dev/null 2>&1 && { echo "still present"; exit 1; } || true
REMOTE
  then ok "[$alias] $USERNAME removed"; else printf '\033[1;31m✗ [%s] FAILED\033[0m\n' "$alias" >&2; fail=$((fail+1)); fi
done

echo >&2
[ "$fail" -eq 0 ] || die "$fail host(s) failed — verify manually."
ok "Done. $USERNAME has no access on: $HOSTS"
