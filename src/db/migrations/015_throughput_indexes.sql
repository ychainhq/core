-- Migration 015: Throughput indexes
-- Adds covering indexes for the high-volume worker paths without changing storage technology.

CREATE INDEX IF NOT EXISTS idx_cached_utxos_tenant_chain_outpoint
  ON cached_utxos(tenant_id, chain_id, tx_hash, vout);

CREATE INDEX IF NOT EXISTS idx_cached_utxos_tenant_chain_role_available
  ON cached_utxos(tenant_id, chain_id, wallet_role, is_spent, is_locked, confirmations);

CREATE INDEX IF NOT EXISTS idx_addresses_tenant_chain_address
  ON addresses(tenant_id, chain_id, address);

CREATE INDEX IF NOT EXISTS idx_addresses_tenant_chain_role
  ON addresses(tenant_id, chain_id, address_role, status);

CREATE INDEX IF NOT EXISTS idx_payment_requests_tenant_chain_address_status
  ON payment_requests(tenant_id, chain_id, address, status);

CREATE INDEX IF NOT EXISTS idx_deposits_tenant_chain_outpoint
  ON deposits(tenant_id, chain_id, tx_hash, vout);

CREATE INDEX IF NOT EXISTS idx_cw_tenant_chain_status_created
  ON customer_withdrawals(tenant_id, chain_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_status_retry
  ON webhook_deliveries(tenant_id, status, next_retry_at);
