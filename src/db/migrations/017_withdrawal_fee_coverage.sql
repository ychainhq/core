-- Migration 017: Add withdrawal_fee_coverage to tenant_withdrawal_batch_configs
-- Values: 'tenant_pays' | 'sender_pays' | 'recipient_pays'
-- tenant_pays   = fee deducted from hot wallet, recipient gets full amount_raw
-- sender_pays   = customer balance debited amount_raw + fee, recipient gets amount_raw
-- recipient_pays = customer balance debited amount_raw, recipient gets amount_raw - fee

ALTER TABLE tenant_withdrawal_batch_configs
  ADD COLUMN withdrawal_fee_coverage TEXT NOT NULL DEFAULT 'tenant_pays';
