-- Migration 002: Performance indexes

CREATE INDEX IF NOT EXISTS idx_deposits_chain_address_status
  ON deposits(chain_id, address, status);

CREATE INDEX IF NOT EXISTS idx_deposits_payment_request_id
  ON deposits(payment_request_id);

CREATE INDEX IF NOT EXISTS idx_deposits_tx_hash
  ON deposits(tx_hash);

CREATE INDEX IF NOT EXISTS idx_deposits_wallet_id
  ON deposits(wallet_id);

CREATE INDEX IF NOT EXISTS idx_payment_requests_status_expires
  ON payment_requests(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_payment_requests_address
  ON payment_requests(address);

CREATE INDEX IF NOT EXISTS idx_payment_requests_reference
  ON payment_requests(reference);

CREATE INDEX IF NOT EXISTS idx_payment_requests_wallet_id
  ON payment_requests(wallet_id);

CREATE INDEX IF NOT EXISTS idx_watched_addresses_chain_address
  ON watched_addresses(chain_id, address);

CREATE INDEX IF NOT EXISTS idx_watched_addresses_wallet_id
  ON watched_addresses(wallet_id);

CREATE INDEX IF NOT EXISTS idx_watched_addresses_active
  ON watched_addresses(chain_id, is_active);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_retry
  ON webhook_deliveries(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
  ON webhook_deliveries(webhook_id);

CREATE INDEX IF NOT EXISTS idx_transactions_chain_hash_status
  ON transactions(chain_id, tx_hash, status);

CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions(status);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys(expires_at);

CREATE INDEX IF NOT EXISTS idx_addresses_wallet_id
  ON addresses(wallet_id);

CREATE INDEX IF NOT EXISTS idx_addresses_chain_address
  ON addresses(chain_id, address);

CREATE INDEX IF NOT EXISTS idx_cached_utxos_address
  ON cached_utxos(chain_id, address);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id
  ON ledger_entries(ledger_account_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference
  ON ledger_entries(reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run
  ON jobs(status, next_run_at);
