-- Migration 019: Internal transfer support for on-platform withdrawal routing
-- Adds withdrawal_type to distinguish between external (on-chain) and internal (ledger-only) withdrawals.
-- recipient_customer_id is set only for internal transfers.

ALTER TABLE customer_withdrawals ADD COLUMN withdrawal_type TEXT NOT NULL DEFAULT 'external';
ALTER TABLE customer_withdrawals ADD COLUMN recipient_customer_id TEXT REFERENCES customers(id);

CREATE INDEX idx_cust_withdrawals_type ON customer_withdrawals(tenant_id, withdrawal_type);
