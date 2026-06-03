import { chainNodesService, ChainNodeStatus } from '../modules/chain-nodes/chain-nodes.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const CHECK_INTERVAL_MS = (config as any).NODE_HEALTH_CHECK_INTERVAL_MS ?? 30_000;
const RPC_TIMEOUT_MS = 8_000;

export class NodeHealthCheckerWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('NodeHealthCheckerWorker started', { intervalMs: CHECK_INTERVAL_MS });
    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('NodeHealthCheckerWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, CHECK_INTERVAL_MS);

    setImmediate(() => this.run().catch(err =>
      logger.error('NodeHealthCheckerWorker initial run error', { error: String(err) })
    ));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('NodeHealthCheckerWorker stopped');
    }
  }

  async run(): Promise<void> {
    const nodes = await chainNodesService.list({ isEnabled: true });
    if (nodes.length === 0) return;

    logger.debug('Checking health of chain nodes', { count: nodes.length });
    await Promise.allSettled(nodes.map(node => this.checkNode(node.id, node.rpcUrl, node.rpcUser, node.chainId)));
  }

  private async checkNode(id: string, rpcUrl: string, rpcUser: string, chainId: string): Promise<void> {
    let status: ChainNodeStatus = 'unreachable';
    let blockHeight: number | null = null;
    let error: string | null = null;

    try {
      const password = await chainNodesService.resolvePassword(id);
      const auth = Buffer.from(`${rpcUser}:${password}`).toString('base64');

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
        body: JSON.stringify({ jsonrpc: '1.1', id: 'health', method: 'getblockchaininfo', params: [] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });

      if (!response.ok && response.status !== 500) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any;
      if (data.error) {
        throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
      }

      const info = data.result;
      blockHeight = info.blocks ?? null;

      if (info.initialblockdownload && info.chain !== 'regtest') {
        // In regtest, IBD=true simply means no block was mined in the last 24h
        // (nMaxTipAge threshold). This is normal in dev environments where blocks
        // are mined on demand — not a real sync issue.
        status = 'degraded';
        error = 'Initial block download in progress';
      } else {
        status = 'healthy';
      }
    } catch (err) {
      status = 'unreachable';
      error = String(err);
      logger.warn('Chain node health check failed', { id, chainId, error });
    }

    await chainNodesService.updateHealthStatus(id, status, blockHeight, error);
    logger.debug('Chain node health updated', { id, chainId, status, blockHeight });
  }
}
