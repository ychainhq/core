-- Migration 038: Fix tron_account_balances.updated_at column type
--
-- updated_at stores Date.now() (epoch milliseconds, ~1.78e12 in 2026).
-- PostgreSQL INTEGER is 32-bit (max ~2.1e9) — overflow on every write.
-- SQLite silently stored it as 64-bit int, masking the bug in tests.

ALTER TABLE tron_account_balances ALTER COLUMN updated_at TYPE BIGINT;
