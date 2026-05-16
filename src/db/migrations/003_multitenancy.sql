-- Migration 003: Multi-tenancy
-- Adds Tenant, TenantConfig, Customer, AdminKey entities and scopes all
-- existing business tables to a tenant.

-- ============================================================
-- New top-level tables
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,              -- 'tenant_...'
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended' | 'disabled'
  metadata   TEXT,                          -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id                   TEXT PRIMARY KEY REFERENCES tenants(id),
  btc_confirmations_required  INTEGER NOT NULL DEFAULT 1,
  btc_finality_confirmations  INTEGER NOT NULL DEFAULT 6,
  custody_mode                TEXT NOT NULL DEFAULT 'external_signer',
  withdrawal_mode             TEXT NOT NULL DEFAULT 'external_signer',
  daily_withdrawal_limit_sats TEXT,          -- NULL = unlimited
  per_tx_limit_sats           TEXT,          -- NULL = unlimited
  updated_at                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,              -- 'cust_...'
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  reference  TEXT,                          -- external customer ID from tenant system
  status     TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled' | 'frozen'
  metadata   TEXT,                          -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_reference
  ON customers(tenant_id, reference)
  WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_keys (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,          -- SHA-256 of raw admin key
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- ============================================================
-- Scope existing tables to tenant
-- SQLite ALTER TABLE only supports ADD COLUMN; nullable columns are used
-- so existing rows remain valid. Seed will backfill with the default tenant.
-- ============================================================

ALTER TABLE api_keys ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

ALTER TABLE wallets ADD COLUMN tenant_id   TEXT REFERENCES tenants(id);
ALTER TABLE wallets ADD COLUMN wallet_role TEXT NOT NULL DEFAULT 'watch_only';

ALTER TABLE addresses ADD COLUMN tenant_id    TEXT REFERENCES tenants(id);
ALTER TABLE addresses ADD COLUMN customer_id  TEXT REFERENCES customers(id);
ALTER TABLE addresses ADD COLUMN address_role TEXT NOT NULL DEFAULT 'customer_deposit';

ALTER TABLE watched_addresses ADD COLUMN tenant_id   TEXT REFERENCES tenants(id);
ALTER TABLE watched_addresses ADD COLUMN customer_id TEXT REFERENCES customers(id);

ALTER TABLE payment_requests ADD COLUMN tenant_id   TEXT REFERENCES tenants(id);
ALTER TABLE payment_requests ADD COLUMN customer_id TEXT REFERENCES customers(id);

ALTER TABLE deposits ADD COLUMN tenant_id   TEXT REFERENCES tenants(id);
ALTER TABLE deposits ADD COLUMN customer_id TEXT REFERENCES customers(id);

ALTER TABLE transactions ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

ALTER TABLE cached_utxos ADD COLUMN tenant_id   TEXT REFERENCES tenants(id);
ALTER TABLE cached_utxos ADD COLUMN customer_id TEXT REFERENCES customers(id);
ALTER TABLE cached_utxos ADD COLUMN wallet_role TEXT;
ALTER TABLE cached_utxos ADD COLUMN is_locked   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ledger_accounts ADD COLUMN tenant_id     TEXT REFERENCES tenants(id);
ALTER TABLE ledger_accounts ADD COLUMN customer_id   TEXT REFERENCES customers(id);
ALTER TABLE ledger_accounts ADD COLUMN account_type  TEXT NOT NULL DEFAULT 'customer_available';

ALTER TABLE ledger_entries ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

ALTER TABLE webhooks ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

ALTER TABLE webhook_deliveries ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

ALTER TABLE jobs ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

-- ============================================================
-- Recreate idempotency_keys with tenant_id in composite PK
-- (safe: 24-hour TTL cache, data loss on migration is acceptable)
-- ============================================================

CREATE TABLE IF NOT EXISTS idempotency_keys_v2 (
  tenant_id   TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  operation   TEXT NOT NULL,
  result      TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key, operation)
);

INSERT OR IGNORE INTO idempotency_keys_v2
  SELECT '', key, operation, result, status_code, created_at, expires_at
  FROM idempotency_keys;

DROP TABLE idempotency_keys;

ALTER TABLE idempotency_keys_v2 RENAME TO idempotency_keys;

-- ============================================================
-- Indexes for multi-tenant queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tenants_status        ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_customers_tenant      ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_status      ON customers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant       ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallets_tenant        ON wallets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallets_tenant_role   ON wallets(tenant_id, wallet_role);
CREATE INDEX IF NOT EXISTS idx_addresses_tenant      ON addresses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_addresses_customer    ON addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_watched_tenant        ON watched_addresses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_req_tenant    ON payment_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_req_customer  ON payment_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_deposits_tenant       ON deposits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deposits_customer     ON deposits(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant   ON transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cached_utxos_tenant   ON cached_utxos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_acc_tenant     ON ledger_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_acc_customer   ON ledger_accounts(customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ent_tenant     ON ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant       ON webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_tenant  ON webhook_deliveries(tenant_id);
