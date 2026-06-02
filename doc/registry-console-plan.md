# HARA Registry Console — Plan & Feature Spec ("Strata Console")

> **Status:** proposal (2026-06-02). A unified web console for operating,
> governing, and monitoring Hara Registry — replacing today's SSH + `deploy/ops/*.sh`
> + scattered dashboards with one branded control plane.
> **Codename:** *Strata Console* (after the "Strata" mark — concentric rings =
> layers of verified truth).

---

## 0. Is it possible? — Yes.

Everything the console needs is already exposed by the running stack; today we
just drive it by hand. The console is an aggregation + orchestration layer over
interfaces that already exist:

| Capability | Already-available interface it wraps |
|---|---|
| Monitoring / metrics | Prometheus (`:9090`), Grafana (embed), Loki, Tempo |
| Alerts | Alertmanager (`:9093`) + alert-sink |
| Chain state / governance | Besu JSON-RPC (`eth`, `qbft`, `txpool`, `debug`, `trace`) via HAProxy |
| RPC tier health | HAProxy stats (`:8404/stats`) |
| Traceability data | indexer Postgres + trace-api (`/v1/*`) |
| Contract roles / registry | the 7 system contracts (OZ AccessControl) |
| Secrets / signing | Vault (Raft, AppRole, optionally Transit) |
| Backups / DR | the `hara-*-snapshot` systemd timers + rclone/age |
| Explorer | Blockscout (`/api/v2`) |

So this is **integration + a safe control plane**, not green-field infra. The
hard part isn't "can we" — it's doing the *write/governance* paths **safely**
(see §5 Security).

---

## 1. Vision

One authenticated, brand-consistent place where an operator can:

- **See everything** — chain, validators, RPC, services, backups, alerts — on a single pane of glass.
- **Do the privileged things** — grant/revoke roles, fund accounts, onboard partners, manage validators, register contracts — through guarded, audited workflows instead of raw keys + shell scripts.
- **Never handle a raw admin key in a browser** — signing is brokered through Vault / a multisig; the console proposes, the secure layer signs.

---

## 2. Feature set (by domain)

