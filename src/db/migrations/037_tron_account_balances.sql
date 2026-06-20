-- Migration 037: Add tron_account_balances table for scalable TRON balance caching
--
-- Written by: tron-indexer (BalanceUpdater, after detecting on-chain activity)
--             TronBalanceRefreshWorker (engine, staleness safety net)
-- Read by:    tronBalancesService (engine, O(1) SUM query per wallet)
--
-- balance_raw — amount in sun (TRX) or micro-USDT (USDT), stored as TEXT (BigInt safety)
-- updated_at  — epoch milliseconds; used for staleness detection (stale if > 10 min old)
-- block_number — last block at which the balance was fetched from the chain node

CREATE TABLE IF NOT EXISTS tron_account_balances (
  address      TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  balance_raw  TEXT NOT NULL DEFAULT '0',
  block_number INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (address, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_tron_balances_updated
  ON tron_account_balances (updated_at);
