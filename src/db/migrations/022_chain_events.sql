-- Migration 022: Chain events + indexer checkpoints (v3 block indexer)
--
-- chain_events is filled by btc-indexer (packages/btc-indexer), NOT by engine workers.
-- Engine workers only UPDATE processed=TRUE and read events for business logic.
--
-- Ownership rule: INSERT on chain_events belongs exclusively to btc-indexer.
-- Engine owns: UPDATE chain_events SET processed=TRUE (via chain-events.service).
--
-- event_type values:
--   'utxo_created' — new UTXO on a watched address (mempool or confirmed block)
--   'utxo_spent'   — watched UTXO was spent (tracked for sweep/withdrawal confirmation)
--
-- Deduplication: multiple indexer instances watching different nodes will all report
-- the same on-chain events. UNIQUE constraint ensures only the first INSERT wins;
-- subsequent INSERTs from other indexers are silently ignored (ON CONFLICT DO NOTHING).
--
-- Multi-chain ready: chain_id + contract_address covers ETH native, ERC-20, TRC-20.

CREATE TABLE IF NOT EXISTS chain_events (
  id               TEXT PRIMARY KEY,         -- 'cevt_...' (nanoid, set by indexer)
  chain_id         TEXT NOT NULL DEFAULT 'bitcoin',
  node_id          TEXT NOT NULL,            -- which indexer/node reported this event
  event_type       TEXT NOT NULL,            -- 'utxo_created' | 'utxo_spent'
  tx_hash          TEXT NOT NULL,
  vout_index       INTEGER,                  -- output index; NULL for utxo_spent events
  spent_tx_hash    TEXT,                     -- the tx being spent; NULL for utxo_created
  spent_vout       INTEGER,                  -- the vout being spent; NULL for utxo_created
  address          TEXT,                     -- recipient address; NULL for utxo_spent
  amount_raw       TEXT,                     -- satoshi as string; NULL for utxo_spent
  contract_address TEXT,                     -- NULL for BTC/ETH native; token contract for ERC-20/TRC-20
  log_index        INTEGER,                  -- EVM event log index for deduplication; NULL for BTC
  block_height     INTEGER,                  -- NULL = mempool (0-conf detection)
  block_hash       TEXT,
  confirmations    INTEGER NOT NULL DEFAULT 0,
  processed        INTEGER NOT NULL DEFAULT 0,  -- 0=pending, 1=processed
  processed_at     TEXT,
  created_at       TEXT NOT NULL,

  -- Deduplication across multiple indexer instances.
  -- utxo_created: unique per (chain_id, tx_hash, vout_index, event_type).
  -- utxo_spent:   unique per (chain_id, tx_hash, spent_tx_hash, spent_vout, event_type).
  -- Both columns are NULL for the other event type, so the compound key is distinct.
  UNIQUE(chain_id, tx_hash, vout_index, spent_tx_hash, spent_vout, event_type, log_index)
);

-- Primary access pattern: fetch unprocessed events in order
CREATE INDEX IF NOT EXISTS idx_chain_events_pending
  ON chain_events(chain_id, created_at)
  WHERE processed = 0;

-- Lookup by address for debugging / manual reconciliation
CREATE INDEX IF NOT EXISTS idx_chain_events_address
  ON chain_events(address)
  WHERE address IS NOT NULL;

-- Lookup spent events for sweep/withdrawal confirmation
CREATE INDEX IF NOT EXISTS idx_chain_events_spent
  ON chain_events(spent_tx_hash, spent_vout)
  WHERE event_type = 'utxo_spent';

-- Per-indexer scanning checkpoint. Each btc-indexer instance records
-- the last processed block height so it can resume after restart.

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  node_id          TEXT PRIMARY KEY,         -- matches chain_events.node_id
  chain_id         TEXT NOT NULL DEFAULT 'bitcoin',
  last_height      INTEGER NOT NULL DEFAULT 0,
  last_block_hash  TEXT,
  updated_at       TEXT NOT NULL
);
