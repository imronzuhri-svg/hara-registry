-- L0+ — off-chain PQ signature index (per ADR-0010)
--
-- PQAnchorRegistry.sol commits ONLY keccak256(signature) on-chain. The actual
-- ML-DSA-65 signature blob (~3.3 kB) lives in MinIO at
--   bucket: hara-pq-anchors
--   key:    ml-dsa-65/<commitment_hash>.sig
--
-- This table is the queryable index over those blobs. Lookups are by
-- commitment_hash (= the value committed on-chain) — O(1). Auditors can also
-- enumerate by signer or by anchor tx hash.
--
-- The blob itself is NEVER stored in Postgres — keep base-backup size flat.
-- If you find a BYTEA column called `signature` in a future migration,
-- something has gone wrong; re-read ADR-0010 §"Rejected alternatives".

BEGIN;

CREATE TABLE IF NOT EXISTS pq_anchor_signatures (
    commitment_hash   BYTEA      PRIMARY KEY,      -- 32 bytes, == on-chain commit
    algo              TEXT       NOT NULL,         -- 'ml-dsa-65' for v0; future: 'ml-dsa-87', 'slh-dsa-...'
    signer_did        TEXT       NOT NULL,         -- did:hara:... of the party that signed
    anchor_tx_hash    BYTEA      NOT NULL,         -- 32 bytes; the PQAnchorRegistry.commit tx
    bucket            TEXT       NOT NULL DEFAULT 'hara-pq-anchors',
    object_key        TEXT       NOT NULL,         -- 'ml-dsa-65/<hex>.sig'
    size_bytes        INTEGER    NOT NULL,         -- expected 3309 for ML-DSA-65; sanity-check on write
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Length sanity. ML-DSA-65 sigs are fixed 3309 B per FIPS 204. Future algos
    -- relax via algo-aware app-layer check; the table-level bound just catches
    -- silent corruption (0-byte writes, etc).
    CONSTRAINT pq_sig_size_positive CHECK (size_bytes > 0),

    -- 32-byte hash invariant. Postgres CHECK on octet_length is cheap.
    CONSTRAINT pq_commitment_hash_is_32 CHECK (octet_length(commitment_hash) = 32),
    CONSTRAINT pq_anchor_tx_hash_is_32  CHECK (octet_length(anchor_tx_hash)  = 32)
);

CREATE INDEX IF NOT EXISTS idx_pq_anchor_signer    ON pq_anchor_signatures (signer_did);
CREATE INDEX IF NOT EXISTS idx_pq_anchor_tx_hash   ON pq_anchor_signatures (anchor_tx_hash);
CREATE INDEX IF NOT EXISTS idx_pq_anchor_created   ON pq_anchor_signatures (created_at DESC);

-- Janitor query (NOT installed as a trigger — run manually or via a reconciler
-- job; see ADR-0010 "Open follow-ups" #2). The intent: detect rows whose
-- MinIO object went missing or whose object exists but has no row. The
-- reconciler is responsible for materialising the bucket listing into a
-- temp table and joining; we just document the contract here.
COMMENT ON TABLE pq_anchor_signatures IS
  'Index of off-chain PQ signature blobs. Blob lives in MinIO at bucket/object_key. '
  'On-chain commit lives at PQAnchorRegistry under commitment_hash. '
  'See ADR-0010 in hara-did/docs/adr/.';

COMMENT ON COLUMN pq_anchor_signatures.commitment_hash IS
  'keccak256 of the raw signature bytes. Equals the value committed via PQAnchorRegistry.commit.';

COMMENT ON COLUMN pq_anchor_signatures.size_bytes IS
  'Byte length of the MinIO object. ML-DSA-65: always 3309 (FIPS 204). Reject zero on insert.';

COMMIT;
