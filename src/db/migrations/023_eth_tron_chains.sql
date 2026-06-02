-- Migration 023: Add Ethereum and TRON chains + assets
-- Adds chain metadata and token assets for multi-chain support.
-- All entries are disabled by default (is_enabled = 0); operator enables when ready.
--
-- Note: after migrations 007 (chains) and 008 (assets), schema uses specs JSON:
--   chains: specs replaces chain_id + finality_type
--   assets: specs replaces contract_address
--
-- chains.specs format:
--   ETH:  {"finality_type":"safe_finalized","evm_chain_id":1}
--   TRON: {"finality_type":"confirmations","blockTimeSeconds":3}
--
-- assets.specs format:
--   native:  NULL
--   token:   {"contract_address":"0x..."}

-- Ethereum mainnet
INSERT OR IGNORE INTO chains (id, name, type, native_asset, is_enabled, specs, metadata, created_at, updated_at)
VALUES (
  'ethereum', 'Ethereum', 'account', 'ETH', 0,
  '{"finality_type":"safe_finalized","evm_chain_id":1}',
  '{"blockTimeSeconds":12}',
  datetime('now'), datetime('now')
);

-- TRON mainnet
INSERT OR IGNORE INTO chains (id, name, type, native_asset, is_enabled, specs, metadata, created_at, updated_at)
VALUES (
  'tron', 'TRON', 'account', 'TRX', 0,
  '{"finality_type":"confirmations","blockTimeSeconds":3}',
  NULL,
  datetime('now'), datetime('now')
);

-- ETH native asset
INSERT OR IGNORE INTO assets (id, chain_id, symbol, name, type, decimals, is_enabled, specs, metadata, created_at, updated_at)
VALUES ('ethereum:ETH', 'ethereum', 'ETH', 'Ether', 'native', 18, 0, NULL, NULL, datetime('now'), datetime('now'));

-- USDC on Ethereum (ERC-20)
INSERT OR IGNORE INTO assets (id, chain_id, symbol, name, type, decimals, is_enabled, specs, metadata, created_at, updated_at)
VALUES ('ethereum:USDC', 'ethereum', 'USDC', 'USD Coin', 'token', 6, 0,
  '{"contract_address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}', NULL, datetime('now'), datetime('now'));

-- USDT on Ethereum (ERC-20)
INSERT OR IGNORE INTO assets (id, chain_id, symbol, name, type, decimals, is_enabled, specs, metadata, created_at, updated_at)
VALUES ('ethereum:USDT', 'ethereum', 'USDT', 'Tether USD', 'token', 6, 0,
  '{"contract_address":"0xdac17f958d2ee523a2206206994597c13d831ec7"}', NULL, datetime('now'), datetime('now'));

-- TRX native asset
INSERT OR IGNORE INTO assets (id, chain_id, symbol, name, type, decimals, is_enabled, specs, metadata, created_at, updated_at)
VALUES ('tron:TRX', 'tron', 'TRX', 'TRON', 'native', 6, 0, NULL, NULL, datetime('now'), datetime('now'));

-- USDT on TRON (TRC-20)
INSERT OR IGNORE INTO assets (id, chain_id, symbol, name, type, decimals, is_enabled, specs, metadata, created_at, updated_at)
VALUES ('tron:USDT', 'tron', 'USDT', 'Tether USD (TRC-20)', 'token', 6, 0,
  '{"contract_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}', NULL, datetime('now'), datetime('now'));
