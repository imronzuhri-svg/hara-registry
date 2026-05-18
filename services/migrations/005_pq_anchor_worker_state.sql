-- Anchor-worker cursor (per ADR-0010 + PQAnchorRegistry).
--
-- One row per platform tracking the highest indexed block already covered
-- by a PQ anchor. The worker reads from this on every cycle to know where
-- to start; advances after a successful on-chain recordAnchor + MinIO PUT
-- + pq_anchor_signatures INSERT.
--
-- Singleton table (id=1) — keeps the cursor in Postgres alongside the index
-- it advances over, so a single transaction can fence updates against
-- concurrent worker instances if HA arrives (P2).

BEGIN;

CREATE TABLE IF NOT EXISTS pq_anchor_worker_state (
    id                  SMALLINT PRIMARY KEY DEFAULT 1,
    -- Highest indexed_events.block_number already covered by an anchor.
    -- -1 means "nothing anchored yet"; first anchor starts at block 0.
    last_anchored_block BIGINT NOT NULL DEFAULT -1,
    -- The anchorId returned by PQAnchorRegistry on the last successful
    -- recordAnchor (informational; not used for lookup).
    last_anchor_id      BIGINT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id = 1)
);

INSERT INTO pq_anchor_worker_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE pq_anchor_worker_state IS
  'Singleton cursor for anchor-worker. Advances after every successful '
  'PQAnchorRegistry.recordAnchor + MinIO PUT + pq_anchor_signatures INSERT. '
  'See services/anchor-worker/src/store.ts.';

COMMIT;