### 2.1 Dashboard — "single pane of glass"
- Chain header: chain ID 131216, latest block, block time, TPS (rolling), finality.
- QBFT validator strip: 4 validators, up/down, peer count, sync state, last-proposed block, RAM headroom.
- RPC tier: HAProxy backend health (rpc-write + 2× rpc-read), req/s, error rate, rpc-cache hit ratio.
- Services health: signer, broadcaster, indexer (lag vs chain head), anchor-worker, Blockscout.
- **Account watchlist with zero-balance warnings** (the gotcha that bit hara-xchange) — flags any deployer/admin/partner account sitting at 0 balance *before* it silently drops txs.
- Backups: last Postgres / Vault-Raft / validator snapshot time, next run, off-host upload status, age of newest off-host copy.
- Vault seal status (sealed/unsealed, # of key shares entered).
- Live alert feed (from Alertmanager) with severity + runbook links.

### 2.2 Governance & roles
- Matrix view: every contract × every role × current holders (read live from on-chain `AccessControl` events).
  - HaraPalmOil `MINTER_ROLE`; PQAnchorRegistry `ANCHOR_ROLE` / `KEY_ROTATOR_ROLE`; ContractRegistry `REGISTRAR_ROLE`; GovernanceContract; `DEFAULT_ADMIN_ROLE`.
- **Grant / revoke** with the *grant → use → revoke* pattern built in (replaces `minter-role.sh`).
- All grants routed through the secure signer (§5) and written to the audit log.
- Admin-key actions require multisig approval once Gnosis Safe lands (§17.3 open item).

### 2.3 Treasury & account funding
- Fund any address from a managed funder (solves the zero-balance skip in one click; legacy tx, gasPrice 0).
- Funder balance + spend history; low-balance alerts on the funder itself.
- Bulk-fund on partner onboarding.

### 2.4 Validator management
- View validators (QBFT) + their hosts, specs, RAM, sync, peers.
- **Add / remove validator** via QBFT voting (`qbft_proposeValidatorVote` / `qbft_discardValidatorVote`) — with the safety guard that quorum (3 of 4) is never broken; the console enforces "one at a time."
- Trigger a validator chain-data snapshot; rolling restart with quorum guard.
- RAM-resize checklist (the 8→16 GB open item) as a guided runbook.

### 2.5 Contract registry & deployments
- Browse the ContractRegistry (name → address), register new entries (`REGISTRAR_ROLE`).
- Deployment history (from `contracts/broadcast/.../131216`).
- Verify-on-Blockscout helper.

### 2.6 Partner onboarding (e.g. hara-xchange, hara-did)
- One flow: generate a dedicated deployer keypair → store private key in Vault → **fund it** → optionally grant roles / register → produce a partner deploy guide pre-filled with their address.
- This is exactly the hara-xchange flow we just did by hand, turned into a wizard (and it would have pre-funded the deployer, avoiding the 24-min hang).

### 2.7 Backups & DR
- Timer status board (all `hara-*-snapshot` units across hosts).
- Trigger an on-demand snapshot; one-click **restore drill**; show last drill result.
- Off-host (Nevacloud S3) inventory + age-encryption confirmation.

### 2.8 Vault operations
- Seal status; **guided unseal** (operators paste their key shares, never stored).
- AppRole inventory + secret-id rotation (validator / signer / anchor-worker / vault-snapshot).
- Read-only by default; mutations gated + audited.

### 2.9 Observability & alerting
- Embedded Grafana panels (SSO-shared) so you don't context-switch.
- **Alert routing config UI** — wire Alertmanager → Slack / PagerDuty / email (currently stdout only, §17.4 open item) and test routes.
- Incident timeline view.

### 2.10 Audit log (cross-cutting)
- Every privileged action: who, what, when, params, resulting tx hash / receipt status — append-only, exportable. This is the accountability backbone for a production trust anchor.

---

## 3. Architecture

```
                ┌──────────────────────────────────────────────┐
   operators →  │  Strata Console (React/TS SPA, dark theme)    │   console.platform.haratrust.io
   (did:hara    │  shadcn/ui + Tailwind + wagmi/viem + Recharts │   (VPN/WG-gated, NOT public)
    via Numira) └───────────────┬──────────────────────────────┘
                                │ authenticated REST/WS (RBAC)
                ┌───────────────▼──────────────────────────────┐
                │  Console API (Node 22 + Fastify, on .25)      │  mirrors existing services
                │  aggregators + guarded action handlers + audit│
                └─┬───────┬────────┬────────┬────────┬──────────┘
       Besu RPC ──┘  Prometheus  Vault    HAProxy   Postgres   (+ Alertmanager, Blockscout,
     (qbft/txpool)   /Alertmgr   API      stats     /indexer    systemd timer status via agent)
                                   │
                         ┌─────────▼─────────┐
                         │ Secure signer tier │  Vault Transit OR Gnosis Safe —
                         │ (admin key NEVER   │  console PROPOSES, this layer SIGNS
                         │  in browser/API)   │
                         └────────────────────┘
```

- **Frontend:** React + TypeScript, **shadcn/ui** + Tailwind, **wagmi/viem** for chain reads/writes, Recharts (or embedded Grafana) for metrics. Dark-first theme on the brand palette.
- **Backend:** Node 22 + Fastify (same stack as `services/`), deployed as another container on `hara-stateless-2`, behind Caddy at `console.platform.haratrust.io`. Talks to peers over the WireGuard mesh (RPC `10.43.0.21`, Vault/PG `10.43.0.40`).
- **Timer/host status:** a tiny read-only agent (or `systemctl --json` over a constrained SSH) feeds backup/host state — no general shell exposure.
- **Auth:** **Hara Numira** — the hara-did **decentralized SSO (dSSO)**. Operators sign in with their `did:hara` identity (DID-signed assertion / verifiable presentation verified against the chain's DID anchors); no central password store. Console-level RBAC (Viewer / Operator / Approver) is bound to the DID. MFA is inherent (the operator's DID key + device).

---

## 4. Branding (from `doc/design`)

The console adopts the **"Strata"** identity directly.

| Token | Value | Use |
|---|---|---|
| `--brand-teal` | `#2BD4C0` | primary accent, "REGISTRY" wordmark, links, success-ish |
| `--brand-blue` | `#3B6BFF` | primary action / focus |
| `--brand-indigo` | `#5A45E0` | gradient end, headers |
| brand gradient | `#2BD4C0 → #3B6BFF → #5A45E0` | the Strata rings; hero/active accents |
| `--accent-amber` | `#FFC56E` / `#F39B24` | the warm "core" — highlights, the live/"truth" pulse, primary CTA glow |
| `--accent-orange` | `#FF9D5C` | warnings / attention |
| `--bg-900` | `#070B18` | app background (deepest) |
| `--bg-800` | `#0C1226` | panels / cards |
| `--bg-700` | `#101A38` | raised surfaces / borders |
| `--text-0` | `#FFFFFF` | primary text on dark |
| `--text-1` | `#E8ECF6` | secondary text |
| `--surface-light` | `#F4F6FB` | (optional light mode) |

- **Type:** **Sora** for display/headings + the wordmark (matches the kit); **Inter** for body/data tables.
- **Logo:** use `svg/static/ic_registry_*` — `mono_rev` lockup in the top nav on dark; the **animated** ring SVGs (`svg/animated/*`) make a great app loader / "live chain" indicator.
- **Motif:** the concentric Strata rings as the visual language for "layers/health" — e.g. a ring gauge for sync depth, the amber core pulsing when blocks are landing.
- **Default theme: dark** (the brand's native mode); optional light theme via the `F4F6FB/E8ECF6` neutrals.

---

## 5. Security model (the part that matters most)

A console that can grant roles and move the admin key is a **high-value target**. Non-negotiables:

1. **The admin private key never enters the console or the browser.** The console builds an unsigned action; a separate layer signs:
   - **Preferred:** **Gnosis Safe** multisig — privileged actions become Safe proposals requiring N-of-M operator approvals (also closes the §17.3 single-key risk).
   - **Interim:** **Vault Transit** signing with a tight policy + per-action human approval; key stays in Vault.
2. **Read-mostly by default.** Every mutating action is explicit, confirmed, and shows the exact tx it will submit + simulated effect.
3. **Not public.** Reachable only over WireGuard / VPN; Caddy + SSO + MFA in front; rate-limited.
4. **RBAC:** Viewer (dashboards) / Operator (funding, registry, snapshots) / Approver (role grants, validator changes, multisig sign). No single role can both propose *and* approve an admin action.
5. **Everything audited** (§2.10), and privileged actions also fire an alert.
6. **Vault unseal shares are never persisted** — entered transiently for the guided unseal only.
7. **Guard rails encoded:** validator changes enforce "never drop below quorum"; role revokes warn if you'd orphan the last admin; funding uses legacy/gasPrice-0.

---

## 6. Phased rollout

| Phase | Scope | Risk | Value |
|---|---|---|---|
| **P0 — Glass** | Read-only unified dashboard (§2.1) + embedded Grafana + alert feed + **zero-balance watchlist** + backup/Vault-seal status. No writes. | Low | High — immediate situational awareness; would've caught the hara-xchange zero-balance issue proactively |
| **P1 — Assisted ops** | Treasury funding (§2.3), contract registry (§2.5), partner onboarding wizard (§2.6), on-demand snapshots/restore drill (§2.7). Guarded writes via Vault Transit. | Med | High — kills the manual SSH/script toil |
| **P2 — Governance** | Role grant/revoke (§2.2) + validator add/remove (§2.4) via **Gnosis Safe multisig**; guided Vault unseal (§2.8). | High | High — real governance, multi-operator control |
| **P3 — Full ops** | Alert routing config (§2.9), incident mgmt, DR automation, scheduled jobs, anchor-worker mgmt. | Med | Medium — polish + completeness |

Each phase is independently shippable; **P0 alone is worth building** even if we stop there.

---

## 7. Tech stack (recommended)

- **Frontend:** Vite + React + TypeScript, Tailwind + shadcn/ui, wagmi + viem, Recharts; Sora + Inter.
- **Backend:** Node 22 + Fastify (reuse `services/shared` patterns), zod-validated APIs, Prometheus client for self-metrics.
- **Signing:** Vault Transit (P1) → Gnosis Safe (P2).
- **Auth:** **Hara Numira** (hara-did dSSO) — DID-based login (`did:hara`); RBAC bound to the DID; MFA inherent in the DID key/device. The console verifies a DID-signed assertion; no central credential store.
- **Deploy:** container on `hara-stateless-2`, Caddy site `console.platform.haratrust.io`, WG/VPN-gated; image built locally + scanned/signed like the other services.
- **Repo:** new `console/` workspace in this repo (or a sibling repo) so it inherits CI gates + branch protection.

---

## 8. Effort & risks (rough)

- **P0:** ~2–3 weeks (mostly read aggregation + UI + brand system). Lowest risk.
- **P1:** ~3–4 weeks (Vault Transit signer + funding/registry/onboarding flows + audit log).
- **P2:** ~4–6 weeks, gated on standing up Gnosis Safe + multi-operator process.
- **P3:** ~3–4 weeks.

**Main risks:** (a) the signing/governance security model — must be right before any write phase; (b) scope creep — keep P0 strictly read-only; (c) it becomes a new single point of control — mitigate with multisig + audit + network isolation.

---

## 9. Decisions & open questions

**Decided (2026-06-02):**
- **SSO → Hara Numira (hara-did dSSO).** Operators authenticate with `did:hara`; no central IdP. (P0 stubs auth behind the WG/VPN gate; Numira integration lands as P0.5/P1.)
- **Repo → `console/` workspace in THIS repo for P0** (inherits CI gates + branch protection; CI is free on the public repo; path-filters keep `services`/`contracts` workflows from running on `console/**`). **Extract to a dedicated *private* repo at P1**, when it gains write/governance power and the source becomes sensitive.
- **First slice → P0 (read-only "glass").** Building now.

**Still open:**
- Multisig: stand up **Gnosis Safe** before P2 (recommended) or accept Vault-Transit-only signing initially? (P2 concern — defer.)
- Exact `did:hara` verification contract/flow for Numira (coordinate with the hara-did partner).

---

*Branding sourced from `doc/design/` ("Strata" mark, full asset set: full/dark/brand/mono_ink/mono_rev × icon/lockup × svg/png, static + animated).*
