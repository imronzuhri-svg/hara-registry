# HaraLedger Ecosystem Development Blueprint
## Private EVM Chain, RPC, Indexing, Monitoring, Security, and Scaling Architecture

This document is a practical development guide for building the full **HaraLedger ecosystem**, not only the blockchain node.

HaraLedger should support:

- HaraDID
- Hara Halal Passport
- palm oil and commodity traceability
- halal certificate NFT/credential registry
- audit trail
- public verification
- future RWA/tokenization
- AI compliance and intelligence layer

---

# 1. Strategic Role of HaraLedger

HaraLedger is not merely a blockchain database.

HaraLedger should function as:

> **The private, permissioned trust ledger for HARA’s identity, compliance, traceability, and credential infrastructure.**

It should record and verify:

- DID registry events
- halal certificate issuance
- halal certificate revocation
- traceability token movements
- product credential status
- batch transformation events
- audit hash commitments
- document hash commitments
- public proof anchors
- governance decisions
- validator membership changes

HaraLedger should not store:

- full documents
- certificate PDFs
- user personal data
- photos
- invoices
- audit reports
- large JSON metadata
- private business-sensitive data

Those should be stored off-chain, while HaraLedger stores cryptographic proofs and final state.

---

# 2. Core Architecture

```text
Applications
  ↓
Hara API Gateway
  ↓
Transaction Queue
  ↓
Signer Service
  ↓
RPC Write Node
  ↓
HaraLedger Validator Network
  ↓
Event Indexer
  ↓
Indexer Database
  ↓
Explorer / Dashboard / Verification API
```

Public proof layer:

```text
HaraLedger events
  ↓
Merkle root generator
  ↓
IOTA / public chain anchor
```

---

# 3. HaraLedger Core Components

## 3.1 Validator Nodes

Validator nodes are responsible for consensus and block production.

| Phase | Validator Count | Purpose |
|---|---:|---|
| Phase 1 | 1 | development only |
| Phase 2 | 4 | consortium pilot |
| Phase 3 | 7–15 | national deployment |
| Phase 4 | 20–100+ | multi-country/OIC deployment |

### Validator Responsibilities

- produce blocks
- validate transactions
- maintain chain state
- participate in consensus
- expose metrics
- maintain peer connectivity
- support governance rules

### Important Rule

Do not expose validator RPC publicly.

Validators should communicate through private peer-to-peer networking only.

---

## 3.2 RPC Nodes

RPC nodes are blockchain access points.

| RPC Type | Function |
|---|---|
| Read RPC | dashboard, explorer, verification, analytics |
| Write RPC | submit signed transactions |
| Internal RPC | indexer and worker services |
| Partner RPC | limited external enterprise access |
| Archive RPC | optional historical queries |

### Why Separate RPC From Validators

Validators should not be overloaded by:

- dashboard queries
- explorer traffic
- QR verification
- public API calls
- repeated `eth_getLogs`
- partner integrations

Validators should focus on consensus. RPC nodes should handle traffic.

---

## 3.3 RPC Load Balancer

A load balancer routes traffic to healthy RPC nodes.

### Components

- Nginx / HAProxy / Traefik
- health checks
- rate limits
- IP allowlist
- internal/external routing
- WebSocket support

### RPC Routing Example

```text
/rpc/read        → RPC Read Node 1, RPC Read Node 2
/rpc/write       → RPC Write Node only
/rpc/internal    → internal RPC nodes only
/rpc/partner     → partner RPC with API key
/ws              → WebSocket RPC nodes
```

---

## 3.4 Signer Service

The signer service signs transactions before they are sent to HaraLedger.

### Responsibilities

- receive unsigned transaction requests
- check authorization
- assign nonce
- sign transaction
- send to broadcaster
- store transaction status
- support retry
- support multi-wallet policy

### Signer Security Rules

The signer should:

- never be public-facing
- run in a restricted private network
- only accept requests from trusted internal services
- use encrypted secrets
- rotate keys
- log every signing request
- support role-based signing
- eventually move to HSM/MPC/Vault/KMS

### Signing Flow

