-- L2 — signer/broadcaster pipeline schema
--
-- Tables:
--   wallets          : signer-key registry (address + Vault path; key itself stays in Vault)
--   wallet_nonces    : per-wallet local nonce ledger (reservation + acknowledgement)
--   transactions    : full tx lifecycle record (DRAFT → ... → CONFIRMED / FAILED)
--   tx_attempts      : per-broadcast attempt history (for retry diagnostics)

BEGIN;

CREATE TABLE IF NOT EXISTS wallets (
    address       CHAR(42) PRIMARY KEY,    -- lowercased 0x-prefixed
    vault_path    TEXT NOT NULL,            -- e.g. secret/haraledger/signer-keys/deployer
    label         TEXT NOT NULL,            -- human-readable
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_nonces (
    address           CHAR(42) PRIMARY KEY REFERENCES wallets(address) ON DELETE CASCADE,
    last_reserved     BIGINT NOT NULL DEFAULT -1,   -- highest nonce we have allocated
    last_confirmed    BIGINT NOT NULL DEFAULT -1,   -- highest nonce confirmed on-chain
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transaction states
DO $$ BEGIN
    CREATE TYPE tx_status AS ENUM (
        'DRAFT',         -- accepted by API, not yet processed
        'QUEUED',        -- in Redis Stream awaiting signing/broadcast
        'SIGNED',        -- signed, awaiting broadcast (rare, brief)
        'BROADCASTED',   -- sent to RPC, awaiting receipt
        'CONFIRMED',     -- mined with receipt status=1
        'REVERTED',      -- mined with receipt status=0
        'FAILED',        -- gave up (max retries / unrecoverable)
        'RETRYING'       -- transient failure, will retry
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS transactions (
    tx_id           UUID PRIMARY KEY,                       -- internal id, returned to client
    from_address    CHAR(42) NOT NULL,
    to_address      CHAR(42),
    data            TEXT NOT NULL DEFAULT '0x',
    value           NUMERIC(78, 0) NOT NULL DEFAULT 0,      -- wei, fits uint256
    gas_limit       BIGINT,
    nonce           BIGINT,
    chain_id        BIGINT NOT NULL,
    raw_tx          TEXT,                                   -- signed rlp hex
    tx_hash         CHAR(66),                               -- eth tx hash
    status          tx_status NOT NULL DEFAULT 'DRAFT',
    receipt_status  SMALLINT,                               -- 0 reverted, 1 success
    block_number    BIGINT,
    gas_used        BIGINT,
    error_message   TEXT,
    retry_count     SMALLINT NOT NULL DEFAULT 0,
    submitted_by    TEXT,                                   -- client identifier (header/api key)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tx_status      ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_from        ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_tx_hash        ON transactions(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_created     ON transactions(created_at DESC);

CREATE TABLE IF NOT EXISTS tx_attempts (
    attempt_id      BIGSERIAL PRIMARY KEY,
    tx_id           UUID NOT NULL REFERENCES transactions(tx_id) ON DELETE CASCADE,
    attempt_number  SMALLINT NOT NULL,
    tx_hash         CHAR(66),
    rpc_response    JSONB,
    error_message   TEXT,
    attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempt_tx     ON tx_attempts(tx_id, attempt_number);

-- Bootstrap row: the deployer wallet (Foundry anvil key #0) lives at this Vault path.
INSERT INTO wallets (address, vault_path, label) VALUES
  ('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
   'secret/haraledger/signer-keys/deployer',
   'Foundry anvil deployer #0 (L2 dev default)')
ON CONFLICT (address) DO NOTHING;

INSERT INTO wallet_nonces (address) VALUES
  ('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
ON CONFLICT (address) DO NOTHING;

COMMIT;
