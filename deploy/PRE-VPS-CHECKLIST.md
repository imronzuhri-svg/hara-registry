### Pre-VPS purchase checklist

Three operator decisions must be made before the first VPS is paid for.
Everything else has been verified by the local dry-run gates (A–F + D).

---

#### 1. SSH key — REQUIRED

`deploy/ops/cloud-init.yaml` ships with a placeholder:

```yaml
ssh_authorized_keys:
  - ssh-ed25519 AAAA... ops@hara
```

Replace it with your real key(s) **before** uploading userdata to Nevacloud.
Multiple keys are fine — repeat the `- ssh-...` line. If you lose this step
you cannot reach the box.

If you want cloud-init to pull keys from GitHub instead (auto-syncs as your
team adds members), replace the block with:

```yaml
ssh_import_id:
  - gh:<your-github-username>
  - gh:<teammate-github-username>
```

---

#### 2. Domain — REQUIRED before bringing up Caddy

Three public hostnames are served from `hara-stateless`:

- `rpc.ledger.haratrust.io`        → JSON-RPC + WS (read/write/ws split per Caddyfile)
- `explorer.ledger.haratrust.io`   → Blockscout
- `grafana.platform.haratrust.io`  → Grafana

The split is deliberate: `ledger.*` is chain-specific (rpc, explorer);
`platform.*` is cross-cutting infra (Grafana observes the ledger today,
will observe hara-did and other products later). Keeps URLs honest as
the platform grows. If you use a different domain, change three places:

- `deploy/edge/Caddyfile` — three site blocks
- `deploy/PRE-VPS-CHECKLIST.md` — this file (for clarity)
- `deploy/nevacloud-runbook.md` §3 (DNS records table)

Create A records pointing at the **hara-stateless** public IP *before*
bringing up `deploy/edge/`. Caddy will hang at "obtaining certificate"
otherwise (Let's Encrypt HTTP-01 needs port 80 reachable + correct DNS).

If you want to test the full flow without burning prod LE rate limits,
uncomment the `acme_ca` staging line in the Caddyfile global block.

---

#### 3. Backup destination — REQUIRED before day-2

**Decision: Nevacloud Object Storage + age-encryption.** Cheap (~Rp 300K/mo),
S3-compatible, in-region (fast snapshots), keeps data in Indonesia, and
every snapshot is encrypted to an age recipient *before* leaving the VPS so
the provider only ever sees ciphertext.

Three things to do before going live:

1. **Provision a Nevacloud Object Storage bucket** + service-account key.
   In the Nevacloud panel: Object Storage → Create bucket → grab access key
   + secret key.

2. **Generate the age keypair on your operator workstation** (laptop, not VPS):
   ```bash
   ./deploy/ops/backup-setup.sh
   ```
   This writes `~/.config/age/hara-backups.txt` (the private key — back this
   up to 1Password/Bitwarden the same way you back up Vault unseal keys) and
   prints the `age1…` recipient string.

3. **On each VPS** add to the env that the snapshot cron sources:
   ```
   BACKUP_AGE_RECIPIENT=age1…           # from step 2
   ```
   Snapshot scripts refuse to start without it.

Restore is operator-side (the only host that has the private key):
```bash
rclone copy nevacloud-s3:hara-backups-postgres/hara_indexer/<file>.age .
age -d -i ~/.config/age/hara-backups.txt < <file>.sql.zst.age | zstd -d | psql …
```

**Do NOT** use local MinIO as the backup destination — it lives on
hara-stateful, the same VPS as the things being backed up. Defeats the
point. The MinIO instance is for the `hara-pq-anchors` audit bucket only.

---

### Things you do **not** need to decide pre-purchase

- **Registry / image pulls:** all 6 service images are public on
  `ghcr.io/imronzuhri-svg/hara-ledger-*` and pull anonymously. Set
  `IMAGE_REGISTRY=ghcr.io/imronzuhri-svg/` in each VPS's `.env`.
- **Secrets:** `deploy/ops/secrets-bootstrap.sh init` generates all
  passwords + tokens. Run once on the operator workstation, scp
  per-role `.env` files to each VPS.
- **WireGuard mesh:** `deploy/ops/wg-bootstrap.sh` is dry-run-tested
  on 6 alpine containers; 30/30 mesh edges connect.
- **Vault init:** `deploy/ops/vault-raft-init.sh` + `vault-approle-bootstrap.sh`
  are dry-run-tested; all 3 AppRoles bind correctly.
- **Cloud-init schema:** validated against Ubuntu 24.04 cloud-init.

### Known follow-up (not blocking first boot)

- `hara-ledger-node` (Besu validator) and `hara-alert-sink` are not yet
  built in CI. Each VPS will `docker compose build` them locally on
  first boot (~2 min each). A CI extension to push these to GHCR is
  tracked as a follow-up task.
