# Hara Registry — Production Readiness Sign-off

**Date:** 2026-06-01
**Verdict:** ✅ **GO** — cleared for production.
**System:** Hara Registry (formerly HaraLedger) — permissioned Hyperledger Besu QBFT
chain (chain ID **131216**, 2s blocks, gas price 0) for palm-oil traceability +
post-quantum anchoring. Live on Nevacloud across 7 VPSes over a WireGuard mesh.

This is a **go-live with documented follow-ups** posture: every irreplaceable
asset is protected and verified; the open items below are deliberate, recorded
hardening — not unknowns.

---

## Topology (production)

| Host | Role | WG IP | Public |
|---|---|---|---|
| hara-rpc-1 | dedicated RPC tier (rpc-write + 2×rpc-read + HAProxy LB + autoheal) | 10.43.0.21 | 103.169.206.237 (RPC only) |
| hara-stateless-2 | services + obs + edge (signer, broadcaster, indexer, rpc-cache, Blockscout, Prom/Graf/Loki/Tempo/AM, Caddy) | 10.43.0.25 | 103.169.206.239 (DNS target) |
| hara-stateful | Vault Raft + Postgres + Redis + MinIO | 10.43.0.40 | — |
| hara-v1..v4 | Besu QBFT validators | 10.43.0.11–14 | — |

**Public endpoints (kept on `*.ledger.haratrust.io`):**
`rpc.` (read/write/ws) · `explorer.` (Blockscout) · `grafana.platform.` ·
`trace.` (traceability DAG viewer, basic-auth gated).

> Note: code/repo/image identity is `hara-registry`; running prod images and
> on-host `/opt/hara/hara-ledger` paths remain until a deferred maintenance-window
> rebuild. Public domains intentionally unchanged.

---

## Verified production-grade

- **Consensus:** 4-validator QBFT, ≥3/4 quorum maintained; 2s blocks.
- **RPC reliability:** real `eth_blockNumber` healthcheck + willfarrell/autoheal;
  `--sync-mode=FULL` pinned (avoids the snap-sync state-heal window where
  `eth_call`/`eth_getCode` silently return empty); rpc-cache null-receipt fix live.
- **Throughput:** 200×500 stress run validated end-to-end — **99,800 transfer
  events, 361 TPS, 400/400 `status=0x1`**, receipts (≈6.4M gas/executeChain, 499
  logs each) + custody batches confirmed in the trace viewer.
- **Partner:** hara-did integrated and migrated to `10.43.0.21`.
- **Backups (critical data):** Postgres (indexer + Blockscout) — automated nightly
  (systemd timer 02:00 on hara-stateful), **age-encrypted**, uploaded **off-host**
  to Nevacloud S3 (`nevacloud-s3:hara-backups/postgres`), and **restore drill
  PASSED** (709k events round-tripped). Postgres is the only store with no
  self-heal path; validators resync from peers.
- **Supply chain / CI:** CodeQL, Gitleaks (secret scan), Slither, Echidna fuzzing,
  contract `forge build+test`, per-service build+scan+sign. **Branch protection**
  on `main` (PR + 1 approval, linear history, no force-push/deletions; required
  checks: Gitleaks + CodeQL; admins may bypass).
- **Admin:** anvil-0 dev key rotated out; platform admin
  `0x944b237…329` (DEFAULT_ADMIN_ROLE).
- **Secrets:** inventoried in `ops/secrets.txt` (gitignored).
- **Reproducibility:** repo configs reconciled to the live split topology.

---

## Accepted post-launch follow-ups (tracked, non-blocking)

| # | Item | Note |
|---|---|---|
| 1 | Rotate Vault root token + GitHub PAT; move `secrets.txt` to a password manager | both passed through an operator session 2026-06-01 |
| 2 | Harden new boxes: enable `ufw` + disable SSH root/password login | deferred during migration to avoid lockout |
| 3 | Admin multisig (Gnosis Safe) | replace single-key master admin |
| 4 | Real alerting | Alertmanager → Slack/PagerDuty/email (currently stdout via alert-sink) |
| 5 | Backups round-out | Vault Raft snapshot (use a dedicated snapshotter token, not root) + validator snapshots |
| 6 | Validator RAM 8→16 GB; prod image rebuild under `hara-registry-*` | maintenance-window items |

---

*Signed off by: operations. Re-evaluate the follow-ups within the first
maintenance window post-launch.*
