# Deployment runbook — database backup & recovery

**Goal:** turn on the backup/recovery work from PR #33 on the production data
host. After this runbook, `hara-stateful` has Postgres point-in-time recovery
(WAL archiving + base backups) plus nightly off-host backups of Redis and MinIO,
all age-encrypted, with a passing restore drill.

This document is **self-contained** — a deployable session (or an operator with
host access) can execute it top to bottom without prior context. Companion docs:
`deploy/ops/RECOVERY.md` (how to restore) and GitHub issue #34 (acceptance
checklist).

> ⚠️ This was authored and merged without ever running against live containers.
> It is syntax-validated only. Treat this first deployment as the validation —
> do it in a maintenance window, follow the rollback section if anything looks
> wrong, and do not consider the backups trustworthy until step 6 (the drill)
> passes and step 7 (one clean nightly cycle) is observed.

---

## 0. Where to run this

| Item | Value |
|---|---|
| Host | `hara-stateful` (data + secrets plane) |
| Repo checkout | `/opt/hara-registry` or `/opt/hara/hara-ledger` (whichever exists) |
| Run as | `hara` user (has passwordless sudo per cloud-init) |
| Touches | the `hara-postgres`, `hara-redis`, `hara-minio` containers |

Everything below is run **on `hara-stateful`** unless it explicitly says
"operator workstation". The `age` private key that decrypts backups lives ONLY
on the operator workstation — the host never needs it for *taking* backups, only
for *restoring*.

