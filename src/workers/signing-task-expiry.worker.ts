/**
 * Signing Task Expiry Worker
 *
 * Runs every 60 seconds. Expires overdue signing tasks and releases
 * their associated UTXO locks. Also calls cleanup of expired UTXO locks
 * as a safety net.
 */

import { signingTasksService } from '../modules/signing-tasks/signing-tasks.service';
import { utxoLockService } from '../shared/utxo-lock/utxo-lock.service';
import { logger } from '../shared/logging/index';
import { ticklerService } from '../shared/tickler/tickler.service';

const EXPIRY_WORKER_INTERVAL_MS = parseInt(
  process.env['SIGNING_TASK_EXPIRY_INTERVAL_MS'] ?? '60000',
  10
);

export class SigningTaskExpiryWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('SigningTaskExpiryWorker started', { intervalMs: EXPIRY_WORKER_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('SigningTaskExpiryWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, EXPIRY_WORKER_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('SigningTaskExpiryWorker stopped');
    }
  }

  async run(): Promise<void> {
    // Expire overdue signing tasks (releases UTXO locks internally)
    const expiredCount = signingTasksService.expireAllOverdue();
    if (expiredCount > 0) {
      logger.info('SigningTaskExpiryWorker: expired tasks', { count: expiredCount });
      ticklerService.record({
        tenantId: null,
        category: 'signing_task',
        subcategory: 'bulk_expired',
        actorLogin: 'system:signing-task-expiry',
        field1: String(expiredCount),
      });
    }

    // Cleanup any lingering expired UTXO locks (safety net)
    const cleanedLocks = utxoLockService.cleanupExpiredLocks();
    if (cleanedLocks > 0) {
      logger.info('SigningTaskExpiryWorker: cleaned expired UTXO locks', { count: cleanedLocks });
    }
  }
}
