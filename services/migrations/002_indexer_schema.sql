-- L3 — Event indexer schema
--
-- Architecture:
--   indexer_state         : single-row cursor (last_indexed_block) for resumability
--   watched_contracts     : known contract addresses + name (ABI looked up in code by name)
--   indexed_blocks        : every block we've seen (chain reorg detection in P2)
--   indexed_events        : every log we've decoded, with raw + decoded payload
--   contract_invocations  : every tx that touched a watched contract (derived view, optional)

BEGIN;

CREATE TABLE IF NOT EXISTS indexer_state (
    id                  SMALLINT PRIMARY KEY DEFAULT 1,
    last_indexed_block  BIGINT NOT NULL DEFAULT -1,
    last_indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id = 1)
);
INSERT INTO indexer_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS watched_contracts (
    contract_address    CHAR(42) PRIMARY KEY,            -- lowercased
    name                TEXT NOT NULL,                    -- maps to ABI in indexer code
    from_block          BIGINT NOT NULL DEFAULT 0,
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexed_blocks (
    block_number    BIGINT PRIMARY KEY,
    block_hash      CHAR(66) NOT NULL,
    parent_hash     CHAR(66) NOT NULL,
    timestamp_unix  BIGINT NOT NULL,
    tx_count        INT NOT NULL DEFAULT 0,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_block_hash ON indexed_blocks(block_hash);

CREATE TABLE IF NOT EXISTS indexed_events (
    event_id          BIGSERIAL PRIMARY KEY,
    block_number      BIGINT NOT NULL,
    block_hash        CHAR(66) NOT NULL,
    tx_hash           CHAR(66) NOT NULL,
    log_index         INT NOT NULL,
    contract_address  CHAR(42) NOT NULL,
    contract_name     TEXT,                              -- denormalised for query speed
    event_signature   TEXT,                              -- e.g. "Transfer(address,address,uint256)"
    event_name        TEXT,                              -- e.g. "Transfer"
    topics            TEXT[] NOT NULL,
    data              TEXT NOT NULL,                     -- raw hex
    decoded           JSONB,                             -- decoded args (null if ABI unknown)
    indexed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (block_hash, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_event_block      ON indexed_events(block_number);
CREATE INDEX IF NOT EXISTS idx_event_contract   ON indexed_events(contract_address);
CREATE INDEX IF NOT EXISTS idx_event_name       ON indexed_events(contract_name, event_name);
CREATE INDEX IF NOT EXISTS idx_event_tx         ON indexed_events(tx_hash);

-- Seed the 3 L0 contracts — deterministic addresses from Foundry default deployer nonce 0..2.
INSERT INTO watched_contracts (contract_address, name) VALUES
  ('0x5fbdb2315678afecb367f032d93f642f64180aa3', 'ContractRegistry'),
  ('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', 'AnchorRegistry'),
  ('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', 'GovernanceContract')
ON CONFLICT (contract_address) DO NOTHING;

COMMIT;
