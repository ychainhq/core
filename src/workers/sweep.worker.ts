import { getDb } from '../db/sqlite';
import { BitcoinAdapter } from '../chain-adapters/bitcoin/adapter';
import { sweepsService } from '../modules/sweeps/sweeps.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { btcToSatoshi } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

/**
 * SweepWorker
 *
 * Runs on a configurable interval. For each tenant that has:
 *   - a btc_sweep_threshold_sats set
 *   - a tenant_hot wallet with at least one address
 *
 * it checks the total unconfirmed+confirmed UTXOs sitting on customer deposit
 * addresses. When the total exceeds the sweep threshold, it:
 *
 *   1. Builds a PSBT via Bitcoin Core walletCreateFundedPsbt (watch-only FWallet)
 *   2. Creates a `sweeps` record with status 'pending_signature'
 *   3. Fires a `sweep.ready_for_signing` webhook with the PSBT payload
 *
 * The tenant's signing daemon receives the webhook, signs the PSBT, and calls
 * POST /v1/sweeps/:sweepId/submit-signed to finalize and broadcast.
 */
export class SweepWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('SweepWorker started', { intervalMs: config.SWEEP_WORKER_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('SweepWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.SWEEP_WORKER_INTERVAL_MS);

    setImmediate(() =>
      this.run().catch((err) => logger.error('SweepWorker initial run error', { error: String(err) }))
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('SweepWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDb();

    // Find tenants with an active hot wallet address (sweep destination)
    const tenantRows = db.prepare(`
      SELECT DISTINCT t.id as tenant_id, tc.btc_sweep_threshold_sats
      FROM tenants t
      JOIN tenant_configs tc ON tc.tenant_id = t.id
      WHERE t.status = 'active'
        AND tc.btc_sweep_threshold_sats IS NOT NULL
    `).all() as { tenant_id: string; btc_sweep_threshold_sats: string }[];

    for (const row of tenantRows) {
      try {
        await this.processTenant(row.tenant_id, row.btc_sweep_threshold_sats);
      } catch (err) {
        logger.warn('SweepWorker: error processing tenant', { tenantId: row.tenant_id, error: String(err) });
      }
    }
  }

  private async processTenant(tenantId: string, sweepThresholdSats: string): Promise<void> {
    const db = getDb();
    const adapter = new BitcoinAdapter();

    // Find tenant_hot wallet address (sweep destination)
    const hotAddr = db.prepare(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `).get(tenantId) as { address: string } | undefined;

    if (!hotAddr) {
      return; // No hot wallet address — cannot sweep
    }

    // Find all deposit addresses for this tenant (from customer_deposits wallet)
    const depositAddresses = db.prepare(`
      SELECT DISTINCT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
    `).all(tenantId) as { address: string }[];

    if (depositAddresses.length === 0) return;

    // Check if there's already a pending sweep — avoid duplicate PSBTs
    const existingPending = db
      .prepare("SELECT id FROM sweeps WHERE tenant_id = ? AND status = 'pending_signature' LIMIT 1")
      .get(tenantId);
    if (existingPending) return;

    // Collect UTXOs across all deposit addresses (minConfirmations = 1 for finality)
    const sweepableUtxos: Array<{ address: string; txHash: string; vout: number; amount: string }> = [];
    let totalSats = BigInt(0);

    for (const { address } of depositAddresses) {
      let utxos: any[];
      try {
        utxos = await adapter.getUtxosForAddress(address, 1, tenantId);
      } catch {
        continue;
      }
      for (const u of utxos) {
        sweepableUtxos.push({ address, txHash: u.txHash, vout: u.vout, amount: u.amount });
        totalSats += BigInt(u.amount);
      }
    }

    const threshold = BigInt(sweepThresholdSats);
    if (totalSats < threshold || sweepableUtxos.length === 0) return;

    logger.info('SweepWorker: threshold reached, building PSBT', {
      tenantId,
      totalSats: totalSats.toString(),
      threshold: sweepThresholdSats,
      utxoCount: sweepableUtxos.length,
    });

    // Estimate fee (target 6 blocks)
    let feeRateSatPerVbyte = 5; // fallback
    try {
      const feeEst = await adapter.estimateSmartFee(6);
      if (feeEst.feeRate) feeRateSatPerVbyte = Math.ceil(feeEst.feeRate * 100000); // BTC/kB → sat/vB
    } catch {
      logger.warn('SweepWorker: fee estimation failed, using fallback', { tenantId });
    }

    // Build PSBT via Bitcoin Core walletCreateFundedPsbt
    // We pass explicit inputs + the hot address as output; Bitcoin Core adds change if any
    const btcAmount = Number(totalSats) / 1e8;
    const walletName = `btc_${tenantId}`;
    let psbtBase64: string;
    try {
      const inputs = sweepableUtxos.map((u) => ({ txid: u.txHash, vout: u.vout }));
      const outputs = [{ [hotAddr.address]: btcAmount }];
      const result = await adapter.walletCreateFundedPsbt(inputs, outputs, {
        feeRate: feeRateSatPerVbyte / 1e5, // sat/vB → BTC/kB  (approx)
        subtractFeeFromOutputs: [0],
      }, tenantId);
      psbtBase64 = result.psbt;
    } catch (err) {
      logger.warn('SweepWorker: failed to create PSBT via Bitcoin Core (non-fatal)', { tenantId, err: String(err) });
      return;
    }

    // Create sweep record
    const sweep = sweepsService.create(tenantId, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses: sweepableUtxos.map((u) => u.address),
      toAddress: hotAddr.address,
      amountRaw: totalSats.toString(),
      feeRaw: String(Math.round(feeRateSatPerVbyte * sweepableUtxos.length * 148)),
      psbt: psbtBase64,
    });

    // Fire webhook to signing daemon
    webhooksService.queueEvent(
      'sweep.ready_for_signing',
      {
        sweepId: sweep.id,
        psbt: psbtBase64,
        fromAddresses: sweep.from_addresses,
        toAddress: sweep.to_address,
        amountRaw: sweep.amount_raw,
        feeRaw: sweep.fee_raw,
        submitUrl: `/v1/sweeps/${sweep.id}/submit-signed`,
      },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('SweepWorker: sweep created and webhook fired', { sweepId: sweep.id, tenantId });
  }
}
