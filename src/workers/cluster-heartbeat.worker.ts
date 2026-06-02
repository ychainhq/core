/**
 * ClusterHeartbeatWorker — engine instance keep-alive (monitoring only).
 *
 * In v3 active-active mode there is NO leader election.
 * This worker only:
 *   1. Updates last_seen_at for this engine instance (keep-alive)
 *   2. Notifies peers of our presence (via HTTP)
 *   3. Cleans up stale instances
 *
 * Work distribution in active-active:
 *   - Queue workers (chain_events, webhooks): PostgreSQL SKIP LOCKED
 *   - Singleton-per-tenant (SweepWorker, Batcher): PostgreSQL advisory locks
 *   - No leader needed — PostgreSQL concurrency primitives are sufficient.
 */

import { clusterService } from '../modules/cluster/cluster.service';
import { config } from '../config/index';
import { logger } from '../shared/logging/index';

export class ClusterHeartbeatWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private peerUrls: string[] = [];

  start(): void {
    if (!config.CLUSTER_ENABLED) {
      logger.debug('ClusterHeartbeatWorker: cluster disabled, skipping');
      return;
    }

    this.peerUrls = (config.CLUSTER_PEER_URLS ?? '')
      .split(',')
      .map(u => u.trim())
      .filter(Boolean);

    logger.info('ClusterHeartbeatWorker started (monitoring only — no leader election)', {
      intervalMs: config.CLUSTER_HEARTBEAT_INTERVAL_MS,
      instanceId: clusterService.instanceId,
      peers: this.peerUrls.length,
    });

    this.interval = setInterval(async () => {
      try { await this.tick(); }
      catch (err) { logger.error('ClusterHeartbeatWorker error', { error: String(err) }); }
    }, config.CLUSTER_HEARTBEAT_INTERVAL_MS);

    setImmediate(() => this.tick().catch(err =>
      logger.error('ClusterHeartbeatWorker initial tick error', { error: String(err) })
    ));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      clusterService.deregister().catch(() => {});
    }
  }

  private async tick(): Promise<void> {
    await clusterService.heartbeat();
    await clusterService.cleanupStaleInstances();

    if (this.peerUrls.length > 0 && config.ENGINE_URL) {
      await this.notifyPeers();
    }
  }

  private async notifyPeers(): Promise<void> {
    const payload = JSON.stringify({
      instanceId: clusterService.instanceId,
      engineUrl: config.ENGINE_URL,
    });

    await Promise.allSettled(
      this.peerUrls.map(async (peerUrl) => {
        try {
          await fetch(`${peerUrl}/internal/cluster/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: AbortSignal.timeout(5_000),
          });
        } catch (err) {
          logger.debug('Peer heartbeat failed (non-fatal)', { peerUrl, error: String(err) });
        }
      })
    );
  }
}