```text
Application request
  ↓
Transaction queue
  ↓
Authorization check
  ↓
Nonce manager
  ↓
Signer
  ↓
RPC broadcaster
  ↓
HaraLedger
```

---

## 3.5 Nonce Manager

The nonce manager prevents transaction collision.

### Why It Matters

If HARA submits thousands of token transfers or certificate minting transactions, nonce conflicts can break transaction flow.

### Responsibilities

- track latest nonce per wallet
- reserve nonce before signing
- support retry with same nonce
- prevent duplicate nonce
- detect stuck transactions
- handle replacement transaction

### Recommended Data Structure

```text
wallet_address
current_nonce
reserved_nonce
tx_hash
status
created_at
updated_at
```

---

## 3.6 Transaction Queue

The queue prevents API requests from waiting for blockchain confirmation.

### Recommended Queue Options

| Stage | Queue |
|---|---|
| Phase 1 | Redis Streams / BullMQ |
| Phase 2 | Redis Streams or RabbitMQ |
| Phase 3 | Kafka |
| Phase 4 | Kafka / Pulsar |

### Queue Topics

```text
tx.certificate.mint
tx.certificate.revoke
tx.certificate.renew
tx.did.create
tx.did.update
tx.traceability.transfer
tx.traceability.split
tx.traceability.merge
tx.anchor.publish
tx.retry
```

### Transaction Status Lifecycle

```text
DRAFT
SUBMITTED
QUEUED
AUTHORIZED
SIGNED
BROADCASTED
CONFIRMED
INDEXED
FAILED
RETRYING
REJECTED
```

---

## 3.7 RPC Broadcaster

The broadcaster submits signed transactions to the write RPC node.

### Responsibilities

- broadcast signed transactions
- retry failed broadcasts
- monitor transaction pool
- track transaction hash
- update transaction status
- detect dropped transactions
- trigger replacement if needed

### Important Rule

Do not make the application server directly broadcast transactions.

Broadcasting should be handled by a controlled internal service.

---

## 3.8 Event Indexer

The indexer turns blockchain events into searchable application data.

Applications should not constantly query the chain directly.

```text
HaraLedger
  ↓
Indexer
  ↓
PostgreSQL / OpenSearch
  ↓
Dashboard / API
```

### Events to Index

#### ERC-1155 / Token Events

```text
TransferSingle
TransferBatch
ApprovalForAll
URI
```

#### Halal Passport Events

```text
CertificateIssued
CertificateRenewed
CertificateRevoked
CertificateSuspended
CertificateReactivated
CertificateMetadataUpdated
CertificateDocumentHashUpdated
```

#### DID Events

```text
DIDCreated
DIDUpdated
DIDDeactivated
CredentialIssued
CredentialRevoked
KeyRotated
AliasAdded
```

#### Traceability Events

```text
BatchCreated
BatchTransferred
BatchSplit
BatchMerged
ShipmentCreated
ShipmentReceived
ComplianceStatusUpdated
DocumentAttached
```

#### Governance Events

```text
ValidatorAdded
ValidatorRemoved
PolicyUpdated
ContractUpgraded
AdminRoleChanged
```

---

## 3.9 Indexer Requirements

The indexer must support:

- checkpoint block number
- reindex from block 0
- event deduplication
- reorg handling
- failed block retry
- parallel decoding
- ABI versioning
- contract address registry
- historical backfill
- metrics and alerting

### Recommended Indexer Database Tables

```text
indexed_blocks
indexed_events
transactions
token_transfers
halal_certificates
did_events
credentials
traceability_batches
traceability_events
document_hashes
governance_events
anchor_records
```

---

## 3.10 HaraLedger Explorer

The explorer has two layers.

### Technical Explorer

For developers and infrastructure teams:

- blocks
- transactions
- addresses
- logs
- contract events
- gas usage
- validator status

Possible tool:

- Blockscout

### Business Explorer

For business users:

- certificate status
- product history
- batch lineage
- issuer identity
- revocation status
- document proof
- audit trail
- public verification result

HARA needs both. A normal block explorer is not enough.

