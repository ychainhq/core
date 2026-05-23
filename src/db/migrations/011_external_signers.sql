-- Migration 011: External Signer Registry
-- external_signers, external_signer_policies, signer_signature_audit, signer_events

-- ============================================================
-- Signer registry — one row per registered signer daemon
-- ============================================================

CREATE TABLE IF NOT EXISTS external_signers (
  id                     TEXT PRIMARY KEY,        -- 'sgn_...'
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),

  name                   TEXT NOT NULL,
  edition                TEXT NOT NULL DEFAULT 'community', -- 'community' | 'enterprise'
  status                 TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'active' | 'disabled' | 'unhealthy' | 'suspended' | 'rotating_key' | 'revoked'
  is_enabled             INTEGER NOT NULL DEFAULT 1,

  connectivity_mode      TEXT NOT NULL DEFAULT 'polling',   -- 'polling' | 'callback'
  security_level         TEXT NOT NULL DEFAULT 'basic',     -- 'basic' | 'hardened' | 'regulated'
  key_provider           TEXT NOT NULL DEFAULT 'local_file', -- 'local_file' | 'env' | 'vault' | 'hsm' | 'kms'

  public_key             TEXT NOT NULL,           -- ed25519 or similar public key
  signer_fingerprint     TEXT NOT NULL,           -- unique identifier for signer key material
  client_cert_fingerprint TEXT,                   -- mTLS certificate fingerprint (enterprise)

  capabilities           TEXT NOT NULL,           -- JSON: { chains, assets, formats }
  last_seen_at           TEXT,
  last_health_status     TEXT,                    -- 'healthy' | 'degraded' | 'unhealthy'
  last_error             TEXT,

  round_robin_weight     INTEGER NOT NULL DEFAULT 1,
  round_robin_cursor     INTEGER NOT NULL DEFAULT 0,

  metadata               TEXT,                    -- JSON, arbitrary tenant data
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  UNIQUE(tenant_id, signer_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_ext_signers_tenant        ON external_signers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ext_signers_tenant_status ON external_signers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ext_signers_tenant_enabled ON external_signers(tenant_id, is_enabled);

-- ============================================================
-- Signer policies — precedence: signer+asset > signer+chain > signer > tenant+asset > tenant+chain > tenant
-- ============================================================

CREATE TABLE IF NOT EXISTS external_signer_policies (
  id                         TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
  signer_id                  TEXT REFERENCES external_signers(id),  -- NULL = tenant-level policy

  chain_id                   TEXT,               -- NULL = all chains
  asset_id                   TEXT,               -- NULL = all assets

  auto_sign_limit_raw        TEXT,               -- auto-sign if batch total <= this (sats/wei)
  manual_approval_from_raw   TEXT,               -- require manual approval if > this
  daily_auto_sign_limit_raw  TEXT,               -- daily cap for auto-sign
  max_signatures_per_hour    INTEGER,

  max_fee_rate_sat_vb        INTEGER,
  max_outputs_per_batch      INTEGER,
  destination_allowlist      TEXT,               -- JSON array of allowed destination addresses
  contract_allowlist         TEXT,               -- JSON array of allowed EVM contract addresses

  is_enabled                 INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signer_policies_tenant   ON external_signer_policies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signer_policies_signer   ON external_signer_policies(signer_id);

-- ============================================================
-- Signature audit — append-only, every signing event
-- ============================================================

CREATE TABLE IF NOT EXISTS signer_signature_audit (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id),
  signing_task_id          TEXT NOT NULL,   -- soft ref to signing_tasks (created in 012)
  signer_id                TEXT REFERENCES external_signers(id),

  decision_mode            TEXT NOT NULL,         -- 'auto' | 'manual'
  approved_by              TEXT,                  -- actor_id if manual approval
  signed_by_actor_type     TEXT NOT NULL,         -- 'signer_daemon' | 'manual'
  signed_by_actor_id       TEXT,

  chain_id                 TEXT NOT NULL,
  asset_id                 TEXT NOT NULL,
  amount_raw               TEXT NOT NULL,

  unsigned_payload_hash    TEXT NOT NULL,
  signed_payload_hash      TEXT,
  tx_hash                  TEXT,

  signature_result         TEXT NOT NULL,         -- 'signed' | 'rejected' | 'failed' | 'expired'
  signer_response_signature TEXT,

  error_code               TEXT,
  error_message            TEXT,

  ip_address               TEXT,
  user_agent               TEXT,
  created_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sig_audit_tenant      ON signer_signature_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sig_audit_signer      ON signer_signature_audit(signer_id);
CREATE INDEX IF NOT EXISTS idx_sig_audit_task        ON signer_signature_audit(signing_task_id);
CREATE INDEX IF NOT EXISTS idx_sig_audit_tx          ON signer_signature_audit(tx_hash);
