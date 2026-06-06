# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in HaraLedger, **please do not open a public GitHub issue.**

Instead, report it privately through one of these channels:

- **GitHub Security Advisories** (preferred): [Open a security advisory →](https://github.com/imronzuhri-svg/hara-registry/security/advisories/new) — encrypted by default, only visible to repo maintainers.
- **Email** (fallback): `security@hara.id` (PGP key fingerprint pending — request the current key by email first).

Please include:

1. Affected component(s) — e.g. `contracts/src/HaraPalmOil.sol`, `services/signer/`, `deploy/chain/`, etc.
2. A description of the issue and its potential impact
3. Steps to reproduce (or a proof-of-concept, even partial)
4. Your suggested fix or mitigation, if any
5. Whether you'd like public credit when the fix is released, and how to credit you

We commit to:

- **Acknowledge receipt** within **48 hours** (business hours UTC+7, Jakarta).
- **Provide an initial assessment** (severity + tentative fix timeline) within **5 business days**.
- **Keep you informed** of remediation progress at least every 14 days until resolution.
- **Coordinate disclosure timing** with you, defaulting to a **90-day** embargo after a fix is shipped, unless we agree otherwise.

## Scope

### In scope

| Component | Examples |
|---|---|
| **Smart contracts** (`contracts/src/`) | Logic flaws, access-control bypass, reentrancy, integer issues, gas-griefing, signature forgery, oracle manipulation |
| **Application services** (`services/`) | Signer key handling, nonce reuse, queue poisoning, SQL injection, SSRF, auth bypass, race conditions |
| **Chain configuration** (`chain/`, `deploy/chain/`) | Validator key handling, genesis tampering, P2P attacks, QBFT consensus issues |
| **Deployment** (`deploy/`) | Container escape, secrets exposure, privilege escalation, supply-chain attacks on referenced images |
| **RPC infrastructure** (`chain/lb/`, `services/rpc-cache/`) | Bypassable rate limits, cache poisoning, cross-tenant data leakage |
| **Observability** (`_platform/`, `deploy/platform/`) | Sensitive data in logs, metrics endpoints exposing secrets, dashboard XSS |
| **Documentation** | Insecure-by-design patterns documented as the correct approach |

### Out of scope

These don't need to go through private disclosure — open a regular issue or PR:

- Bugs unrelated to security
- Performance issues without a security angle
- Issues in our explicit development-mode defaults (e.g. `haraledger-dev-root` Vault token, `hara_dev_password` Postgres credential, Foundry anvil deployer key `0xac0974b…`) — these are publicly documented and never used in production
- Issues in third-party dependencies that have already been disclosed upstream (Besu, Vault, Postgres, OpenZeppelin, etc.) — file with the upstream project
- Theoretical issues without a realistic exploitation scenario
- Outdated software warnings ("you're using Besu 26.4.0, version 27 is out") — open an issue
- Brute-force or volumetric attacks on dev infrastructure

### Special note on quantum threats

We're aware ECDSA (used by EVM consensus and most signatures) is vulnerable to Shor's algorithm with a sufficiently large quantum computer. See `doc/technical/audit-security-quantum-performance.md` for our hybrid-classical-PQ mitigation roadmap. **Reports demonstrating quantum-feasibility today** (i.e., you have a working quantum computer that can run Shor's at scale) are very much in scope — and would be the most consequential vulnerability disclosure in computing history. Please do reach out.

## Severity assessment

We use a CVSS 3.1 base score plus context-specific multipliers:

| Tier | Score range | Examples in our context | Bounty (when bounty program is live) |
|---|---:|---|---:|
| Critical | 9.0–10.0 | Validator key compromise via remote vector; arbitrary tx execution as governor; chain rollback; production secret in public repo | $5,000–$25,000 |
| High | 7.0–8.9 | Unauthorised token mint; bypass of QBFT quorum; signer service auth bypass; RSPO certificate forgery | $1,000–$5,000 |
| Medium | 4.0–6.9 | Sensitive log leakage; DoS on a single service tier; cache poisoning affecting trust | $200–$1,000 |
| Low | 0.1–3.9 | Information disclosure with limited operational impact; bypassable rate limit | $50–$200 |

**Note**: The bug bounty program is not yet active. Reports made before the program launches will receive credit + acknowledgement in `SECURITY.md` once it does, with retroactive consideration for bounty payout. The program is expected to start at **P2 (national rollout)**.

## Safe-harbour commitments

We will not pursue legal action against researchers who:

1. Make a good-faith effort to comply with this policy
2. Do not exploit findings beyond what's necessary to demonstrate impact
3. Do not disclose findings publicly before we've had reasonable time to remediate (see "Coordinate disclosure timing" above)
4. Do not exfiltrate or persist beyond what's necessary
5. Do not run automated scanning against our production infrastructure without prior agreement (rate-limited research scanning of public endpoints is OK)

## What we ask in return

- Give us reasonable time to fix the issue before disclosure (default 90 days post-fix-ship)
- Don't social-engineer our team members or partners
- Don't engage in destructive testing — if you can demonstrate "I could have done X", that's enough; don't actually do X
- Treat any test data you encounter as confidential

## Hall of fame

Researchers who have contributed responsibly will be acknowledged here once the program runs its first cycle. Currently empty.

## Cryptographic primitives in use

For context, our security relies on:

- **EVM consensus signatures**: ECDSA on SECP256K1 (Ethereum standard, classical-secure today, planned hybrid-PQ migration P3+)
- **Application-layer audit anchors**: hybrid ECDSA + ML-DSA-65 (NIST FIPS 204) via `PQAnchorRegistry.sol`
- **Hashes**: Keccak256 (Ethereum native) + SHA3-256 (hash agility for `PQAnchorRegistry.sha3Root`)
- **At-rest encryption**: AES-256-GCM (Vault, MinIO encrypted buckets)
- **In-transit encryption (planned, P1)**: TLS 1.3 with X25519MLKEM768 hybrid KEM
- **Key storage**:
  - **Dev**: Vault in dev mode (in-memory)
  - **P1**: Vault HA Raft cluster with AppRole auth
  - **P2+**: HSM (Cloud KMS on Nevacloud / Huawei DEW) or MPC for highest-value keys

See `doc/technical/audit-security-quantum-performance.md` for the full posture and quantum-readiness roadmap.

## Operational security guidelines

If you're deploying HaraLedger (or have a partner doing so), please:

1. Read `deploy/README.md` and `deploy/ops/secrets-bootstrap.sh` before going live
2. Never commit a real `.env` file. The `.gitignore` and `.gitleaks.toml` are configured to prevent this — don't bypass them
3. Rotate Vault and Postgres credentials at least quarterly (more frequently for high-risk environments)
4. Run `deploy/ops/snapshot-validator.sh` and `snapshot-postgres.sh` daily, with retention at least 30 days
5. Subscribe to security advisories from upstream projects (Besu, OpenZeppelin, Vault, Postgres) and our own
6. Monitor the `IndexerDown`, `ChainStalled`, `RPCBackendDown` alert rules in `_platform/prometheus/alert_rules.yml` — they're your first line of incident detection

## Acknowledgements

This policy draws from:
- [Disclose.io](https://disclose.io/)'s safe-harbour template
- The [Open Source Security Foundation](https://openssf.org/)'s security policy guidance
- [OpenZeppelin](https://www.openzeppelin.com/security)'s contracts disclosure process