---

# 4. Smart Contract Modules

## 4.1 Contract Registry

Maintains official contract addresses.

### Functions

- register contract address
- update contract address
- version contract
- expose active contract version

This is useful because HARA will evolve contracts over time.

---

## 4.2 DID Registry Contract

Stores minimal DID state.

### Stores

```text
did
controller
publicKeyHash
serviceEndpointHash
status
updatedAt
```

### Does Not Store

- full identity data
- NIK
- passport number
- phone number
- private profile
- biometric data

---

## 4.3 Credential Registry Contract

Stores credential issuance and revocation proof.

### Stores

```text
credentialId
issuerDID
holderDID
credentialType
credentialHash
status
issuedAt
expiredAt
revokedAt
```

---

## 4.4 Halal Certificate Contract

This may use ERC-1155-style non-transferable token logic.

### Stores

```text
certificateId
tokenId
issuerDID
holderDID
productIdHash
metadataHash
documentHash
status
issuedAt
expiredAt
```

### Functions

```text
mintCertificate()
batchMintCertificates()
revokeCertificate()
suspendCertificate()
reactivateCertificate()
renewCertificate()
updateMetadataHash()
updateDocumentHash()
verifyCertificate()
```

### Transfer Rule

Halal certificate tokens should usually be non-transferable. Only authorized lifecycle updates should be allowed.

---

## 4.5 Traceability Token Contract

Used for palm oil and other commodity batches.

ERC-1155 is appropriate because it supports:

- batch tokens
- semi-fungible quantities
- split
- merge
- transfer
- burn
- mint
- batch operations

### Functions

```text
mintBatch()
transferBatch()
splitBatch()
mergeBatch()
burnBatch()
attachDocument()
updateComplianceStatus()
```

---

## 4.6 Revocation Registry

Central revocation logic for:

- DID
- credentials
- halal certificates
- product claims
- traceability claims

### Functions

```text
revoke()
suspend()
reactivate()
getStatus()
```

---

## 4.7 Audit Hash Registry

Stores hashes of off-chain documents and datasets.

### Use Cases

- audit report
- halal certificate PDF
- product registration document
- invoice
- lab result
- traceability document
- export/import document

### Stores

```text
documentHash
metadataHash
issuerDID
documentType
timestamp
status
```

---

## 4.8 Anchor Registry

Stores public anchoring records.

### Stores

```text
merkleRoot
sourceBlockFrom
sourceBlockTo
eventCount
anchorChain
anchorTxHash
anchoredAt
```

---

## 4.9 Governance Contract

Manages permissioned governance.

### Use Cases

- add validator
- remove validator
- change contract admin
- approve contract upgrade
- change system policy
- emergency pause

---

# 5. Data Storage Strategy

## On-Chain Data

Store only:

- IDs
- status
- issuer DID
- holder DID
- hashes
- timestamps
- Merkle roots
- final state
- contract events

## Off-Chain Data

Store in PostgreSQL and object storage:

- certificate PDFs
- product metadata
- company profile
- audit documents
- export/import documents
- images
- attachments
- AI extraction results
- workflow state

## Object Storage

Recommended:

- MinIO on Nevacloud
- replicated backup to Huawei Object Storage
- encrypted document buckets
- lifecycle policies
- immutable backup option later

---

# 6. Monitoring Requirements

## 6.1 Node Monitoring

Monitor every validator and RPC node:

- block height
- peer count
- CPU
- RAM
- disk usage
- disk I/O
- network traffic
- block production time
- missed blocks
- RPC latency
- node sync status
- validator participation

## 6.2 RPC Monitoring

Metrics:

- request per second
- error rate
- average latency
- p95 latency
- p99 latency
- `eth_getLogs` usage
- WebSocket connection count
- failed requests
- rate-limited requests
- upstream health

## 6.3 Transaction Monitoring

Metrics:

- queued transactions
- signed transactions
- broadcasted transactions
- confirmed transactions
- failed transactions
- stuck transactions
- average confirmation time
- nonce conflict count
- replacement transaction count

## 6.4 Indexer Monitoring

