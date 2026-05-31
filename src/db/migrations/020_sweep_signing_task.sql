-- Migration 020: Link sweeps to signing_tasks
--
-- Adds signing_task_id column to sweeps so the sweep can reference its
-- signing task (mirrors the signing_task_id column on withdrawal_batches).
-- Also adds an index on signing_tasks.sweep_id for fast reverse-lookup.

ALTER TABLE sweeps ADD COLUMN signing_task_id TEXT REFERENCES signing_tasks(id);

CREATE INDEX IF NOT EXISTS idx_signing_tasks_sweep_id ON signing_tasks(sweep_id);
CREATE INDEX IF NOT EXISTS idx_sweeps_signing_task    ON sweeps(signing_task_id);
