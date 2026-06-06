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
#   sudo ./deploy/ops/install-backup-timers.sh                    # auto-detect role(s)
#   sudo ./deploy/ops/install-backup-timers.sh vault              # force Vault timer
#   sudo ./deploy/ops/install-backup-timers.sh validator         # force validator timer
#   sudo ./deploy/ops/install-backup-timers.sh postgres          # (re)install PG dump timer
#   sudo ./deploy/ops/install-backup-timers.sh postgres-wal      # PITR WAL shipper
#   sudo ./deploy/ops/install-backup-timers.sh redis             # Redis RDB timer
#   sudo ./deploy/ops/install-backup-timers.sh minio             # MinIO volume timer
# Multiple roles in one call are fine:  ... install-backup-timers.sh redis minio
#
# Role auto-detect (from `hostname -s`):
#   hara-stateful  → the full data-tier suite — vault + postgres (logical dump) +
#                    postgres-basebackup + postgres-wal (PITR) + redis + minio.
#                    All the stateful data lives on this host, so all its backup
#                    timers install together.
#   hara-v1..v4    → validator (chain-data snapshot, staggered 03:00 + 15·idx)
#
# Schedule rationale: validators stagger 03:00/03:15/03:30/03:45 so only one
# validator is briefly stopped at a time (snapshot-validator.sh stops→archives→
# starts in ~30s; QBFT keeps quorum with 3 of 4). On hara-stateful the data jobs
# are staggered off-peak and non-overlapping: postgres-basebackup 01:30, postgres
# dump 02:00, redis 02:30, minio 02:45, vault 04:00 — and postgres-wal runs every
# 10 min continuously (it's a tiny incremental ship, not a heavy snapshot).
#
# Env (override as needed; sensible defaults below):
#   REPO        repo checkout on the host (auto-detected if unset)
#   ENV_FILE    EnvironmentFile for the snapshot scripts — must define
#               BACKUP_AGE_RECIPIENT (+ RCLONE_TARGET / VAULT_APPROLE_* as
#               applicable). Defaults to $REPO/deploy/ops/backup.env.
#   RUN_USER    user the timer runs as (default: hara)

set -euo pipefail

# Accept one or more roles; default to auto-detect from the hostname.
REQUESTED_ROLES=("$@")
[ ${#REQUESTED_ROLES[@]} -eq 0 ] && REQUESTED_ROLES=("auto")

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

# ── Resolve role(s) ──────────────────────────────────────────────────────────
# Expand "auto" into the concrete set of roles for this host. hara-stateful owns
# every stateful data store, so it gets the whole data-tier suite.
ROLES=()
for r in "${REQUESTED_ROLES[@]}"; do
  if [ "$r" = "auto" ]; then
    case "$HOST" in
      hara-stateful)
        ROLES+=(vault postgres postgres-basebackup postgres-wal redis minio drill) ;;
      hara-v[1-9]*)
        ROLES+=(validator) ;;
      *) echo "✗ cannot auto-detect role for host '$HOST' — pass vault|validator|postgres|postgres-wal|postgres-basebackup|redis|minio|drill"; exit 1 ;;
    esac
  else
    ROLES+=("$r")
  fi
done

[ "$(id -u)" = "0" ] || { echo "✗ run with sudo (writes /etc/systemd/system)"; exit 1; }

# Warn — but don't fail — if the env file is missing; the unit references it as
# optional (EnvironmentFile=-) so it can be dropped in before the first 0X:00 run.
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠ $ENV_FILE not present yet. Create it before the timer fires, e.g.:"
  echo "    BACKUP_AGE_RECIPIENT=age1...           # from backup-setup.sh"
  echo "    RCLONE_TARGET=nevacloud-s3:hara-backups-vault   # vault role"
  echo "    VAULT_APPROLE_ID=...  VAULT_APPROLE_SECRET=...   # vault role (vault-snapshot AppRole)"
fi

# Snapshot scripts run as $RUN_USER and write under /var/backups/hara — make sure
# it exists and is writable by that user (the validator snapshot silently failed
# nightly with "mkdir: /var/backups/hara: Permission denied" until this landed).
mkdir -p /var/backups/hara
chown "$RUN_USER":"$RUN_USER" /var/backups/hara
echo "▶ Ensured /var/backups/hara owned by $RUN_USER"

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

# install_role <role> — map a single role to its unit(s).
install_role() {
  local role="$1"
  case "$role" in
    vault)
      install_unit "hara-vault-snapshot" \
        "Nightly Vault Raft snapshot (age-encrypted, off-host)" \
        "*-*-* 04:00:00" \
        "$OPS/vault-raft-snapshot.sh"
      ;;

    validator)
      # Derive a stagger slot from the validator index in the hostname
      # (hara-v1 → 0, hara-v2 → 1, ...): 03:00, 03:15, 03:30, 03:45.
      local idx slot minute
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
        "Nightly Postgres logical dump (age-encrypted, off-host)" \
        "*-*-* 02:00:00" \
        "$OPS/snapshot-postgres.sh"
      ;;

    postgres-basebackup)
      install_unit "hara-postgres-basebackup-snapshot" \
        "Nightly Postgres physical base backup — PITR baseline (age-encrypted, off-host)" \
        "*-*-* 01:30:00" \
        "$OPS/snapshot-postgres-basebackup.sh"
      ;;

    postgres-wal)
      # Continuous WAL shipper — runs every 10 min, not nightly. Pairs with the
      # base backup to give point-in-time recovery. OnCalendar minute-stepping.
      install_unit "hara-postgres-wal-snapshot" \
        "Continuous Postgres WAL shipping — PITR (age-encrypted, off-host)" \
        "*-*-* *:00/10:00" \
        "$OPS/snapshot-postgres-wal.sh"
      ;;

    redis)
      install_unit "hara-redis-snapshot" \
        "Nightly Redis RDB snapshot (age-encrypted, off-host)" \
        "*-*-* 02:30:00" \
        "$OPS/snapshot-redis.sh"
      ;;

    minio)
      install_unit "hara-minio-snapshot" \
        "Nightly MinIO data snapshot (age-encrypted, off-host)" \
        "*-*-* 02:45:00" \
        "$OPS/snapshot-minio.sh"
      ;;

    drill)
      # Periodic RECOVERY TESTING — weekly, off-peak (after the nightly backups).
      # Runs all three drills; each writes its pass/fail to
      # /var/backups/hara/drills/*.json, which the console's Recovery panel reads.
      # Uses ';' so a failure in one still runs (and records) the others.
      #   pitr-restore-drill    — LOCAL base+WAL replay
      #   snapshot-restore-drill — LOCAL logical-dump restore
      #   s3-readback-check      — OFF-HOST: backups are GET-able + age-formatted + fresh
      install_unit "hara-drill-snapshot" \
        "Weekly recovery drills — PITR + logical-dump + S3-readback" \
        "Sun *-*-* 05:00:00" \
        "/bin/sh -c '$OPS/pitr-restore-drill.sh; $OPS/snapshot-restore-drill.sh; $OPS/s3-readback-check.sh'"
      ;;

    *)
      echo "✗ unknown role '$role' (expected vault|validator|postgres|postgres-basebackup|postgres-wal|redis|minio|drill)"; exit 1 ;;
  esac
}

for role in "${ROLES[@]}"; do
  install_role "$role"
done

echo
echo "Installed roles: ${ROLES[*]}"
echo "Verify:        systemctl list-timers 'hara-*-snapshot.timer'"
echo "Dry-run one:   sudo systemctl start hara-<role>-snapshot.service && journalctl -u hara-<role>-snapshot.service -n 40 --no-pager"