Metrics:

- latest indexed block
- chain head block
- indexing lag
- failed block processing
- failed event decoding
- duplicate events
- database write latency
- reindex progress
- event throughput

## 6.5 Smart Contract Monitoring

Metrics:

- contract call volume
- minting volume
- revocation volume
- transfer volume
- failed contract calls
- pause events
- admin role changes
- contract upgrade events

## 6.6 Business Monitoring

Metrics:

- active certificates
- revoked certificates
- expired certificates
- certificate minting rate
- DID creation rate
- QR verification count
- exporter verification count
- importer verification count
- traceability batch count
- suspicious activity count

## 6.7 Recommended Monitoring Stack

| Need | Tool |
|---|---|
| Metrics | Prometheus |
| Dashboard | Grafana |
| Logs | Loki |
| Error tracking | Sentry |
| Uptime check | Uptime Kuma |
| Alerts | Alertmanager |
| Node metrics | Node Exporter |
| Container metrics | cAdvisor |
| Blockchain metrics | custom exporters |

---

# 7. Security Architecture

## 7.1 Network Segmentation

Separate networks:

```text
public network
internal app network
database network
blockchain peer network
signer network
monitoring network
backup network
```

## 7.2 Access Rules

| Component | Public Access? |
|---|---|
| Gateway | Yes |
| Public verification API | Yes |
| Admin API | Restricted |
| Database | No |
| Signer | No |
| Validator RPC | No |
| Read RPC | Restricted |
| Write RPC | Internal only |
| Monitoring | Restricted |
| Object storage | Signed access only |

## 7.3 Key Management

### Phase 1

- encrypted environment secrets
- restricted server access
- manual key rotation

### Phase 2

- Hashicorp Vault
- separated signer
- role-based keys
- audit logs

### Phase 3

- HSM or MPC
- cloud KMS integration
- hardware-backed signing
- multi-sig governance

## 7.4 Smart Contract Security

Required:

- unit tests
- integration tests
- role permission tests
- upgrade tests
- pausable emergency function
- audit trail
- external audit before national deployment
- formal permission matrix

---

# 8. Backup and Disaster Recovery

## 8.1 Backup Targets

| Data | Backup Target |
|---|---|
| PostgreSQL | Huawei DR database + object storage |
| Object documents | Huawei object storage |
| Chain data | validator snapshots |
| Smart contract artifacts | Git repository + artifact storage |
| Config files | encrypted repo |
| Keys | secure offline backup / Vault / HSM |
| Indexer DB | reconstructable, but still backed up |

## 8.2 Backup Frequency

| Data | Frequency |
|---|---|
| PostgreSQL WAL | continuous |
| PostgreSQL full backup | daily |
| Object storage sync | hourly/daily depending on criticality |
| Chain snapshot | daily |
| Config backup | every change |
| Monitoring data | daily |
| Explorer data | optional; can be rebuilt |

## 8.3 Suggested Recovery Objectives

| System | RPO | RTO |
|---|---:|---:|
| Public verification API | 15 min | 1 hour |
| Halal Passport API | 30 min | 2–4 hours |
| HaraDID | 15–30 min | 2 hours |
| HaraLedger validators | near-zero if validators distributed | 1–2 hours |
| Object storage | 1 hour | 4 hours |
| AI analytics | 24 hours | 24 hours |

---

# 9. Development Environment

## 9.1 Local Development

Use Docker Compose for:

- local EVM chain
- PostgreSQL
- Redis
- MinIO
- API services
- indexer
- signer mock
- frontend portals

## 9.2 Staging Environment

Staging should mirror production logically:

- separate database
- separate test chain
- test validators
- test RPC
- test explorer
- test object storage
- fake identity verification
- fake certificate issuance

## 9.3 Production Environment

Production should use:

- separate secrets
- separate keys
- separate validator network
- strict access control
- automated backups
- monitoring alerts
- CI/CD approval gates

---

# 10. CI/CD Pipeline

## Recommended Pipeline

