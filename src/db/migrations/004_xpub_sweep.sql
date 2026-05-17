-- Migration 004: xpub-based deposit address generation + sweep support

-- ============================================================
-- Extend tenant_configs with xpub and sweep settings
-- ============================================================

ALTER TABLE tenant_configs ADD COLUMN btc_xpub TEXT;
ALTER TABLE tenant_configs ADD COLUMN btc_next_derivation_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_configs ADD COLUMN btc_sweep_threshold_sats TEXT NOT NULL DEFAULT '100000';

-- ============================================================
-- Sweeps table: tracks sweep transactions from customer deposit
-- addresses to tenant hot wallet. Each sweep is prepared as a
-- PSBT, sent to the tenant for signing via webhook, then
-- submitted back and broadcast.
-- ============================================================

CREATE TABLE IF NOT EXISTS sweeps (
  id            TEXT PRIMARY KEY,             -- 'sweep_...'
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  chain_id      TEXT NOT NULL DEFAULT 'bitcoin',
  asset_id      TEXT NOT NULL DEFAULT 'bitcoin:BTC',
  from_addresses TEXT NOT NULL,              -- JSON array of source addresses
  to_address    TEXT NOT NULL,               -- tenant_hot wallet address
  amount_raw    TEXT NOT NULL,               -- total sats to sweep (before fee)
  fee_raw       TEXT,                        -- estimated fee in sats (set when PSBT built)
  psbt          TEXT,                        -- base64 PSBT for tenant to sign
  signed_psbt   TEXT,                        -- signed PSBT returned by tenant
  tx_hash       TEXT,                        -- set after broadcast
  status        TEXT NOT NULL DEFAULT 'pending_signature',
  -- 'pending_signature' | 'submitted' | 'broadcast' | 'confirmed' | 'failed'
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sweeps_tenant        ON sweeps(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sweeps_status        ON sweeps(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sweeps_chain_status  ON sweeps(chain_id, status);
