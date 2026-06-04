import { ChainEventProcessorWorker } from './chain-event-processor-worker';
import { TxStatusWorker } from './tx-status.worker';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { SweepWorker } from './sweep.worker';
import { SweepConfirmationWorker } from './sweep-confirmation.worker';
import { WithdrawalBatcherWorker } from './withdrawal-batcher.worker';
import { SigningTaskExpiryWorker } from './signing-task-expiry.worker';
import { RetentionWorker } from './retention.worker';
import { NodeHealthCheckerWorker } from './node-health-checker.worker';
import { ClusterHeartbeatWorker } from './cluster-heartbeat.worker';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const chainEventProcessor = new ChainEventProcessorWorker();
const txStatus = new TxStatusWorker();
const webhookDelivery = new WebhookDeliveryWorker();
const sweepWorker = new SweepWorker();
const sweepConfirmation = new SweepConfirmationWorker();
const withdrawalBatcher = new WithdrawalBatcherWorker();
const signingTaskExpiry = new SigningTaskExpiryWorker();
const retention = new RetentionWorker();
const nodeHealthChecker = new NodeHealthCheckerWorker();
const clusterHeartbeat = new ClusterHeartbeatWorker();

export function startWorkers(): void {
  if (!config.WORKERS_ENABLED) {
    logger.info('Workers disabled (WORKERS_ENABLED=false)');
    return;
  }

  logger.info('Starting background workers...');
  chainEventProcessor.start();
  txStatus.start();
  webhookDelivery.start();
  sweepWorker.start();
  sweepConfirmation.start();
  withdrawalBatcher.start();
  signingTaskExpiry.start();
  retention.start();
  nodeHealthChecker.start();
  clusterHeartbeat.start();
  logger.info('All workers started');
}

export function stopWorkers(): void {
  logger.info('Stopping background workers...');
  chainEventProcessor.stop();
  txStatus.stop();
  webhookDelivery.stop();
  sweepWorker.stop();
  sweepConfirmation.stop();
  withdrawalBatcher.stop();
  signingTaskExpiry.stop();
  retention.stop();
  nodeHealthChecker.stop();
  clusterHeartbeat.stop();
  logger.info('All workers stopped');
}
