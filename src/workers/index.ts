import { DepositMonitorWorker } from './deposit-monitor.worker';
import { DepositEventProcessorWorker } from './deposit-event-processor.worker';
import { TxStatusWorker } from './tx-status.worker';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { SweepWorker } from './sweep.worker';
import { SweepConfirmationWorker } from './sweep-confirmation.worker';
import { WithdrawalBatcherWorker } from './withdrawal-batcher.worker';
import { SigningTaskExpiryWorker } from './signing-task-expiry.worker';
import { WalCheckpointWorker } from './wal-checkpoint.worker';
import { RetentionWorker } from './retention.worker';
import { NodeHealthCheckerWorker } from './node-health-checker.worker';
import { ClusterHeartbeatWorker } from './cluster-heartbeat.worker';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const depositMonitor = new DepositMonitorWorker();
const depositEventProcessor = new DepositEventProcessorWorker();
const txStatus = new TxStatusWorker();
const webhookDelivery = new WebhookDeliveryWorker();
const sweepWorker = new SweepWorker();
const sweepConfirmation = new SweepConfirmationWorker();
const withdrawalBatcher = new WithdrawalBatcherWorker();
const signingTaskExpiry = new SigningTaskExpiryWorker();
const walCheckpoint = new WalCheckpointWorker();
const retention = new RetentionWorker();
const nodeHealthChecker = new NodeHealthCheckerWorker();
const clusterHeartbeat = new ClusterHeartbeatWorker();

export function startWorkers(): void {
  if (!config.WORKERS_ENABLED) {
    logger.info('Workers disabled (WORKERS_ENABLED=false)');
    return;
  }

  logger.info('Starting background workers...');

  // v3: DepositEventProcessor runs alongside legacy DepositMonitorWorker during transition.
  // Once btc-indexer is fully deployed and chain_events are flowing, DepositMonitorWorker
  // will be removed (FAZA 2: PostgreSQL migration).
  depositMonitor.start();
  depositEventProcessor.start();

  txStatus.start();
  webhookDelivery.start();
  sweepWorker.start();
  sweepConfirmation.start();
  withdrawalBatcher.start();
  signingTaskExpiry.start();
  walCheckpoint.start();
  retention.start();
  nodeHealthChecker.start();
  clusterHeartbeat.start();
  logger.info('All workers started');
}

export function stopWorkers(): void {
  logger.info('Stopping background workers...');
  depositMonitor.stop();
  depositEventProcessor.stop();
  txStatus.stop();
  webhookDelivery.stop();
  sweepWorker.stop();
  sweepConfirmation.stop();
  withdrawalBatcher.stop();
  signingTaskExpiry.stop();
  walCheckpoint.stop();
  retention.stop();
  nodeHealthChecker.stop();
  clusterHeartbeat.stop();
  logger.info('All workers stopped');
}
