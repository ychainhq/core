-- Migration 026: Fix deposits deduplication for nullable vout
--
-- Root cause: UNIQUE(chain_id, tx_hash, vout) on the deposits table
-- does not prevent duplicates when vout IS NULL, because PostgreSQL (and
-- SQLite) treat NULL != NULL in unique index comparisons.
--
-- vout is nullable by design: UTXO chains (Bitcoin) always have a vout
-- (output index 0, 1, 2…), while account-based chains (Ethereum, TRON)
-- do not use vout. For account-based chains vout would be NULL, and two
-- rows with the same chain_id + tx_hash + NULL vout could both insert.
--
-- Fix: replace the compound UNIQUE with two partial unique indexes:
--   • utxo-based  (vout IS NOT NULL): dedup on (chain_id, tx_hash, vout)
--   • account-based (vout IS NULL):   dedup on (chain_id, tx_hash)
--     (one deposit per tx for account chains — eth native transfers,
--      ERC-20 with multiple logs will need a log_index column in a later migration)
--
-- The old compound UNIQUE is effectively non-functional for NULL vout rows;
-- the new partial indexes take over without requiring a DROP in SQLite.

-- 1. No duplicate deposits are expected in practice (Bitcoin always has vout),
--    but defensively clean up any that somehow crept in.
DELETE FROM deposits
WHERE id NOT IN (
  SELECT MIN(id)
  FROM deposits
  WHERE vout IS NOT NULL
  GROUP BY chain_id, tx_hash, vout
)
AND vout IS NOT NULL;

DELETE FROM deposits
WHERE id NOT IN (
  SELECT MIN(id)
  FROM deposits
  WHERE vout IS NULL
  GROUP BY chain_id, tx_hash
)
AND vout IS NULL;

-- 2. Create partial unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_utxo_dedup
  ON deposits(chain_id, tx_hash, vout)
  WHERE vout IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_account_dedup
  ON deposits(chain_id, tx_hash)
  WHERE vout IS NULL;
