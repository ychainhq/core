import { getDb } from '../db/sqlite';
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

    this.interval = setInterval(() => {
      try {
        this.run();
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

  run(): void {
    const db = getDb();
    const result = db.pragma('wal_checkpoint(PASSIVE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const { busy, log, checkpointed } = result[0] ?? { busy: 0, log: 0, checkpointed: 0 };
    logger.debug('WAL checkpoint completed', { busy, log, checkpointed });
  }
}
