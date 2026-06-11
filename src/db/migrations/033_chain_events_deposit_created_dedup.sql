-- Migration 033: Deduplicate account/token deposit_created chain events
--
-- TRON/TRC-20 and other account/token chains do not have BTC vout indexes.
-- They identify token transfers by tx_hash + contract_address + log_index.
-- This partial unique index lets multiple local node indexers race safely while
-- preserving one logical chain_event per token transfer.

DELETE FROM chain_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM chain_events
  WHERE event_type = 'deposit_created'
    AND log_index IS NOT NULL
  GROUP BY chain_id, tx_hash, contract_address, log_index, event_type
)
AND event_type = 'deposit_created'
AND log_index IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_events_deposit_created_token
  ON chain_events(chain_id, tx_hash, contract_address, log_index, event_type)
  WHERE event_type = 'deposit_created' AND log_index IS NOT NULL;

DELETE FROM chain_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM chain_events
  WHERE event_type = 'deposit_created'
    AND log_index IS NULL
  GROUP BY chain_id, tx_hash, address, amount_raw, event_type
)
AND event_type = 'deposit_created'
AND log_index IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_events_deposit_created_native
  ON chain_events(chain_id, tx_hash, address, amount_raw, event_type)
  WHERE event_type = 'deposit_created' AND log_index IS NULL;
