-- Migration 024: Engine cluster instance registry (monitoring only)
--
-- Tracks live engine instances in an active-active cluster.
-- Used ONLY for health monitoring — NOT for leader election or work routing.
--
-- In v3 active-active mode there is no "leader":
--   - Work distribution: PostgreSQL SKIP LOCKED (queue workers)
--   - Singleton-per-tenant: PostgreSQL advisory locks (SweepWorker, Batcher)
--   - Both engines run all workers simultaneously
--
-- engine_instances is updated by ClusterHeartbeatWorker (every CLUSTER_HEARTBEAT_INTERVAL_MS).
-- Stale entries (not seen for 3× interval) are auto-deleted by the heartbeat worker.

CREATE TABLE IF NOT EXISTS engine_instances (
  id           TEXT PRIMARY KEY,     -- 'engine_{hostname}_{pid}_{startTs}'
  engine_url   TEXT NOT NULL,        -- 'http://engine-1:3000'
  version      TEXT,                 -- package.json version
  started_at   TEXT NOT NULL,        -- ISO8601 process start time
  last_seen_at TEXT NOT NULL,        -- ISO8601 last heartbeat (keep-alive)
  metadata     TEXT,                 -- JSON: { hostname, pid }
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Lookup by recency (for status endpoint)
CREATE INDEX IF NOT EXISTS idx_engine_instances_seen
  ON engine_instances(last_seen_at DESC);
