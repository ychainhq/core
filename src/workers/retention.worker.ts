import { getDb } from '../db/sqlite';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

/**
 * RetentionWorker
 *
 * Periodically deletes old records that are no longer operationally needed:
 * - webhook_deliveries with terminal status (sent / failed) older than
 *   WEBHOOK_DELIVERY_RETENTION_DAYS (default 30 days).
 *
 * Does NOT touch idempotency_keys — those are cleaned by idempotency.service
 * via its own setInterval. Chain-agnostic.
 */
export class RetentionWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('RetentionWorker started', { intervalMs: RETENTION_INTERVAL_MS });

    this.interval = setInterval(() => {
      if (this.running) return;
      this.running = true;
      try {
        this.run();
      } catch (err) {
        logger.error('RetentionWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, RETENTION_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('RetentionWorker stopped');
    }
  }

  run(): void {
    const db = getDb();
    const cutoff = new Date(
      Date.now() - config.WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const result = db
      .prepare(`
        DELETE FROM webhook_deliveries
        WHERE status IN ('sent', 'failed')
          AND created_at < ?
      `)
      .run(cutoff);

    if (result.changes > 0) {
      logger.info('RetentionWorker: deleted old webhook deliveries', {
        deleted: result.changes,
        olderThan: cutoff,
      });
    }
  }
}
