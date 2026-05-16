-- Migration 001: Initial schema
-- Creates all core tables for the Chain API

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chains (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,           -- 'utxo' | 'account'
  native_asset  TEXT NOT NULL,           -- 'BTC', 'ETH'
  chain_id      INTEGER,                 -- NULL for BTC, 1 for ETH mainnet
  finality_type TEXT NOT NULL,           -- 'confirmations' | 'safe_finalized'
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  metadata      TEXT,                    -- JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id               TEXT PRIMARY KEY,     -- 'bitcoin:BTC', 'ethereum:USDC'
  chain_id         TEXT NOT NULL REFERENCES chains(id),
  symbol           TEXT NOT NULL,        -- 'BTC', 'USDC'
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,        -- 'native' | 'token'
  contract_address TEXT,                 -- NULL for native, '0x...' for ERC-20
  decimals         INTEGER NOT NULL,     -- 8 for BTC, 6 for USDC, 18 for ETH
  is_enabled       INTEGER NOT NULL DEFAULT 1,
  metadata         TEXT,                 -- JSON
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id          TEXT PRIMARY KEY,          -- 'wallet_...'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,             -- 'watch_only' | 'external_signer'
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id           TEXT PRIMARY KEY,         -- 'addr_...'
  wallet_id    TEXT NOT NULL REFERENCES wallets(id),
  chain_id     TEXT NOT NULL REFERENCES chains(id),
  address      TEXT NOT NULL,
  label        TEXT,
  address_type TEXT,                     -- 'p2wpkh', 'p2sh', 'p2pkh', 'p2tr'
  status       TEXT NOT NULL DEFAULT 'active',
  metadata     TEXT,                     -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(chain_id, address)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,          -- 'wh_...'
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,             -- JSON array of event types
  chains      TEXT,                      -- JSON array, NULL = all
  wallet_id   TEXT REFERENCES wallets(id),
  secret      TEXT NOT NULL,             -- HMAC secret
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watched_addresses (
  id          TEXT PRIMARY KEY,          -- 'mon_...'
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  address     TEXT NOT NULL,
  wallet_id   TEXT REFERENCES wallets(id),
  label       TEXT,
  events      TEXT NOT NULL DEFAULT '["incoming"]',  -- JSON array
  webhook_id  TEXT REFERENCES webhooks(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(chain_id, address)
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id                     TEXT PRIMARY KEY,   -- 'payreq_...'
  chain_id               TEXT NOT NULL REFERENCES chains(id),
  asset_id               TEXT NOT NULL REFERENCES assets(id),
  wallet_id              TEXT REFERENCES wallets(id),
  address                TEXT NOT NULL,
  amount_raw             TEXT NOT NULL,      -- satoshi as string
  amount_display         TEXT NOT NULL,      -- '0.001' BTC
  reference              TEXT,
  status                 TEXT NOT NULL DEFAULT 'created',
  expires_at             TEXT,               -- ISO8601
  confirmations_required INTEGER NOT NULL DEFAULT 1,
  qr_payload             TEXT,              -- BIP-21 URI
  metadata               TEXT,              -- JSON
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id                  TEXT PRIMARY KEY,      -- 'dep_...'
  chain_id            TEXT NOT NULL REFERENCES chains(id),
  asset_id            TEXT NOT NULL REFERENCES assets(id),
  wallet_id           TEXT REFERENCES wallets(id),
  address             TEXT NOT NULL,
  amount_raw          TEXT NOT NULL,         -- satoshi as string
  amount_display      TEXT NOT NULL,
  tx_hash             TEXT NOT NULL,
  vout                INTEGER,               -- BTC output index
  block_height        INTEGER,               -- NULL if unconfirmed
  block_hash          TEXT,
  confirmations       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'detected',
  payment_request_id  TEXT REFERENCES payment_requests(id),
  metadata            TEXT,                  -- JSON
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,            -- 'tx_...'
  chain_id      TEXT NOT NULL REFERENCES chains(id),
  tx_hash       TEXT,
  raw_tx        TEXT,                        -- hex encoded
  psbt          TEXT,                        -- base64 if PSBT
  status        TEXT NOT NULL DEFAULT 'prepared',
  block_height  INTEGER,
  block_hash    TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  fee_raw       TEXT,                        -- satoshi
  fee_rate      TEXT,                        -- sat/vbyte
  wallet_id     TEXT REFERENCES wallets(id),
  broadcast_at  TEXT,
  metadata      TEXT,                        -- JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_utxos (
  id             TEXT PRIMARY KEY,           -- 'utxo_...'
  chain_id       TEXT NOT NULL REFERENCES chains(id),
  address        TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  vout           INTEGER NOT NULL,
  amount_raw     TEXT NOT NULL,              -- satoshi
  script_pub_key TEXT,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  is_spent       INTEGER NOT NULL DEFAULT 0,
  wallet_id      TEXT REFERENCES wallets(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          TEXT PRIMARY KEY,              -- 'lacc_...'
  wallet_id   TEXT REFERENCES wallets(id),
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  asset_id    TEXT NOT NULL REFERENCES assets(id),
  name        TEXT NOT NULL,
  metadata    TEXT,                          -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                   TEXT PRIMARY KEY,     -- 'lent_...'
  ledger_account_id    TEXT NOT NULL REFERENCES ledger_accounts(id),
  type                 TEXT NOT NULL,        -- 'deposit_pending' | 'deposit_settled' | 'withdrawal' | 'transfer_in' | 'transfer_out'
  amount_raw           TEXT NOT NULL,        -- satoshi, signed: positive = credit, negative = debit
  reference_type       TEXT,                 -- 'deposit' | 'transaction' | 'transfer'
  reference_id         TEXT,
  balance_pending_raw  TEXT NOT NULL,        -- running balance pending after entry
  balance_settled_raw  TEXT NOT NULL,        -- running balance settled after entry
  metadata             TEXT,                 -- JSON
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,            -- 'wdlv_...'
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
  event_id      TEXT NOT NULL,               -- 'evt_...'
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,               -- JSON string
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TEXT,
  delivered_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT NOT NULL,
  operation   TEXT NOT NULL,                 -- 'payment_request' | 'broadcast' | 'webhook' | 'ledger_transfer'
  result      TEXT NOT NULL,                 -- JSON serialized response
  status_code INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (key, operation)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,         -- SHA-256 hash of actual key
  name         TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                -- 'deposit_check' | 'webhook_delivery'
  status       TEXT NOT NULL DEFAULT 'pending',
  payload      TEXT NOT NULL,               -- JSON
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at  TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
