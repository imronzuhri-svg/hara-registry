# Data recovery runbook

Restore procedures for every stateful store in the stack. All backups are
**age-encrypted before they leave the VPS** — decryption needs the private key
that lives only on the operator workstation (`~/.config/age/hara-backups.txt`,
created by `backup-setup.sh`). Without it, none of this works; treat that key
like the Vault unseal keys.

Bucket layout on Nevacloud S3 (rclone remote `nevacloud-s3`):

| Store | Bucket | Producer | Cadence |
|---|---|---|---|
| Postgres — logical dump | `hara-backups-postgres` | `snapshot-postgres.sh` | nightly 02:00 |
| Postgres — base backup | `hara-backups-postgres-base` | `snapshot-postgres-basebackup.sh` | nightly 01:30 |
| Postgres — WAL (PITR) | `hara-backups-postgres-wal` | `snapshot-postgres-wal.sh` | every 10 min |
| Redis | `hara-backups-redis` | `snapshot-redis.sh` | nightly 02:30 |
| MinIO | `hara-backups-minio` | `snapshot-minio.sh` | nightly 02:45 |
| Vault Raft | `hara-backups-vault` | `vault-raft-snapshot.sh` | nightly 04:00 |
| Validator chain data | `hara-backups-validator` | `snapshot-validator.sh` | nightly, staggered |

Install all the timers on `hara-stateful` with:

```bash
sudo ./deploy/ops/install-backup-timers.sh        # auto-detects the full data-tier suite
```

`age -d` shorthand used below:

```bash
DEC='age -d -i ~/.config/age/hara-backups.txt'
```

> ⚠️ **Volume / project names.** The restore steps below reference
> `hara-registry-data_*` (the post-rename project name in the compose file). The
> **live** stack still runs under the pre-rename project **`hara-ledger-data`**,
> so on the current production host the real volumes are
> `hara-ledger-data_postgres-data`, `hara-ledger-data_redis-data`, and
> `hara-ledger-minio_minio-data`. Substitute accordingly (or pass
> `-p hara-ledger-data` to `docker compose`) until the project is migrated.
> Verify with `docker volume ls` before any destructive restore step.

---

## Postgres — single database, fast (logical dump)

Use when you just need one DB back as-of last night (schema change gone wrong,
accidental `DELETE`, cross-version move). No PITR.

```bash
rclone copy nevacloud-s3:hara-backups-postgres/hara_indexer/ . --include '*.age'   # pick a file
$DEC < hara_indexer-2026-06-03.sql.zst.age | zstd -d \
  | docker exec -i hara-postgres psql -U hara -d hara_indexer
```

Verify with `deploy/ops/snapshot-restore-drill.sh` (round-trips a dump into a
throwaway container and checks row counts).

---

## Postgres — point-in-time recovery (PITR)

Use when you need the cluster restored to a **specific second** — e.g. "just
before the bad migration at 14:32". Combines the latest base backup before your
target time with the WAL archived since.

1. **Stop Postgres and clear the data dir.** On `hara-stateful`:

   ```bash
   docker compose -f deploy/data/docker-compose.yml stop postgres
   # back up the broken dir first, just in case
   sudo mv "$(docker volume inspect hara-registry-data_postgres-data -f '{{.Mountpoint}}')" /var/tmp/pgdata.broken
   ```

2. **Fetch + decrypt the most recent base backup taken _before_ your target time:**

   ```bash
   rclone copy nevacloud-s3:hara-backups-postgres-base/ ./base/ --include '*.age'
   mkdir -p restore/pgdata
   $DEC < base/base-20260603T013000Z.tar.zst.age | zstd -d | tar -xf - -C restore/pgdata
   ```

3. **Fetch + decrypt all WAL into a restore archive dir:**

   ```bash
   rclone copy nevacloud-s3:hara-backups-postgres-wal/ ./wal/ --include '*.age'
   mkdir -p restore/wal
   for f in wal/*.zst.age; do
     base=$(basename "$f"); seg=${base%.zst.age}
     $DEC < "$f" | zstd -d > "restore/wal/$seg"
   done
   ```

