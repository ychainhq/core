import { getDbClient } from '../db/client';
import { TronRpcClient } from '../chain-adapters/tron/rpc-client';
import { NodeSelector } from '../chain-adapters/node-selector';
import { externalSignersService } from '../modules/external-signers/external-signers.service';
import { signerPolicyService } from '../modules/external-signers/signer-policy.service';
import { signingTasksService } from '../modules/signing-tasks/signing-tasks.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

// Run every 6 hours — undelegations are low-frequency
const INTERVAL_MS = 6 * 60 * 60 * 1_000;

// Reclaim delegations whose linked sweep has been confirmed or has been pending > MAX_DELEGATION_AGE_HOURS
const MAX_DELEGATION_AGE_HOURS = 24;

const TRON_TRX_ASSET_ID = 'tron:TRX';

interface DelegationRow {
  address: string;
  tenant_id: string;
  delegation_sun: string;
  sweep_id: string | null;
  delegated_at: string;
}

/**
 * TronEnergyReclaimWorker
 *
 * Periodically undelegates ENERGY from deposit addresses back to the hot wallet
 * after the associated sweep has been confirmed. This reclaims the staked TRX.
 *
 * Also undelegates any "stuck" delegations older than MAX_DELEGATION_AGE_HOURS
 * to prevent TRX being locked indefinitely.
 */
export class TronEnergyReclaimWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    if (!config.TRON_NODE_URL) {
      logger.info('TronEnergyReclaimWorker: TRON_NODE_URL not configured — skipping');
      return;
    }
    logger.info('TronEnergyReclaimWorker started', { intervalMs: INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('TronEnergyReclaimWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, INTERVAL_MS);

    // First run after 10s delay to let engine fully start
    setTimeout(() =>
      this.run().catch((err) => logger.error('TronEnergyReclaimWorker initial run error', { error: String(err) })),
      10_000
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('TronEnergyReclaimWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDbClient();
    const rpc = new TronRpcClient(
      new NodeSelector('tron', config.TRON_NODE_URL
        ? { url: config.TRON_NODE_URL, timeoutMs: 15_000, maxAttempts: 3, retryDelayMs: 1_000 }
        : null)
    );

    const cutoff = new Date(Date.now() - MAX_DELEGATION_AGE_HOURS * 60 * 60 * 1_000).toISOString();

    // Find delegations to reclaim:
    // 1. Sweep confirmed → reclaim immediately
    // 2. No sweep or sweep failed → reclaim after age cutoff
    const delegations = await db.all<DelegationRow>(`
      SELECT ted.address, ted.tenant_id, ted.delegation_sun, ted.sweep_id, ted.delegated_at
      FROM tron_energy_delegations ted
      LEFT JOIN sweeps s ON s.id = ted.sweep_id
      WHERE
        (s.status = 'confirmed')
        OR (ted.sweep_id IS NULL AND ted.delegated_at < ?)
        OR (s.status = 'failed' AND ted.delegated_at < ?)
    `, [cutoff, cutoff]);

    if (delegations.length === 0) return;

    logger.info('TronEnergyReclaimWorker: reclaiming delegations', { count: delegations.length });

    for (const del of delegations) {
      try {
        await this.reclaimDelegation(del, rpc);
      } catch (err) {
        logger.warn('TronEnergyReclaimWorker: reclaim failed', {
          address: del.address,
          tenantId: del.tenant_id,
          error: String(err),
        });
      }
    }
  }

  private async reclaimDelegation(del: DelegationRow, rpc: TronRpcClient): Promise<void> {
    const db = getDbClient();

    const hotRow = await db.get<{ address: string }>(
      `SELECT a.address FROM addresses a
       JOIN wallets w ON w.id = a.wallet_id
       WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
         AND a.chain_id = 'tron' AND a.status = 'active'
       LIMIT 1`,
      [del.tenant_id]
    );
    if (!hotRow) return;

    const rawTx = await rpc.buildUndelegateEnergyTx({
      ownerAddress: hotRow.address,
      receiverAddress: del.address,
      balanceSun: del.delegation_sun,
    });

    const selectedSigner = await externalSignersService.selectSigner(
      del.tenant_id, 'tron', TRON_TRX_ASSET_ID, 'tron_raw_tx',
    );
    const policyDecision = await signerPolicyService.evaluateDecision(
      del.tenant_id, selectedSigner?.id ?? null, 'tron', TRON_TRX_ASSET_ID, '0', 0, 1,
    );

    const unsignedPayload = JSON.stringify({
      chainId: 'tron',
      network: config.TRON_NETWORK,
      type: 'undelegate_resource',
      resource: 'ENERGY',
      ownerAddress: hotRow.address,
      receiverAddress: del.address,
      balanceSun: del.delegation_sun,
      lock: false,
      rawTransaction: rawTx,
    });

    await signingTasksService.create({
      tenantId: del.tenant_id,
      signerId: selectedSigner?.id ?? null,
      requestType: 'tron_undelegate_energy',
      chainId: 'tron',
      assetId: TRON_TRX_ASSET_ID,
      amountRaw: '0',
      feeRaw: null,
      payloadFormat: 'tron_raw_tx',
      unsignedPayload,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    // Remove from delegations table — the undelegation task was created
    await db.run('DELETE FROM tron_energy_delegations WHERE address = ?', [del.address]);

    logger.info('TronEnergyReclaimWorker: undelegation task created', {
      tenantId: del.tenant_id,
      depositAddress: del.address,
      hotWallet: hotRow.address,
      balanceSun: del.delegation_sun,
    });
  }
}
