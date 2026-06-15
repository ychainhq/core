-- Migration 036: Add tron_usdt_withdrawal_fee to tenant_withdrawal_batch_configs
--
-- tron_usdt_withdrawal_fee — fixed fee charged to the customer per USDT TRC-20 withdrawal,
--   expressed in micro-USDT (6 decimal places, BigInt string). Default 0 = tenant absorbs gas cost.
--
-- This is the CUSTOMER-FACING fee in USDT (separate from the on-chain TRX gas cost which
-- is always paid by the platform hot wallet regardless of this setting).
--
-- Examples:
--   '0'       — tenant_pays; platform absorbs gas in TRX, customer pays nothing extra
--   '1000000' — 1.000000 USDT per withdrawal (covers gas + platform margin)
--   '500000'  — 0.500000 USDT per withdrawal
--
-- Combined with withdrawal_fee_coverage:
--   tenant_pays:    tron_usdt_withdrawal_fee is ignored (always 0 effective)
--   sender_pays:    debit (amount + fee) from sender ledger; send full amount to recipient
--   recipient_pays: debit amount from sender; send (amount - fee) to recipient on-chain

ALTER TABLE tenant_withdrawal_batch_configs
  ADD COLUMN tron_usdt_withdrawal_fee TEXT NOT NULL DEFAULT '0';
