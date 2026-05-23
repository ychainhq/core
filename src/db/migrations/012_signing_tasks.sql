-- Migration 012: Signing tasks
-- signing_tasks — one task per batch/sweep/withdrawal requiring external signing

CREATE TABLE IF NOT EXISTS signing_tasks (
  id                   TEXT PRIMARY KEY,    -- 'sigtsk_...'
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  signer_id            TEXT REFERENCES external_signers(id),  -- assigned signer (round-robin)

  request_type         TEXT NOT NULL,       -- 'btc_withdrawal_batch' | 'btc_sweep' | 'evm_withdrawal'
  chain_id             TEXT NOT NULL,
  asset_id             TEXT NOT NULL,

  withdrawal_batch_id  TEXT,               -- soft reference to withdrawal_batches (created in 013)
  sweep_id             TEXT,
  transaction_id       TEXT,

  amount_raw           TEXT NOT NULL,       -- total sats/wei in this signing task
  fee_raw              TEXT,
  fee_rate_sat_vb      TEXT,
  outputs_count        INTEGER,

  payload_format       TEXT NOT NULL,       -- 'btc_psbt' | 'evm_raw_tx'
  unsigned_payload     TEXT NOT NULL,       -- base64 PSBT or hex raw tx
  unsigned_payload_hash TEXT NOT NULL,      -- SHA-256 of unsigned_payload (hex)

  status               TEXT NOT NULL DEFAULT 'created',
  -- 'created' | 'pending_approval' | 'approved' | 'rejected' | 'available'
  -- | 'claimed' | 'signing' | 'signed' | 'submitted' | 'failed' | 'expired' | 'cancelled'

  decision_mode        TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
  decision_reason      TEXT,               -- e.g. 'batch_under_auto_limit'

  claimed_by_signer_id TEXT,
  claimed_at           TEXT,
  expires_at           TEXT,

  signed_payload       TEXT,               -- base64 signed PSBT (set on submit)
  signed_payload_hash  TEXT,
  signer_fingerprint   TEXT,
  signer_response_signature TEXT,
  signed_at            TEXT,

  rejection_reason_code    TEXT,
  rejection_reason_message TEXT,
  rejected_at          TEXT,

  submitted_at         TEXT,
  tx_hash              TEXT,

  failure_code         TEXT,
  failure_message      TEXT,

  retry_count          INTEGER NOT NULL DEFAULT 0,

  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signing_tasks_tenant        ON signing_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signing_tasks_signer        ON signing_tasks(signer_id);
CREATE INDEX IF NOT EXISTS idx_signing_tasks_status        ON signing_tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_signing_tasks_batch         ON signing_tasks(withdrawal_batch_id);
CREATE INDEX IF NOT EXISTS idx_signing_tasks_chain         ON signing_tasks(tenant_id, chain_id, status);
CREATE INDEX IF NOT EXISTS idx_signing_tasks_expires       ON signing_tasks(expires_at) WHERE expires_at IS NOT NULL;
