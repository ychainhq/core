import { getDb } from '../db/sqlite';
import { BitcoinAdapter } from '../chain-adapters/bitcoin/adapter';
import { sweepsService } from '../modules/sweeps/sweeps.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

/**
 * SweepConfirmationWorker
 *
 * Monitors broadcast sweep transactions and finalises ledger entries once
 * they reach the tenant's required finality confirmation count.
 *
 * On confirmation:
 *   - Debits sweep_in_transit by totalSats
 *   - Credits tenant_hot_control by (totalSats - fee)
 *   - Credits network_fee_expense by fee
 *   - Advances sweep status → 'confirmed'
 *   - Fires sweep.confirmed webhook
 */
export class SweepConfirmationWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('SweepConfirmationWorker started', { intervalMs: config.TX_STATUS_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('SweepConfirmationWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.TX_STATUS_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('SweepConfirmationWorker stopped');
    }
  }

  async run(): Promise<void> {
    const sweeps = sweepsService.getBroadcastWithTxHash();
    if (sweeps.length === 0) return;

    logger.debug('SweepConfirmationWorker checking sweeps', { count: sweeps.length });

    for (const sweep of sweeps) {
      try {
        await this.checkSweep(sweep.tenant_id, sweep.id, sweep.tx_hash!, sweep.amount_raw, sweep.fee_raw);
      } catch (err) {
        logger.warn('SweepConfirmationWorker: error checking sweep', {
          sweepId: sweep.id,
          tenantId: sweep.tenant_id,
          error: String(err),
        });
      }
    }
  }

  private async checkSweep(
    tenantId: string,
    sweepId: string,
    txHash: string,
    amountRaw: string,
    feeRaw: string | null,
  ): Promise<void> {
    const adapter = new BitcoinAdapter();

    let txStatus: Awaited<ReturnType<BitcoinAdapter['getTransactionStatus']>>;
    try {
      txStatus = await adapter.getTransactionStatus(txHash);
    } catch {
      return; // Bitcoin Core unavailable — skip, will retry next tick
    }

    if (!txStatus.confirmed) return;

    // Check per-tenant finality threshold
    const db = getDb();
    const cfgRow = db
      .prepare('SELECT btc_finality_confirmations FROM tenant_configs WHERE tenant_id = ?')
      .get(tenantId) as { btc_finality_confirmations: number } | undefined;
    const required = cfgRow?.btc_finality_confirmations ?? config.BTC_FINALITY_CONFIRMATIONS;

    if ((txStatus.confirmations ?? 0) < required) return;

    logger.info('SweepConfirmationWorker: sweep confirmed', { sweepId, tenantId, txHash, confirmations: txStatus.confirmations });

    sweepsService.updateStatus(sweepId, 'confirmed', { txHash });

    const fee = BigInt(feeRaw ?? '0');
    const total = BigInt(amountRaw);
    const netToHot = total - fee;

    // Debit sweep_in_transit
    const sitAccount = ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
    if (sitAccount) {
      ledgerService.addEntry({
        ledgerAccountId: sitAccount.id,
        type: 'sweep_confirmed',
        amountRaw: (-total).toString(),
        referenceType: 'sweep',
        referenceId: sweepId,
      });
    }

    // Credit tenant_hot_control (net of fee)
    const hcAccount = ledgerService.findAccountByTenantAndType(tenantId, 'tenant_hot_control');
    if (hcAccount) {
      ledgerService.addEntry({
        ledgerAccountId: hcAccount.id,
        type: 'sweep_confirmed',
        amountRaw: netToHot.toString(),
        referenceType: 'sweep',
        referenceId: sweepId,
      });
    }

    // Record network fee
    if (fee > BigInt(0)) {
      const nfeAccount = ledgerService.findAccountByTenantAndType(tenantId, 'network_fee_expense');
      if (nfeAccount) {
        ledgerService.addEntry({
          ledgerAccountId: nfeAccount.id,
          type: 'fee_expense',
          amountRaw: fee.toString(),
          referenceType: 'sweep',
          referenceId: sweepId,
        });
      }
    }

    webhooksService.queueEvent(
      'sweep.confirmed',
      { sweepId, txHash, amountRaw, feeRaw: feeRaw ?? '0', netToHot: netToHot.toString() },
      'bitcoin',
      undefined,
      tenantId,
    );
  }
}
