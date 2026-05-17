-- Migration 005: customer-initiated withdrawals

CREATE TABLE IF NOT EXISTS customer_withdrawals (
  id              TEXT PRIMARY KEY,             -- 'wd_...'
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  chain_id        TEXT NOT NULL DEFAULT 'bitcoin',
  asset_id        TEXT NOT NULL DEFAULT 'bitcoin:BTC',
  to_address      TEXT NOT NULL,
  amount_raw      TEXT NOT NULL,               -- sats requested by customer
  fee_raw         TEXT,                        -- fee in sats (set when PSBT built)
  psbt            TEXT,                        -- base64 PSBT sent for signing
  signed_psbt     TEXT,
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending_signature',
  -- 'pending_signature' | 'broadcast' | 'confirmed' | 'failed'
  error           TEXT,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cw_tenant    ON customer_withdrawals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cw_customer  ON customer_withdrawals(customer_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cw_idempotency
  ON customer_withdrawals(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
