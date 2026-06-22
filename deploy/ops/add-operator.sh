#!/usr/bin/env bash
# add-operator.sh — onboard a teammate to the fleet as a named sudo user.
#
# Creates a per-person account with THEIR ssh public key + passwordless sudo on
# each host. Named users (not a shared `hara` key, not root) give a per-person
# audit trail and clean one-command revocation (see remove-operator.sh).
#
# The teammate first runs deploy/ops/operator-keygen.{bat,sh} on their own laptop
# and sends you the PUBLIC key. You never need their private key.
#
# Usage:
#   add-operator.sh <username> <path-to-pubkey-file>
#   add-operator.sh <username> "ssh-ed25519 AAAA... label"
#
# Host scope (override the default with the HOSTS env var):
#   HOSTS="hara-v1 hara-v2" add-operator.sh alice alice.pub
#
# From Windows PowerShell, run via Git Bash:
#   & "C:\Program Files\Git\bin\bash.exe" deploy/ops/add-operator.sh alice alice.pub
#
# Idempotent: re-running appends the key only if absent and re-writes the sudoers
# drop-in; safe to run again to add a host.
set -euo pipefail

SSH_USER="${SSH_USER:-hara}"
# Default scope = the four validators (the usual "maintenance + settings" target).
# Add hara-rpc-1 / hara-stateless-2 / hara-stateful here or via $HOSTS if needed.
HOSTS="${HOSTS:-hara-v1 hara-v2 hara-v3 hara-v4}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

[ $# -eq 2 ] || die "usage: $0 <username> <pubkey-file | \"ssh-... key\">"
USERNAME="$1"
KEYARG="$2"

# Validate username: lowercase start, [a-z0-9_-], <=32 chars (adduser/NAME_REGEX safe).
[[ "$USERNAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] \
  || die "invalid username '$USERNAME' (use lowercase letters/digits/_/-, start with a letter)"

# Resolve the public key from a file path or an inline string.
if [ -f "$KEYARG" ]; then PUBKEY="$(tr -d '\r' < "$KEYARG" | grep -m1 -E '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)')" || true
else PUBKEY="$(printf '%s' "$KEYARG" | tr -d '\r')"; fi
[ -n "${PUBKEY:-}" ] || die "could not read a public key from: $KEYARG"
[[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)[[:space:]] ]] \
  || die "that does not look like an SSH PUBLIC key (must start with ssh-ed25519 / ssh-rsa / ecdsa-sha2-)"
case "$PUBKEY" in
  *PRIVATE*) die "that is a PRIVATE key — never paste a private key. Ask for the .pub line." ;;
esac
[[ "$PUBKEY" != *"'"* ]] || die "public key contains a single quote — refusing (unexpected format)"

log "Adding operator '$USERNAME' to: $HOSTS"
fail=0
for alias in $HOSTS; do
  log "[$alias] provisioning"
  if ssh -o StrictHostKeyChecking=accept-new "$SSH_USER@$alias" "sudo bash -s" <<REMOTE
set -e
u='$USERNAME'
id "\$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "\$u"
install -d -m 700 -o "\$u" -g "\$u" "/home/\$u/.ssh"
touch "/home/\$u/.ssh/authorized_keys"
grep -qxF '$PUBKEY' "/home/\$u/.ssh/authorized_keys" || echo '$PUBKEY' >> "/home/\$u/.ssh/authorized_keys"
chmod 600 "/home/\$u/.ssh/authorized_keys"
chown -R "\$u:\$u" "/home/\$u/.ssh"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "\$u" > "/etc/sudoers.d/\$u"
chmod 440 "/etc/sudoers.d/\$u"
visudo -cf "/etc/sudoers.d/\$u" >/dev/null
REMOTE
  then ok "[$alias] $USERNAME ready"; else printf '\033[1;31m✗ [%s] FAILED\033[0m\n' "$alias" >&2; fail=$((fail+1)); fi
done

echo >&2
[ "$fail" -eq 0 ] || die "$fail host(s) failed — fix before telling $USERNAME to connect."
ok "Done. Tell $USERNAME to: ssh $USERNAME@<host-public-ip>   (then 'sudo -i' for root tasks)"
ok "Revoke later with: remove-operator.sh $USERNAME"