```text
Code commit
  ↓
Automated tests
  ↓
Build Docker image
  ↓
Security scan
  ↓
Push image registry
  ↓
Deploy to staging
  ↓
Run integration tests
  ↓
Manual approval
  ↓
Deploy to production
```

## Deployment Tools

| Phase | Tools |
|---|---|
| Phase 1 | GitHub Actions, Docker Compose, Ansible |
| Phase 2 | GitHub Actions, Ansible, Docker Swarm or K3s |
| Phase 3 | Kubernetes, Helm, ArgoCD |

---

# 11. Recommended VPS Layout

## Phase 1 — Development MVP

| VPS | Role | Spec | Main Components |
|---|---|---|---|
| VPS 1 | Gateway + Frontend | 4 vCPU / 8GB | Nginx, Next.js portals |
| VPS 2 | Database + Redis | 4 vCPU / 16GB | PostgreSQL, Redis |
| VPS 3 | Validator + RPC | 4 vCPU / 16GB | Besu/Geth, RPC, contracts |
| VPS 4 | Worker + Signer + Indexer | 4 vCPU / 8GB | signer, nonce, indexer, workers |
| VPS 5 | Object Storage | 4 vCPU / 8GB / 1TB | MinIO |
| VPS 6 | Monitoring + Explorer | 4 vCPU / 8GB | Grafana, Prometheus, Loki, explorer |

Huawei Phase 1:

| Huawei Component | Role |
|---|---|
| Backup storage | Offsite backup |
| AI sandbox | OCR/document extraction prototype |

---

## Phase 2 — Pilot Production

| VPS | Role | Spec | Main Components |
|---|---|---|---|
| VPS 1–2 | Gateway/LB | 2–4 vCPU / 4–8GB | HAProxy/Nginx |
| VPS 3–4 | App/API | 8 vCPU / 16GB | HaraDID API, Halal API, Verification API |
| VPS 5 | Frontend Portals | 4 vCPU / 8GB | BPJPH, LPH, MUI, Exporter, Importer, Manufacturer |
| VPS 6 | PostgreSQL Primary | 8–16 vCPU / 32GB / 1TB | main DB |
| VPS 7 | PostgreSQL Replica | 8–16 vCPU / 32GB / 1TB | read replica |
| VPS 8 | Redis/Queue | 4–8 vCPU / 16GB | Redis Streams/BullMQ |
| VPS 9–12 | Validators | 8 vCPU / 16GB / 500GB | HaraLedger validators |
| VPS 13–14 | RPC Read Nodes | 8 vCPU / 16GB / 500GB | read RPC, WebSocket |
| VPS 15 | RPC Write/Broadcaster | 8 vCPU / 16GB | write RPC, tx broadcaster |
| VPS 16 | Signer/Workers | 8 vCPU / 16GB | signer, mint/revoke/renew workers |
| VPS 17 | Event Indexer | 8 vCPU / 16GB | blockchain indexer |
| VPS 18 | Explorer/Verifier | 4–8 vCPU / 8–16GB | explorer, QR resolver |
| VPS 19 | Object Storage | 8 vCPU / 16GB / 2–5TB | MinIO |
| VPS 20 | Monitoring/Logging | 4–8 vCPU / 8–16GB | Grafana, Prometheus, Loki |

Huawei Phase 2:

| Huawei Component | Role |
|---|---|
| Backup validator | multi-cloud validator |
| DR database replica | offsite DB recovery |
| Secondary object storage | document backup |
| AI server | OCR, risk scoring, document extraction |
| DR app server | emergency verification API |

---

# 12. Public Anchoring Service

HaraLedger can periodically anchor proofs to public networks.

## Recommended Design

```text
HaraLedger events
  ↓
Event bundle
  ↓
Merkle tree
  ↓
Merkle root
  ↓
IOTA / public chain transaction
  ↓
Anchor registry on HaraLedger
```

## What Gets Anchored

- event range
- Merkle root
- number of events
- timestamp
- HaraLedger block range
- public anchor transaction hash

## Why Anchor

- external proof
- timestamp evidence
- public verifiability
- stronger audit position
- no sensitive data exposure

---

# 13. Migration Path to Avalanche Private L1

