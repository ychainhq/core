import { DepositMonitorWorker } from './deposit-monitor.worker';
import { TxStatusWorker } from './tx-status.worker';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { SweepWorker } from './sweep.worker';
import { SweepConfirmationWorker } from './sweep-confirmation.worker';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const depositMonitor = new DepositMonitorWorker();
const txStatus = new TxStatusWorker();
const webhookDelivery = new WebhookDeliveryWorker();
const sweepWorker = new SweepWorker();
const sweepConfirmation = new SweepConfirmationWorker();

export function startWorkers(): void {
  if (!config.WORKERS_ENABLED) {
    logger.info('Workers disabled (WORKERS_ENABLED=false)');
    return;
  }

  logger.info('Starting background workers...');
  depositMonitor.start();
  txStatus.start();
  webhookDelivery.start();
  sweepWorker.start();
  sweepConfirmation.start();
  logger.info('All workers started');
}

export function stopWorkers(): void {
  logger.info('Stopping background workers...');
  depositMonitor.stop();
  txStatus.stop();
  webhookDelivery.stop();
  sweepWorker.stop();
  sweepConfirmation.stop();
  logger.info('All workers stopped');
}
