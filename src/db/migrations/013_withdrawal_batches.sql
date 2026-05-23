-- Migration 013: Withdrawal batches
-- withdrawal_batches, withdrawal_batch_items, tenant_withdrawal_batch_configs

-- ============================================================
-- Withdrawal batches — one PSBT per batch
-- ============================================================

CREATE TABLE IF NOT EXISTS withdrawal_batches (
  id                     TEXT PRIMARY KEY,  -- 'wdb_...'
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),

  chain_id               TEXT NOT NULL,
  asset_id               TEXT NOT NULL,

  status                 TEXT NOT NULL DEFAULT 'building',
  -- 'building' | 'pending_approval' | 'approved' | 'rejected'
  -- | 'pending_signature' | 'signed' | 'broadcasting' | 'broadcast'
  -- | 'confirmed' | 'failed' | 'failed_fee_sanity' | 'cancelled' | 'replaced' | 'expired'

  outputs_count          INTEGER NOT NULL DEFAULT 0,
  total_output_raw       TEXT NOT NULL DEFAULT '0',
  fee_raw                TEXT,
  fee_rate_sat_vb        TEXT,

  psbt                   TEXT,              -- base64 unsigned PSBT
  signed_psbt            TEXT,
  raw_tx                 TEXT,
  tx_hash                TEXT,

  rbf_enabled            INTEGER NOT NULL DEFAULT 1,
  sequence               INTEGER,           -- BIP125 opt-in RBF sequence

  signing_task_id        TEXT REFERENCES signing_tasks(id),
  signer_id              TEXT REFERENCES external_signers(id),

  decision_mode          TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual'
  approved_by            TEXT,
  approved_at            TEXT,

  attempt_count          INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,

  replaced_by_batch_id   TEXT,              -- new batch for RBF
  replacement_of_batch_id TEXT,             -- original batch this replaces

  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  broadcast_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_wb_tenant        ON withdrawal_batches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wb_status        ON withdrawal_batches(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wb_chain         ON withdrawal_batches(tenant_id, chain_id, status);
CREATE INDEX IF NOT EXISTS idx_wb_signing_task  ON withdrawal_batches(signing_task_id);

-- ============================================================
-- Batch items — one row per withdrawal in a batch
-- ============================================================

CREATE TABLE IF NOT EXISTS withdrawal_batch_items (
  batch_id       TEXT NOT NULL REFERENCES withdrawal_batches(id),
  withdrawal_id  TEXT NOT NULL REFERENCES customer_withdrawals(id),
  output_index   INTEGER,                   -- index in the PSBT/tx outputs
  amount_raw     TEXT NOT NULL,
  to_address     TEXT NOT NULL,

  PRIMARY KEY (batch_id, withdrawal_id)
);

CREATE INDEX IF NOT EXISTS idx_wbi_batch      ON withdrawal_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_wbi_withdrawal ON withdrawal_batch_items(withdrawal_id);

-- ============================================================
-- Per-tenant batching configuration
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_withdrawal_batch_configs (
  tenant_id                         TEXT PRIMARY KEY REFERENCES tenants(id),

  btc_batching_enabled              INTEGER NOT NULL DEFAULT 1,
  btc_batch_interval_seconds        INTEGER NOT NULL DEFAULT 300,
  btc_max_outputs_per_batch         INTEGER NOT NULL DEFAULT 200,
  btc_min_outputs_per_batch         INTEGER NOT NULL DEFAULT 1,
  btc_max_batch_age_seconds         INTEGER NOT NULL DEFAULT 300,

  btc_max_batch_total_sats          TEXT,   -- NULL = unlimited
  btc_max_single_withdrawal_sats    TEXT,   -- NULL = unlimited
  btc_min_withdrawal_sats           TEXT,   -- NULL = no minimum

  btc_fee_policy                    TEXT NOT NULL DEFAULT 'target_blocks',
  btc_target_blocks                 INTEGER NOT NULL DEFAULT 6,
  btc_max_fee_rate_sat_vb           INTEGER NOT NULL DEFAULT 50,
  btc_min_fee_rate_sat_vb           INTEGER,
  btc_fee_sanity_max_fee_sats       TEXT,
  btc_fee_sanity_max_fee_percent_bps INTEGER,

  btc_dust_policy                   TEXT NOT NULL DEFAULT 'reject',  -- 'reject' | 'manual_review' | 'aggregate'
  btc_change_address_policy         TEXT NOT NULL DEFAULT 'tenant_hot_change',

  btc_rbf_enabled                   INTEGER NOT NULL DEFAULT 1,
  btc_rbf_strategy                  TEXT NOT NULL DEFAULT 'opt_in',  -- 'opt_in' | 'full'
  btc_cpfp_enabled                  INTEGER NOT NULL DEFAULT 0,

  btc_batch_retry_max_attempts      INTEGER NOT NULL DEFAULT 3,
  btc_batch_retry_backoff_seconds   INTEGER NOT NULL DEFAULT 60,

  updated_at                        TEXT NOT NULL
);
