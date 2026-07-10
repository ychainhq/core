-- Migration 040: Scalable TRON sweep architecture
--
-- Adds:
--   tron_usdt_sweep_threshold_sun — USDT sweep threshold (copies from deprecated tron_sweep_threshold_sun)
--   tron_trx_sweep_threshold_sun  — TRX sweep threshold (new)
--   tron_staked_energy_sun        — TRX staked for Stake 2.0 energy delegation (null = disabled)
--   tron_sweep_queue              — event-driven sweep queue (O(active) not O(all addresses))
--
-- tron_sweep_threshold_sun is kept for one release cycle (backward compat) and removed in migration 042.

ALTER TABLE tenant_configs ADD COLUMN tron_usdt_sweep_threshold_sun TEXT DEFAULT NULL;
ALTER TABLE tenant_configs ADD COLUMN tron_trx_sweep_threshold_sun  TEXT DEFAULT NULL;
ALTER TABLE tenant_configs ADD COLUMN tron_staked_energy_sun        TEXT DEFAULT NULL;

-- Copy existing USDT threshold data from deprecated column
UPDATE tenant_configs
  SET tron_usdt_sweep_threshold_sun = tron_sweep_threshold_sun
  WHERE tron_sweep_threshold_sun IS NOT NULL;

-- Event-driven sweep queue: populated by TronSweepQueueFeeder when balance crosses threshold.
-- Drained by TronSweepWorker (SKIP LOCKED for active-active concurrency).
-- Primary key prevents duplicate entries per (address, asset_id) pair.
CREATE TABLE tron_sweep_queue (
  address               TEXT    NOT NULL,
  tenant_id             TEXT    NOT NULL,
  asset_id              TEXT    NOT NULL,          -- 'tron:TRX' | 'tron:USDT'
  estimated_balance_raw TEXT    NOT NULL,          -- snapshot at queue time (re-verified before sweep)
  priority              INTEGER NOT NULL DEFAULT 0, -- 0=normal 1=high 2=urgent
  queued_at             TEXT    NOT NULL,
  PRIMARY KEY (address, asset_id)
);

-- Worker drains highest-priority oldest entries first
CREATE INDEX idx_tron_sweep_queue_work
  ON tron_sweep_queue(priority DESC, queued_at ASC);

-- QueueFeeder queries per tenant to check existing entries
CREATE INDEX idx_tron_sweep_queue_tenant
  ON tron_sweep_queue(tenant_id, asset_id);

-- Active energy delegations: tracks which deposit addresses have energy delegated
-- so TronEnergyReclaimWorker can undelegate after sweep confirms.
CREATE TABLE tron_energy_delegations (
  address          TEXT NOT NULL PRIMARY KEY,   -- deposit address receiving energy
  tenant_id        TEXT NOT NULL,
  delegated_at     TEXT NOT NULL,               -- ISO timestamp of delegation
  delegation_sun   TEXT NOT NULL,               -- amount delegated (TRX in sun)
  sweep_id         TEXT DEFAULT NULL            -- linked sweep (set after sweep created)
);

CREATE INDEX idx_tron_energy_delegations_tenant
  ON tron_energy_delegations(tenant_id);
CREATE INDEX idx_tron_energy_delegations_sweep
  ON tron_energy_delegations(sweep_id);
