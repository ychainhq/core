/**
 * ClusterService — engine instance registry (monitoring only).
 *
 * In v3 active-active mode there is NO leader concept.
 * Both engines run all workers. Work distribution is handled by:
 *   - PostgreSQL SKIP LOCKED   for queue-based workers (chain_events, webhooks, etc.)
 *   - PostgreSQL advisory locks for singleton-per-tenant operations (SweepWorker, Batcher)
 *
 * This service tracks which engine instances are alive (health monitoring).
 * engine_instances table: used for /admin/v1/cluster/status — NOT for routing decisions.
 */

import os from 'os';
import { getDbClient } from '../../db/client';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';

export interface EngineInstance {
  id: string;
  engine_url: string;
  version: string | null;
  started_at: string;
  last_seen_at: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

const INSTANCE_ID = `engine_${os.hostname()}_${process.pid}_${Date.now()}`;
const STARTED_AT = new Date().toISOString();

let engineVersion = 'unknown';
try { engineVersion = require('../../../package.json').version; } catch { /* ok */ }

function toApi(row: EngineInstance) {
  return {
    id: row.id,
    engineUrl: row.engine_url,
    version: row.version,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const clusterService = {
  get instanceId(): string { return INSTANCE_ID; },

  async register(): Promise<void> {
    if (!config.CLUSTER_ENABLED || !config.ENGINE_URL) return;

    const db = getDbClient();
    const now = new Date().toISOString();
    const meta = JSON.stringify({ hostname: os.hostname(), pid: process.pid });

    await db.run(`
      INSERT INTO engine_instances
        (id, engine_url, version, started_at, last_seen_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        engine_url   = excluded.engine_url,
        last_seen_at = excluded.last_seen_at,
        updated_at   = excluded.updated_at
    `, [INSTANCE_ID, config.ENGINE_URL, engineVersion, STARTED_AT, now, meta, now, now]);

    logger.info('Engine registered in cluster', { instanceId: INSTANCE_ID, url: config.ENGINE_URL });
  },

  async heartbeat(): Promise<void> {
    if (!config.CLUSTER_ENABLED) return;

    const db = getDbClient();
    const now = new Date().toISOString();
    await db.run(`
      UPDATE engine_instances SET last_seen_at = ?, updated_at = ? WHERE id = ?
    `, [now, now, INSTANCE_ID]);
  },

  async listInstances(): Promise<ReturnType<typeof toApi>[]> {
    const db = getDbClient();
    const rows = await db.all<EngineInstance>(`
      SELECT * FROM engine_instances ORDER BY last_seen_at DESC
    `);
    return rows.map(toApi);
  },

  async deregister(): Promise<void> {
    if (!config.CLUSTER_ENABLED) return;

    const db = getDbClient();
    await db.run('DELETE FROM engine_instances WHERE id = ?', [INSTANCE_ID]);
    logger.info('Engine deregistered from cluster', { instanceId: INSTANCE_ID });
  },

  async cleanupStaleInstances(): Promise<void> {
    const db = getDbClient();
    // Remove instances not seen for 3× heartbeat interval
    const staleThreshold = new Date(Date.now() - config.CLUSTER_HEARTBEAT_INTERVAL_MS * 3).toISOString();
    const result = await db.run(`
      DELETE FROM engine_instances WHERE last_seen_at < ? AND id != ?
    `, [staleThreshold, INSTANCE_ID]);
    if (result.changes > 0) {
      logger.debug('Cleaned up stale engine instances', { removed: result.changes });
    }
  },

  /**
   * Acquire a PostgreSQL advisory lock for singleton-per-tenant operations.
   * Returns true if lock acquired (proceed), false if another engine holds it (skip).
   *
   * Only works with PostgreSQL. On SQLite always returns true (single writer).
   * Lock is automatically released at transaction end or connection close.
   *
   * Usage (in a worker tick):
   *   const db = getDbClient();
   *   const acquired = await clusterService.tryAdvisoryLock(db, 'sweep', tenantId);
   *   if (!acquired) return; // another engine is handling this tenant
   */
  async tryAdvisoryLock(db: import('../../db/client').DbClient, scope: string, tenantId: string): Promise<boolean> {
    if (!db.isPostgres) return true; // SQLite: single process, always safe

    const lockKey = `${scope}:${tenantId}`;
    const rows = await db.all<{ acquired: boolean }>(`
      SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired
    `, [lockKey]);
    return rows[0]?.acquired === true;
  },
};
