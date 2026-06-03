-- Migration 025: Fix chain_events deduplication with partial unique indexes
--
-- Root cause: the original UNIQUE(chain_id, tx_hash, vout_index, spent_tx_hash, ...)
-- constraint does NOT deduplicate rows where NULL columns differ, because
-- in both SQLite and PostgreSQL a UNIQUE index considers NULL != NULL — so two rows
-- where spent_tx_hash IS NULL are treated as distinct keys.
--
-- Two indexers on different nodes (btc-node-1, btc-node-2) watching the same
-- mempool can therefore both insert the same utxo_created event and
-- ON CONFLICT DO NOTHING never fires.
--
-- Fix: add two PARTIAL unique indexes scoped to the relevant non-NULL columns
-- for each event type. Partial indexes exclude NULL columns from the key,
-- eliminating the NULL != NULL problem.
--
-- The old compound UNIQUE stays (harmless but ineffective). The partial
-- indexes take over deduplication. ON CONFLICT DO NOTHING checks all indexes,
-- so the new indexes will catch duplicates going forward.
--
-- Works in both SQLite (3.8+) and PostgreSQL.

-- 1. Deduplicate existing rows before creating the indexes.
--    Keep the earliest inserted row (MIN id) per logical event.
DELETE FROM chain_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM chain_events
  WHERE spent_tx_hash IS NULL
  GROUP BY chain_id, tx_hash, vout_index, event_type
)
AND spent_tx_hash IS NULL;

DELETE FROM chain_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM chain_events
  WHERE spent_tx_hash IS NOT NULL
  GROUP BY chain_id, spent_tx_hash, spent_vout, event_type
)
AND spent_tx_hash IS NOT NULL;

-- 2. Create partial unique indexes for proper deduplication.
--    utxo_created: unique per (chain_id, tx_hash, vout_index, event_type) — no spent columns.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_events_utxo_created
  ON chain_events(chain_id, tx_hash, vout_index, event_type)
  WHERE spent_tx_hash IS NULL;

--    utxo_spent: unique per (chain_id, spent_tx_hash, spent_vout, event_type).
CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_events_utxo_spent
  ON chain_events(chain_id, spent_tx_hash, spent_vout, event_type)
  WHERE spent_tx_hash IS NOT NULL;
