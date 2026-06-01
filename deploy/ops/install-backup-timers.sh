#!/usr/bin/env bash
# install-backup-timers.sh — install the systemd service+timer units that drive
# the nightly snapshot scripts. Role-aware and idempotent: re-running it just
# rewrites the units and re-enables the timer.
#
# This rounds out state-4 §8 / §17.2: Postgres backups are already automated;
# this wires the two remaining timers — Vault Raft (on hara-stateful) and the
# validator chain-data snapshots (one per validator, STAGGERED so the chain
# never loses quorum).
#
# Run it ON the host being set up (it needs sudo to write /etc/systemd/system):
#   sudo ./deploy/ops/install-backup-timers.sh                 # auto-detect role
#   sudo ./deploy/ops/install-backup-timers.sh vault           # force Vault timer
#   sudo ./deploy/ops/install-backup-timers.sh validator       # force validator timer
#   sudo ./deploy/ops/install-backup-timers.sh postgres        # (re)install PG timer
#
# Role auto-detect (from `hostname -s`):
#   hara-stateful  → vault     (Vault Raft snapshot, 04:00)
#   hara-v1..v4    → validator (chain-data snapshot, staggered 03:00 + 15·idx)
#
# Schedule rationale: validators stagger 03:00/03:15/03:30/03:45 so only one
# validator is briefly stopped at a time (snapshot-validator.sh stops→archives→
# starts in ~30s; QBFT keeps quorum with 3 of 4). Postgres runs 02:00, Vault
# 04:00 — all off-peak, none overlapping.
#
# Env (override as needed; sensible defaults below):
#   REPO        repo checkout on the host (auto-detected if unset)
#   ENV_FILE    EnvironmentFile for the snapshot scripts — must define
#               BACKUP_AGE_RECIPIENT (+ RCLONE_TARGET / VAULT_APPROLE_* as
#               applicable). Defaults to $REPO/deploy/ops/backup.env.
#   RUN_USER    user the timer runs as (default: hara)

set -euo pipefail

ROLE="${1:-auto}"

# ── Resolve repo checkout ────────────────────────────────────────────────────
# state-4 §16: on-host dir is still /opt/hara/hara-ledger pending the deferred
# rename to /opt/hara-registry. Detect whichever exists.
if [ -z "${REPO:-}" ]; then
  for c in /opt/hara-registry /opt/hara/hara-registry /opt/hara/hara-ledger; do
    [ -d "$c/deploy/ops" ] && { REPO="$c"; break; }
  done
fi
: "${REPO:?could not locate repo checkout — set REPO=/path/to/hara-registry}"
OPS="$REPO/deploy/ops"
[ -d "$OPS" ] || { echo "✗ $OPS not found"; exit 1; }

RUN_USER="${RUN_USER:-hara}"
ENV_FILE="${ENV_FILE:-$OPS/backup.env}"
HOST=$(hostname -s)

# ── Resolve role ─────────────────────────────────────────────────────────────
if [ "$ROLE" = "auto" ]; then
  case "$HOST" in
    hara-stateful)  ROLE="vault" ;;
    hara-v[1-9]*)   ROLE="validator" ;;
    *) echo "✗ cannot auto-detect role for host '$HOST' — pass vault|validator|postgres"; exit 1 ;;
  esac
fi

[ "$(id -u)" = "0" ] || { echo "✗ run with sudo (writes /etc/systemd/system)"; exit 1; }

# Warn — but don't fail — if the env file is missing; the unit references it as
# optional (EnvironmentFile=-) so it can be dropped in before the first 0X:00 run.
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠ $ENV_FILE not present yet. Create it before the timer fires, e.g.:"
  echo "    BACKUP_AGE_RECIPIENT=age1...           # from backup-setup.sh"
  echo "    RCLONE_TARGET=nevacloud-s3:hara-backups-vault   # vault role"
  echo "    VAULT_APPROLE_ID=...  VAULT_APPROLE_SECRET=...   # vault role (vault-snapshot AppRole)"
fi

# install_unit <name> <description> <oncalendar> <exec>
install_unit() {
  local name="$1" desc="$2" oncal="$3" exec_cmd="$4"
  echo "▶ Installing ${name}.{service,timer} (OnCalendar=$oncal, runs: $exec_cmd)"

  cat > "/etc/systemd/system/${name}.service" <<EOF
[Unit]
Description=$desc
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO
EnvironmentFile=-$ENV_FILE
ExecStart=$exec_cmd
EOF

  cat > "/etc/systemd/system/${name}.timer" <<EOF
[Unit]
Description=Schedule $desc

[Timer]
OnCalendar=$oncal
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${name}.timer"
  echo "✓ ${name}.timer enabled"
}

case "$ROLE" in
  vault)
    install_unit "hara-vault-snapshot" \
      "Nightly Vault Raft snapshot (age-encrypted, off-host)" \
      "*-*-* 04:00:00" \
      "$OPS/vault-raft-snapshot.sh"
    ;;

  validator)
    # Derive a stagger slot from the validator index in the hostname
    # (hara-v1 → 0, hara-v2 → 1, ...): 03:00, 03:15, 03:30, 03:45.
    idx="${HOST##*hara-v}"
    case "$idx" in
      ''|*[!0-9]*) echo "✗ cannot parse validator index from '$HOST'"; exit 1 ;;
    esac
    slot=$(( (idx - 1) % 4 ))
    minute=$(( slot * 15 ))
    install_unit "hara-validator-snapshot" \
      "Nightly validator chain-data snapshot (age-encrypted, off-host)" \
      "$(printf '*-*-* 03:%02d:00' "$minute")" \
      "$OPS/snapshot-validator.sh"
    ;;

  postgres)
    install_unit "hara-postgres-snapshot" \
      "Nightly Postgres backup (age-encrypted, off-host)" \
      "*-*-* 02:00:00" \
      "$OPS/snapshot-postgres.sh"
    ;;

  *)
    echo "✗ unknown role '$ROLE' (expected vault|validator|postgres)"; exit 1 ;;
esac

echo
echo "Verify:        systemctl list-timers 'hara-*-snapshot.timer'"
echo "Dry-run now:   sudo systemctl start hara-${ROLE}-snapshot.service && journalctl -u hara-${ROLE}-snapshot.service -n 40 --no-pager"