> ℹ️ **Compose project names.** As of the 2026-06-03 migration the live stacks
> run under the project names the compose files declare — **`hara-registry-data`**
> (postgres + redis; volumes `hara-registry-data_postgres-data`,
> `hara-registry-data_redis-data`, `hara-registry-data_postgres-wal-archive`) and
> **`hara-registry-minio`** (volume `hara-registry-minio_minio-data`). Run the
> `docker compose` commands below **without** `-p` — the file's `name:` field
> already resolves to the right project. (History: the stacks originally ran as
> `hara-ledger-data` / `hara-ledger-minio`; they were migrated by stopping each
> project, copying every named volume to its `hara-registry-*` counterpart, and
> bringing the stack back up under the new name. If you ever see `hara-ledger-*`
> volumes lingering, they are the pre-migration originals and can be removed once
> you've confirmed the new ones are healthy.)

---

## 1. Pre-flight — do not skip

Confirm every one of these BEFORE touching the running stack. A missing
prerequisite turns a clean deploy into a half-configured one.

```bash
cd /opt/hara-registry 2>/dev/null || cd /opt/hara/hara-ledger
git checkout main && git pull          # get the merged PR #33 code

# 1a. Tools present on the host
for t in docker age zstd rclone; do command -v "$t" >/dev/null && echo "✓ $t" || echo "✗ MISSING: $t"; done

# 1b. The data containers are currently up and healthy
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'hara-postgres|hara-redis|hara-minio'

# 1c. backup.env exists and defines the age recipient
test -f deploy/ops/backup.env && grep -q '^BACKUP_AGE_RECIPIENT=age1' deploy/ops/backup.env \
  && echo "✓ backup.env has BACKUP_AGE_RECIPIENT" || echo "✗ create deploy/ops/backup.env (see backup-setup.sh)"

# 1d. rclone remote 'nevacloud-s3' is configured (off-host upload target)
rclone listremotes | grep -q '^nevacloud-s3:' && echo "✓ nevacloud-s3 remote" || echo "✗ configure rclone nevacloud-s3 remote"

# 1e. Free disk on the data volume — WAL + base backups need headroom
df -h /var/lib/docker /var/backups 2>/dev/null
```

**If `backup.env` or the rclone remote is missing:** the timers will still run
but encrypt **locally only** (no off-host copy). Fix these first; off-host is the
whole point.

**Maintenance window:** step 2 recreates the `hara-postgres` container, which is
a brief restart (writes hang a few seconds; the chain keeps producing blocks via
the validators). Pick a low-traffic moment.

---

## 2. Deploy the PITR compose changes

The merged compose adds `archive_mode=on`, an `archive_command`, an
`archive_timeout`, a `postgres-wal-archive` volume, and a one-shot
`postgres-archive-init` sidecar that makes that volume writable by the postgres
user (uid 70). Without the sidecar, `archive_command` fails on every segment and
`pg_wal` grows until the disk fills — so confirm it ran.

```bash
docker compose -f deploy/data/docker-compose.yml --env-file deploy/data/.env up -d

# The init sidecar should have run once and exited 0:
docker logs hara-postgres-archive-init     # expect: ✓ /wal-archive ready (owner uid 70)

# Postgres should be healthy again:
docker ps --format '{{.Names}}\t{{.Status}}' | grep hara-postgres
```

---

## 3. Verify archiving is actually working

This is the single most important check — a silently-failing `archive_command`
is the classic way to fill a disk and take Postgres down.

# Note: pass `-d hara_indexer`. There is no database named after the `hara`
# role, so a bare `psql -U hara` fails with `database "hara" does not exist`.
```bash
docker exec hara-postgres psql -U hara -d hara_indexer -tAc "show archive_mode"      # -> on
docker exec hara-postgres psql -U hara -d hara_indexer -tAc "show archive_command"   # -> test ! -f /wal-archive/%f && cp %p /wal-archive/%f
docker exec hara-postgres psql -U hara -d hara_indexer -tAc "show archive_timeout"   # -> 5min

# Force a segment switch, then confirm it archived with zero failures:
docker exec hara-postgres psql -U hara -d hara_indexer -c "select pg_switch_wal()"
sleep 5
docker exec hara-postgres psql -U hara -d hara_indexer -tAc \
  "select last_archived_wal, last_archived_time, failed_count from pg_stat_archiver"
```

✅ Pass = `failed_count` is `0` and `last_archived_wal` is populated and recent.
❌ If `failed_count` climbs, **stop** — see Troubleshooting → "archive_command
failing" before the disk fills.

---

## 4. Install the backup timers

`install-backup-timers.sh` auto-detects `hara-stateful` and installs the full
data-tier suite: vault, postgres (logical dump), postgres-basebackup,
postgres-wal, redis, minio. It is idempotent — safe to re-run.

```bash
sudo ./deploy/ops/install-backup-timers.sh
systemctl list-timers 'hara-*-snapshot.timer'
```

> Note: role auto-detect reads `hostname -s`. On hara-stateful that currently
> returns `localhost` (known issue), so auto-detect errors out. Pass the roles
> explicitly until the hostname is fixed:
> ```bash
> sudo ./deploy/ops/install-backup-timers.sh vault postgres postgres-basebackup postgres-wal redis minio
> ```

Expect six timers. Schedule: basebackup 01:30, postgres dump 02:00, redis 02:30,
minio 02:45, vault 04:00, and postgres-wal every 10 min.

---

## 5. Dry-run each job and confirm an object lands off-host

Don't wait for the overnight schedule — fire each one now and watch it succeed
AND land an object in its bucket.

```bash
for svc in postgres-basebackup postgres-wal redis minio; do
  echo "=== $svc ==="
  sudo systemctl start "hara-${svc}-snapshot.service"
  journalctl -u "hara-${svc}-snapshot.service" -n 15 --no-pager
done

# Confirm objects exist in each bucket:
for b in postgres-base postgres-wal redis minio; do
  echo "=== nevacloud-s3:hara-backups-$b ==="; rclone lsf "nevacloud-s3:hara-backups-$b/" | head
done
```

✅ Pass = each service logs `✓ ... complete` and each bucket lists at least one
`.age` object.

---

## 6. Prove recovery works (the drill)

Backups you can't restore are not backups. This drill takes a base backup,
writes a sentinel that exists only in WAL, then restores base + replays WAL in a
throwaway container and checks the sentinel came back. It's isolated from
`hara_indexer`/`blockscout` and self-cleans.

```bash
./deploy/ops/pitr-restore-drill.sh        # expect: ✓ POSTGRES PITR DRILL PASSED
```

If it fails, the WAL→restore path is broken even though backups are landing —
investigate before relying on PITR. (Logical-dump restore is still validated
separately by `snapshot-restore-drill.sh`.)

---

## 7. Post-deploy watch (next morning)

```bash
# Fresh objects from the overnight run in every bucket:
for b in postgres postgres-base postgres-wal redis minio vault; do
  echo "=== $b ==="; rclone lsf "nevacloud-s3:hara-backups-$b/" | tail -3
done

# Archiver still healthy after a full day of traffic (catches slow disk-fill):
docker exec hara-postgres psql -U hara -tAc "select failed_count from pg_stat_archiver"   # -> 0

# WAL archive dir isn't growing unbounded (shipper prunes shipped segments >48h):
docker exec hara-postgres sh -c 'ls -1 /wal-archive | wc -l'
```

Tick the boxes in **issue #34** as you go. Acceptance = drill green + one clean
nightly cycle + `failed_count` still 0.

---

## 8. Rollback

If step 2 or 3 goes wrong and you need Postgres back to its pre-PITR behaviour
quickly:

```bash
# Disable archiving at runtime WITHOUT a restart (stops any disk-fill immediately):
docker exec hara-postgres psql -U hara -c "alter system set archive_mode = off"
# archive_mode needs a restart to fully take effect; archive_command can be neutered live:
docker exec hara-postgres psql -U hara -c "alter system set archive_command = '/bin/true'"
docker exec hara-postgres psql -U hara -c "select pg_reload_conf()"

# To fully revert the compose change, check out the parent of the PITR merge and re-up:
git revert --no-edit 19e878f        # the squash-merge of PR #33  (or: git checkout <pre-PR sha> -- deploy/data/docker-compose.yml)
docker compose -f deploy/data/docker-compose.yml --env-file deploy/data/.env up -d

# Stop/disable the timers if needed:
for t in postgres-basebackup postgres-wal redis minio; do
  sudo systemctl disable --now "hara-${t}-snapshot.timer"
done
```

The `postgres-wal-archive` volume and any backups already uploaded are harmless
to leave in place.

---

## 9. Troubleshooting

**`archive_command failing` / `failed_count` climbing**
- Most likely the WAL-archive volume isn't writable by uid 70. Confirm the init
  sidecar ran: `docker logs hara-postgres-archive-init`. Re-run it:
  `docker compose -f deploy/data/docker-compose.yml up -d postgres-archive-init`.
- Check the dir inside the container: `docker exec hara-postgres ls -ld /wal-archive`
  (should be owned by `postgres`/70, mode 700).

**`pg_wal` growing / disk filling**
- Archiving is failing (see above) — Postgres retains WAL it can't archive. Fix
  the archive path; once `archive_command` succeeds, Postgres recycles WAL.

**WAL shipper uploads nothing**
- `backup.env` missing `BACKUP_AGE_RECIPIENT`, or `nevacloud-s3` remote not
  configured → it runs local-only. Check `journalctl -u hara-postgres-wal-snapshot`.

**Nevacloud S3 rejects large objects (HTML error)**
- The scripts already force 16 MiB multipart chunks. If a custom bucket/endpoint
  still rejects, lower `--s3-chunk-size` in the relevant `snapshot-*.sh`.

**`pitr-restore-drill.sh` hangs at "Waiting for recovery to promote"**
- The drill couldn't fetch a WAL segment from the archive. Confirm step 3 passes
  and that `/wal-archive` actually contains segments before re-running.

---

## 10. Out of scope

This is **backup/recovery, not failover.** Every store here is single-instance;
recovery is an operator running `RECOVERY.md`. The next step up — Postgres
streaming replication / hot standby and Vault HA Raft for automatic failover —
is tracked separately and not part of this runbook.
