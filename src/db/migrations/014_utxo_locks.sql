-- Migration 014: UTXO locks
-- utxo_locks — TTL-based UTXO reservation for batch building
-- Note: cached_utxos already has tenant_id, wallet_role, is_locked from migration 003

CREATE TABLE IF NOT EXISTS utxo_locks (
  id            TEXT PRIMARY KEY,           -- 'ulk_...'
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  batch_id      TEXT NOT NULL REFERENCES withdrawal_batches(id),

  chain_id      TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  vout          INTEGER NOT NULL,
  amount_raw    TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'locked',  -- 'locked' | 'released' | 'spent'
  locked_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  released_at   TEXT,

  UNIQUE(chain_id, tx_hash, vout)
);

CREATE INDEX IF NOT EXISTS idx_utxo_locks_tenant  ON utxo_locks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_utxo_locks_batch   ON utxo_locks(batch_id);
CREATE INDEX IF NOT EXISTS idx_utxo_locks_expires ON utxo_locks(expires_at) WHERE status = 'locked';
CREATE INDEX IF NOT EXISTS idx_utxo_locks_utxo    ON utxo_locks(chain_id, tx_hash, vout);
