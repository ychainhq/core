-- Per-tenant BTC fee target blocks for fee estimation.
-- Used by SweepWorker and any future workers that call estimateFeeRateSatVb
-- without a more specific per-operation config.
-- Default 6 matches the historical hardcoded value in sweep.worker.ts.
ALTER TABLE tenant_configs
  ADD COLUMN btc_fee_target_blocks INTEGER NOT NULL DEFAULT 6;
