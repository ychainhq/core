-- Migration 011b: Signer events (separate file to avoid FK ordering issue with signing_tasks)
-- signer_events — append-only hash-chain event log

CREATE TABLE IF NOT EXISTS signer_events (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  signer_id            TEXT REFERENCES external_signers(id),
  signing_task_id      TEXT,                -- soft reference (signing_tasks created in 012)

  event_type           TEXT NOT NULL,       -- 'signer.enrolled' | 'signer.heartbeat' | 'task.claimed' | etc.
  event_payload        TEXT NOT NULL,       -- JSON
  event_hash           TEXT NOT NULL,       -- SHA-256(event_type || event_payload || previous_event_hash)
  previous_event_hash  TEXT,               -- hash-chain link

  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signer_events_tenant ON signer_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signer_events_signer ON signer_events(signer_id);
CREATE INDEX IF NOT EXISTS idx_signer_events_type   ON signer_events(event_type);