HaraLedger can begin as Besu QBFT and later move to Avalanche private L1 if needed.

## Why This Is Possible

Both are EVM-compatible.

If smart contracts are written properly, business logic can be migrated with less friction.

## Migration Strategy

1. Keep contracts EVM-compatible.
2. Avoid chain-specific assumptions.
3. Keep all business data indexed off-chain.
4. Use event replay mechanism.
5. Use snapshot of final state.
6. Deploy same contracts on Avalanche private L1.
7. Re-mint or migrate final states.
8. Verify with Merkle proof.
9. Switch API to new RPC endpoint.
10. Keep old HaraLedger as historical archive.

---

# 14. Performance Optimization

## 14.1 Token Transfer Optimization

Use:

- ERC-1155 batch transfer
- queue-based processing
- nonce manager
- parallel signing
- RPC broadcaster
- event batching
- Merkle proof
- status update after indexer confirmation

Avoid:

- API waits for blockchain confirmation
- one transfer per HTTP request
- direct DB writes from smart contract calls
- public APIs querying blockchain directly

## 14.2 RPC Optimization

Use:

- multiple read RPC nodes
- separate write RPC node
- WebSocket subscriptions
- RPC caching
- rate limiting
- batched JSON-RPC calls
- internal RPC for indexer only

## 14.3 Indexer Optimization

Use:

- event topic filters
- block range batching
- checkpointing
- parallel event decoding
- bulk DB inserts
- retry queue
- reindex mode
- ABI version registry

## 14.4 Database Optimization

Use:

- proper indexes
- partitioning by date/tenant/certificate type
- read replica
- connection pooling
- bulk insert
- archive old data
- OpenSearch for search-heavy queries

---

# 15. HaraLedger Development Roadmap

## Stage 1 — Core Chain

- private EVM network
- basic validator
- RPC endpoint
- contract deployment
- explorer
- basic monitoring

## Stage 2 — Identity + Credential

- DID registry
- credential registry
- revocation registry
- HaraDID integration
- QR verification

## Stage 3 — Halal Passport

- certificate contract
- certificate minting
- certificate revocation
- certificate renewal
- BPJPH/LPH/MUI workflows
- public verification

## Stage 4 — Traceability

- ERC-1155 batch token
- transfer
- split
- merge
- attach document hash
- compliance status
- Merkle proof

## Stage 5 — Consortium Governance

- multi-validator network
- governance contract
- validator onboarding
- validator monitoring
- policy update process

## Stage 6 — Public Proof

- Merkle root generation
- IOTA anchoring
- anchor registry
- proof verification API

## Stage 7 — National-Scale Hardening

- Kubernetes
- Kafka
- OpenSearch
- Vault/HSM/MPC
- HA database
- distributed storage
- external security audit

---

# 16. Final Recommended Build Order

The recommended implementation order is:

1. HaraLedger private EVM network
2. RPC read/write separation
3. transaction queue
4. signer service
5. nonce manager
6. event indexer
7. PostgreSQL indexer database
8. explorer
9. DID registry contract
10. credential registry contract
11. halal certificate contract
12. revocation registry
13. public verification API
14. monitoring dashboards
15. backup and disaster recovery
16. multi-validator expansion
17. public anchoring
18. traceability token contract
19. governance contract
20. Avalanche migration prototype if needed

---

# 17. Final Architecture Summary

HaraLedger should be developed as a complete ecosystem:

```text
Validator Network
+ RPC Infrastructure
+ Signer Service
+ Transaction Queue
+ Event Indexer
+ Smart Contract Modules
+ Explorer
+ Monitoring
+ Backup/DR
+ Governance
+ Public Anchoring
```

Its job is to provide a trusted ledger foundation for:

```text
HaraDID
+ Hara Halal Passport
+ Hara Traceability
+ HARA Intelligence
+ future HARA RWA/tokenization
```

The key is not only to make the chain fast.

The key is to make the entire ledger ecosystem:

- secure
- observable
- scalable
- auditable
- recoverable
- interoperable
- upgradeable
- enterprise-ready
