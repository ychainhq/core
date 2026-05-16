import { adapterRegistry } from '../chain-adapters/registry';
import { transactionsService } from '../modules/transactions/transactions.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

/**
 * TxStatusWorker
 *
 * Monitors broadcasted transactions and updates their confirmation status.
 * Runs every TX_STATUS_INTERVAL_MS (default: 60 seconds).
 */
export class TxStatusWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('TxStatusWorker started', { intervalMs: config.TX_STATUS_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('TxStatusWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.TX_STATUS_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('TxStatusWorker stopped');
    }
  }

  async run(): Promise<void> {
    const chainId = 'bitcoin';
    const adapter = adapterRegistry.get(chainId);
    const pendingTxs = transactionsService.getPendingBroadcasted(chainId);

    if (pendingTxs.length === 0) return;

    logger.debug('TxStatusWorker checking transactions', { count: pendingTxs.length });

    for (const tx of pendingTxs) {
      if (!tx.tx_hash) continue;

      try {
        const status = await adapter.getTransactionStatus(tx.tx_hash);
        const oldStatus = tx.status;

        let newStatus = tx.status;
        if (status.inMempool && !status.confirmed) {
          newStatus = 'seen_in_mempool';
        } else if (status.confirmed && status.confirmations >= config.BTC_DEFAULT_CONFIRMATIONS) {
          newStatus = 'confirmed';
        }

        if (newStatus !== oldStatus || status.confirmations !== tx.confirmations) {
          transactionsService.updateStatus(tx.id, newStatus, {
            block_height: status.blockHeight ?? undefined,
            block_hash: status.blockHash ?? undefined,
            confirmations: status.confirmations,
          });

          if (newStatus !== oldStatus) {
            logger.info('Transaction status changed', {
              txId: tx.id,
              txHash: tx.tx_hash,
              oldStatus,
              newStatus,
              confirmations: status.confirmations,
            });

            webhooksService.queueEvent('transaction.status_changed', {
              txId: tx.id,
              txHash: tx.tx_hash,
              oldStatus,
              newStatus,
              confirmations: status.confirmations,
              blockHeight: status.blockHeight,
            }, chainId, undefined, tx.tenant_id ?? undefined);
          }
        }
      } catch (err) {
        logger.warn('Failed to check tx status', { txId: tx.id, txHash: tx.tx_hash, error: String(err) });

        // If transaction is not found in mempool or blockchain, mark as dropped
        if ((err as any)?.code === 'TX_NOT_FOUND') {
          transactionsService.updateStatus(tx.id, 'dropped');
          webhooksService.queueEvent('transaction.dropped', {
            txId: tx.id,
            txHash: tx.tx_hash,
          }, chainId, undefined, tx.tenant_id ?? undefined);
        }
      }
    }
  }
}