4. **Tell Postgres how to replay and where to stop.** In `restore/pgdata`:

   ```bash
   touch restore/pgdata/recovery.signal
   cat >> restore/pgdata/postgresql.auto.conf <<EOF
   restore_command = 'cp /wal-archive-restore/%f %p'
   recovery_target_time = '2026-06-03 14:31:55+00'
   recovery_target_action = 'promote'
   EOF
   ```

5. **Boot a one-off Postgres over the restored dir** (mount the WAL dir at the
   path `restore_command` expects), let it replay to the target, then promote.
   Copy the recovered data dir back into the `postgres-data` volume and start the
   compose service. (Recovery is deliberately a hands-on operation — do it on a
   scratch host first if the production window allows.)

**PITR window** = WAL remote retention, default **14 days**
(`PG_WAL_REMOTE_KEEP_DAYS`). Base backups are kept 21 days so a base older than
the window edge always exists.

**Verify the PITR path works** with `deploy/ops/pitr-restore-drill.sh` — it takes
a base backup, writes a sentinel into a throwaway database that exists only in
WAL, then restores base + replays archived WAL in a side container and asserts
the sentinel comes back. Run it after deploying the PITR compose and after any
Postgres upgrade. It never touches `hara_indexer` / `blockscout`.

---

## Redis

```bash
rclone copy nevacloud-s3:hara-backups-redis/ . --include 'redis-2026-06-03.rdb.zst.age'
$DEC < redis-2026-06-03.rdb.zst.age | zstd -d > dump.rdb

docker compose -f deploy/data/docker-compose.yml stop redis
VOL=$(docker volume inspect hara-registry-data_redis-data -f '{{.Mountpoint}}')
sudo cp dump.rdb "$VOL/dump.rdb" && sudo chown 999:1000 "$VOL/dump.rdb"   # redis:7-alpine uid
docker compose -f deploy/data/docker-compose.yml start redis              # loads dump.rdb on boot
```

The Streams queue (pending broadcasts) and caches come back as of the snapshot;
anything written after the last nightly RDB is lost — acceptable for a cache,
and the broadcaster re-derives queue state from chain + Postgres on restart.

---

## MinIO

```bash
rclone copy nevacloud-s3:hara-backups-minio/ . --include 'minio-2026-06-03.tar.zst.age'
$DEC < minio-2026-06-03.tar.zst.age | zstd -d | tar -tf - | head   # inspect first

docker compose -f deploy/data/docker-compose.minio.yml stop minio
VOL=$(docker volume inspect hara-registry-minio_minio-data -f '{{.Mountpoint}}')
$DEC < minio-2026-06-03.tar.zst.age | zstd -d | sudo tar -xf - -C "$(dirname "$VOL")"
docker compose -f deploy/data/docker-compose.minio.yml start minio
```

Restores both buckets (`hara-chain-config`, `hara-pq-anchors`). The PQ-anchor
blobs are the audit trail behind on-chain anchors and have no second copy —
this is the only path back if the data volume is lost.

---

## Vault Raft

See the header of `vault-raft-snapshot.sh`:

```bash
rclone copy nevacloud-s3:hara-backups-vault/ . --include 'vault-raft-<ts>.snap.age'
$DEC < vault-raft-<ts>.snap.age > vault-raft-<ts>.snap
scp vault-raft-<ts>.snap hara@hara-stateful:/tmp/
ssh hara@hara-stateful 'vault operator raft snapshot restore /tmp/vault-raft-<ts>.snap'
```

---

## Validator chain data

See the header of `snapshot-validator.sh`. In practice a single validator
resyncs from its peers faster than a restore; use the snapshot only if the chain
needs a cold start from a known-good height. Restore drill:
`validator-snapshot-restore-drill.sh`.

---

## What this does and does NOT give you

- **Gives:** off-host, encrypted, retention-managed backups of every store;
  Postgres recovery to any second in the last ~14 days; verified restore drills.
- **Does NOT give:** automatic failover. Every store here is single-instance —
  recovery is an operator running the steps above (RTO measured in minutes-to-an-
  hour, not seconds). Streaming replication / hot standby for Postgres and a
  Vault HA Raft cluster remain the next step up (see `PRODUCTION-READINESS.md`).
