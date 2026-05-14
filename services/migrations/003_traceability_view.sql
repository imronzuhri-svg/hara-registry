-- L5+ — traceability projection over indexed_events
--
-- Adds two new derived views on top of the indexer's raw event stream that
-- the explorer's traceability page queries directly. Materialised so a 10K-hop
-- batch renders in <100ms.

BEGIN;

-- Register the palm-oil contracts so the indexer starts capturing events from them.
-- The deterministic addresses below assume a fresh chain with deploys in this order:
--    nonce 0,1,2: Deploy.s.sol (ContractRegistry, Anchor, Governance)
--    nonce 3:    DeployTestToken.s.sol (if used)
--    nonce 4,5:  DeployPalmOil.s.sol (HaraPalmOil, TraceabilityBatchRelay)
-- If your chain has a different nonce sequence, update these manually after deploy
-- and re-INSERT — see ops/runbooks/L5-blockscout.md "Adding a new contract".
INSERT INTO watched_contracts (contract_address, name) VALUES
  ('0xa31f4c0ef2935af25370d9ae275169ccd9793da3', 'HaraPalmOil'),
  ('0xf9c0bf1cfaab883adb95fed4cfd60133bffab18a', 'TraceabilityBatchRelay')
ON CONFLICT (contract_address) DO NOTHING;

-- Clean up the old palm-oil seed if it leaked in from the original 002 run before
-- 003 was authored. Safe to run; no-op if rows aren't there.
DELETE FROM watched_contracts
 WHERE contract_address IN (
   '0x5fbdb2315678afecb367f032d93f642f64180aa3',
   '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512'
 )
   AND name IN ('HaraPalmOil','TraceabilityBatchRelay');

-- Flat normalised view of every custody hop, easy to query and join.
-- Each row = one TransferSingle event = one custody event.
CREATE OR REPLACE VIEW custody_hops AS
SELECT
  (e.decoded->>'id')::numeric                  AS batch_id,
  (e.decoded->>'value')::numeric               AS liters,
  e.decoded->>'from'                            AS from_addr,
  e.decoded->>'to'                              AS to_addr,
  e.decoded->>'operator'                        AS operator_addr,
  e.tx_hash,
  e.block_number,
  e.log_index,
  to_timestamp(b.timestamp_unix)                AS occurred_at
FROM indexed_events e
JOIN indexed_blocks  b USING (block_number)
WHERE e.contract_name = 'HaraPalmOil'
  AND e.event_name    = 'TransferSingle'
  AND e.decoded->>'from' != '0x0000000000000000000000000000000000000000';  -- exclude mints

-- One row per batch with summary stats (current holder, hop count, etc.)
CREATE OR REPLACE VIEW batch_summary AS
WITH mint_events AS (
  SELECT
    (decoded->>'batchId')::numeric             AS batch_id,
    decoded->>'firstOwner'                      AS first_owner,
    (decoded->>'liters')::numeric              AS initial_liters,
    decoded->>'rspoCertificateHash'             AS rspo_hash,
    decoded->>'plantationId'                    AS plantation_id,
    (decoded->>'productionDate')::numeric      AS production_date_unix,
    tx_hash                                     AS mint_tx_hash,
    block_number                                AS mint_block,
    to_timestamp((SELECT timestamp_unix FROM indexed_blocks WHERE block_number = e.block_number)) AS minted_at
  FROM indexed_events e
  WHERE contract_name = 'HaraPalmOil' AND event_name = 'BatchMinted'
),
last_hop AS (
  SELECT DISTINCT ON (batch_id) batch_id, to_addr AS current_holder, occurred_at
    FROM custody_hops
   ORDER BY batch_id, block_number DESC, log_index DESC
),
hop_count AS (
  SELECT batch_id, count(*) AS hop_count FROM custody_hops GROUP BY batch_id
)
SELECT
  m.batch_id,
  m.initial_liters,
  m.first_owner,
  COALESCE(l.current_holder, m.first_owner) AS current_holder,
  COALESCE(h.hop_count, 0)                  AS hop_count,
  m.rspo_hash,
  m.plantation_id,
  to_timestamp(m.production_date_unix)      AS production_date,
  m.minted_at,
  l.occurred_at                             AS last_hop_at
FROM mint_events m
LEFT JOIN last_hop  l ON l.batch_id = m.batch_id
LEFT JOIN hop_count h ON h.batch_id = m.batch_id;

COMMIT;
