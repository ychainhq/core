-- Migration 030: ledger_entries deduplication guard for deposit entries
--
-- ensureDepositEntry (called by ChainEventProcessorWorker) uses a SELECT-then-INSERT
-- pattern. In a multi-instance deployment, two workers processing the same
-- chain_event batch (before FOR UPDATE SKIP LOCKED was introduced) could both
-- pass the existence check and both call addEntry for the same deposit — resulting
-- in two ledger entries for the same deposit and a doubled balance.
--
-- This partial unique index is the database-level safety net:
--   - Covers (deposit_pending, deposit_settled) entries with reference_type='deposit'
--   - If a concurrent INSERT slips through, the DB rejects the duplicate
--   - The existing catch block in ensureDepositEntry absorbs the constraint error
--
-- Partial index (WHERE reference_type = 'deposit') avoids touching other entry
-- types (withdrawal, transfer_in, transfer_out) which legitimately repeat.
--
-- Works in both SQLite 3.25+ and PostgreSQL 9.5+.

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_deposit_dedup
  ON ledger_entries(ledger_account_id, type, reference_id)
  WHERE reference_type = 'deposit';
