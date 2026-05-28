/**
 * Withdrawal Batcher Worker
 *
 * Runs every 30 seconds. For each tenant with queued BTC withdrawals,
 * checks if a batch should be built based on:
 * - output count >= btc_min_outputs_per_batch
 * - oldest withdrawal age >= btc_max_batch_age_seconds
 */

import { getDb } from '../db/sqlite';
import { withdrawalBatcherService } from '../modules/withdrawal-batches/withdrawal-batcher.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';
import { ticklerService } from '../shared/tickler/tickler.service';

const BATCH_WORKER_INTERVAL_MS = parseInt(
  process.env['BATCH_WORKER_INTERVAL_MS'] ?? '30000',
  10
);
const MAX_BATCHES_PER_RUN = parseInt(process.env['BATCH_WORKER_MAX_BATCHES_PER_RUN'] ?? '25', 10);
const MAX_BATCHES_PER_TENANT_PER_RUN = parseInt(process.env['BATCH_WORKER_MAX_BATCHES_PER_TENANT_PER_RUN'] ?? '5', 10);
const MAX_RUN_MS = parseInt(process.env['BATCH_WORKER_MAX_RUN_MS'] ?? '25000', 10);

export class WithdrawalBatcherWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('WithdrawalBatcherWorker started', { intervalMs: BATCH_WORKER_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('WithdrawalBatcherWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, BATCH_WORKER_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('WithdrawalBatcherWorker stopped');
    }
  }

  async run(): Promise<void> {
    // Find tenants with queued BTC withdrawals
    const db = getDb();
    const tenantsWithQueued = db.prepare(`
      SELECT DISTINCT tenant_id
      FROM customer_withdrawals
      WHERE status = 'queued' AND chain_id = 'bitcoin'
    `).all() as Array<{ tenant_id: string }>;

    if (tenantsWithQueued.length === 0) return;

    logger.debug('WithdrawalBatcherWorker: processing tenants', { count: tenantsWithQueued.length });

    const startedAt = Date.now();
    const perTenantCount = new Map<string, number>();
    let totalCreated = 0;
    let madeProgress = true;

    while (
      madeProgress &&
      totalCreated < MAX_BATCHES_PER_RUN &&
      Date.now() - startedAt < MAX_RUN_MS
    ) {
      madeProgress = false;

      for (const { tenant_id } of tenantsWithQueued) {
        if (totalCreated >= MAX_BATCHES_PER_RUN || Date.now() - startedAt >= MAX_RUN_MS) break;

        const tenantCreated = perTenantCount.get(tenant_id) ?? 0;
        if (tenantCreated >= MAX_BATCHES_PER_TENANT_PER_RUN) continue;

        try {
          const batch = await withdrawalBatcherService.buildBatchForTenant(tenant_id);
          if (batch) {
            totalCreated++;
            perTenantCount.set(tenant_id, tenantCreated + 1);
            madeProgress = true;
            logger.info('WithdrawalBatcherWorker: batch created', {
              tenantId: tenant_id,
              batchId: batch.id,
              outputsCount: batch.outputs_count,
            });
            ticklerService.record({
              tenantId: tenant_id,
              category: 'withdrawal_batch',
              subcategory: 'created',
              entityId: batch.id,
              actorLogin: 'system:withdrawal-batcher',
              field1: String(batch.outputs_count),
              field2: batch.status,
              newValue: batch,
            });
          }
        } catch (err) {
          logger.warn('WithdrawalBatcherWorker: batch build failed', {
            tenantId: tenant_id,
            error: String(err),
          });
        }
      }
    }
  }
}
