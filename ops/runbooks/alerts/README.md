# Alert runbooks

Each alert in `chain/prometheus/alert_rules.yml` has a `runbook:` annotation pointing to a file in this directory. The runbook is the **first thing** on-call should read when an alert fires.

## Runbook template

Every runbook follows this structure:

1. **What this alert means** — 2-sentence plain English.
2. **Severity & SLA** — how fast does on-call need to respond.
3. **First diagnostic steps** — commands to run, in order.
4. **Common causes** — short list, with the action to take for each.
5. **Mitigation** — temporary fix to stop user impact.
6. **Root cause** — how to find the underlying problem.
7. **Escalation** — when to page the next tier.

## Alphabetical index

| Alert | Severity | File |
|---|---|---|
| ChainStalled | critical | [ChainStalled.md](ChainStalled.md) |
| IndexerDown | critical | [IndexerDown.md](IndexerDown.md) |
| IndexerErrorsFiring | warning | (stub) |
| IndexerLagHigh | warning / critical | [IndexerLagHigh.md](IndexerLagHigh.md) |
| RPCBackendDown | warning | (stub) |
| RPCHighErrorRate | warning | (stub) |
| RPCReadPoolAllDown | critical | (stub) |
| ScrapeTargetMissing | warning | (stub) |
| ValidatorMetricsMissing | critical | (stub) |
| ValidatorPeersLow | warning | (stub) |

Critical alerts have runbooks today. Warning-level alerts share the same diagnostic pattern; their runbooks will be filled in as we encounter each in dev/staging.
