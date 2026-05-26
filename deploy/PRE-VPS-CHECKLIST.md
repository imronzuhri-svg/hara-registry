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

Decide which domain serves the 3 public hostnames:

- `rpc.<domain>`        → JSON-RPC + WS
- `explorer.<domain>`   → Blockscout
- `grafana.<domain>`    → Grafana

Default in repo: `haratrust.io`. If you use a different domain, change three places:

- `deploy/edge/Caddyfile` — three site blocks
- `deploy/PRE-VPS-CHECKLIST.md` — this file (for clarity)
- `deploy/nevacloud-runbook.md` §3 (DNS records table)

Create A records pointing at the **hara-stateless** public IP *before*
bringing up `deploy/edge/`. Caddy will hang at "obtaining certificate"
otherwise (Let's Encrypt HTTP-01 needs port 80 reachable + correct DNS).

If you want to test the full flow without burning prod LE rate limits,
uncomment the `acme_ca` staging line in the Caddyfile global block.

---

#### 3. Backup destination — RECOMMENDED before day-2

`deploy/ops/vault-raft-snapshot.sh`, `deploy/ops/snapshot-postgres.sh`,
and `deploy/ops/snapshot-validator.sh` all upload nightly via cron.
The runbook lists ~Rp 300K/mo Nevacloud object storage but the bucket
and credentials don't exist yet. Decide now or backups silently fail.

Either:
- provision a Nevacloud object-storage bucket + service account, OR
- use the MinIO instance on `hara-stateful` itself (cheaper but not
  off-host; loses backups if hara-stateful is the failure).

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
