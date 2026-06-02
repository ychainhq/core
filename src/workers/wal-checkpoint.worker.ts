import { getDbClient } from '../db/client';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

/**
 * WalCheckpointWorker
 *
 * Periodically issues PRAGMA wal_checkpoint(PASSIVE) to transfer WAL pages
 * back to the main database file, keeping the WAL file from growing unbounded.
 * PASSIVE mode: checkpoints without blocking readers or writers.
 * Chain-agnostic — operates only on SQLite.
 */
export class WalCheckpointWorker {
  private interval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.interval) return;
    logger.info('WalCheckpointWorker started', { intervalMs: config.WAL_CHECKPOINT_INTERVAL_MS });

    this.interval = setInterval(async () => {
      try {
        await this.run();
      } catch (err) {
        logger.error('WalCheckpointWorker error', { error: String(err) });
      }
    }, config.WAL_CHECKPOINT_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('WalCheckpointWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDbClient();
    if (db.isPostgres) {
      // WAL checkpoint is SQLite-only; no-op on PostgreSQL
      return;
    }
    const result = await db.all<{ busy: number; log: number; checkpointed: number }>(
      'PRAGMA wal_checkpoint(PASSIVE)'
    );
    const { busy, log, checkpointed } = result[0] ?? { busy: 0, log: 0, checkpointed: 0 };
    logger.debug('WAL checkpoint completed', { busy, log, checkpointed });
  }
}
