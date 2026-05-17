import { adapterRegistry } from '../chain-adapters/registry';
import { monitorsService } from '../modules/monitors/monitors.service';
import { depositsService } from '../modules/deposits/deposits.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { satoshiToBtc } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

/**
 * DepositMonitorWorker
 *
 * Polls watched Bitcoin addresses for new deposits and confirmation updates.
 * Runs every DEPOSIT_MONITOR_INTERVAL_MS (default: 30 seconds).
 *
 * Algorithm:
 * 1. Get all active watched_addresses for chain=bitcoin
 * 2. For each address, get UTXOs (via wallet listunspent or scantxoutset)
 * 3. Compare with existing deposits
 * 4. Create new deposit records for newly detected UTXOs
 * 5. Update confirmation counts for existing deposits
 * 6. Link deposits to payment requests
 * 7. Emit webhooks for status changes
 */
export class DepositMonitorWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('DepositMonitorWorker started', { intervalMs: config.DEPOSIT_MONITOR_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return; // Skip if previous run still in progress
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('DepositMonitorWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.DEPOSIT_MONITOR_INTERVAL_MS);

    // Run immediately on start
    setImmediate(() => this.run().catch((err) => logger.error('DepositMonitorWorker initial run error', { error: String(err) })));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('DepositMonitorWorker stopped');
    }
  }

  async run(): Promise<void> {
    const chainId = 'bitcoin';
    const adapter = adapterRegistry.get(chainId);
    const watchedAddresses = monitorsService.getActiveByChain(chainId);

    if (watchedAddresses.length === 0) return;

    let currentBlockCount: number;
    try {
      currentBlockCount = await adapter.getBlockCount();
    } catch (err) {
      logger.warn('Failed to get block count, skipping deposit monitor run', { error: String(err) });
      return;
    }

    for (const watched of watchedAddresses) {
      try {
        await this.processAddress(
          watched.address,
          watched.tenant_id,
          watched.wallet_id ?? undefined,
          currentBlockCount,
          chainId
        );
      } catch (err) {
        logger.warn('Failed to process watched address', { address: watched.address, error: String(err) });
      }
    }
  }

  private async processAddress(
    address: string,
    tenantId: string,
    walletId: string | undefined,
    currentBlockCount: number,
    chainId: string
  ): Promise<void> {
    const adapter = adapterRegistry.get(chainId);
    const assetId = 'bitcoin:BTC';

    // Get UTXOs for address (0 confirmations = includes mempool)
    let utxos: any[];
    try {
      utxos = await adapter.getUtxosForAddress(address, 0, tenantId);
    } catch (err) {
      logger.warn('Failed to get UTXOs', { address, error: String(err) });
      return;
    }

    // Get existing deposits for this address
    const existingDeposits = depositsService.getExistingByAddress(chainId, address);
    const existingDepositKeys = new Set(
      existingDeposits.map((d) => `${d.tx_hash}:${d.vout}`)
    );

    for (const utxo of utxos) {
      const key = `${utxo.txHash}:${utxo.vout}`;
      const isNew = !existingDepositKeys.has(key);

      const confirmations = utxo.confirmations ?? 0;
      let status: string;
      if (confirmations === 0) {
        status = 'detected';
      } else if (confirmations < config.BTC_DEFAULT_CONFIRMATIONS) {
        status = 'pending_confirmation';
      } else if (confirmations < config.BTC_FINALITY_CONFIRMATIONS) {
        status = 'confirmed';
      } else {
        status = 'finalized';
      }

      const amountRaw = utxo.amount;
      const amountDisplay = satoshiToBtc(amountRaw);

      const deposit = depositsService.upsert({
        tenantId,
        chainId,
        assetId,
        walletId,
        address,
        amountRaw,
        amountDisplay,
        txHash: utxo.txHash,
        vout: utxo.vout,
        confirmations,
        status,
      });

      if (isNew) {
        logger.info('New deposit detected', { depositId: deposit.id, txHash: utxo.txHash, address, amount: amountDisplay });

        // Check for matching payment request
        const pendingPRs = paymentRequestsService.findPendingByAddress(address, chainId);
        for (const pr of pendingPRs) {
          // Associate deposit with payment request
          depositsService.updatePaymentRequestId(deposit.id, pr.id);

          // Update payment request status
          const newPrStatus = confirmations >= pr.confirmations_required ? 'paid' : 'detected';
          paymentRequestsService.updateStatus(pr.id, newPrStatus);

          // Emit payment request webhook
          webhooksService.queueEvent('payment_request.detected', {
            paymentRequestId: pr.id,
            depositId: deposit.id,
            txHash: utxo.txHash,
            amount: amountDisplay,
            confirmations,
          }, chainId, walletId, tenantId);

          if (newPrStatus === 'paid') {
            webhooksService.queueEvent('payment_request.paid', {
              paymentRequestId: pr.id,
              depositId: deposit.id,
              txHash: utxo.txHash,
              amount: amountDisplay,
              confirmations,
            }, chainId, walletId, tenantId);
          }
        }

        // Create ledger entry if ledger account exists for this wallet
        if (walletId) {
          const ledgerAccount = ledgerService.findAccountByWalletAndAsset(walletId, assetId);
          if (ledgerAccount) {
            try {
              ledgerService.addEntry({
                ledgerAccountId: ledgerAccount.id,
                type: 'deposit_pending',
                amountRaw,
                referenceType: 'deposit',
                referenceId: deposit.id,
                isPending: true,
              });
            } catch (err) {
              logger.warn('Failed to create ledger entry for deposit', { depositId: deposit.id, error: String(err) });
            }
          }
        }

        // Emit deposit webhook
        webhooksService.queueEvent('deposit.detected', {
          depositId: deposit.id,
          txHash: utxo.txHash,
          address,
          amount: amountDisplay,
          amountRaw,
          confirmations,
          status,
        }, chainId, walletId, tenantId);
      } else {
        // Update existing deposit — check for confirmation status change
        const existing = existingDeposits.find((d) => `${d.tx_hash}:${d.vout}` === key)!;

        if (existing.status !== status || existing.confirmations !== confirmations) {
          // Status changed — emit webhook if newly confirmed
          if (status === 'confirmed' && existing.status !== 'confirmed' && existing.status !== 'finalized') {
            webhooksService.queueEvent('deposit.confirmed', {
              depositId: deposit.id,
              txHash: utxo.txHash,
              address,
              amount: amountDisplay,
              confirmations,
              status,
            }, chainId, walletId, tenantId);

            // Update linked payment request
            if (deposit.payment_request_id) {
              paymentRequestsService.updateStatus(deposit.payment_request_id, 'paid');
              webhooksService.queueEvent('payment_request.paid', {
                paymentRequestId: deposit.payment_request_id,
                depositId: deposit.id,
                txHash: utxo.txHash,
                confirmations,
              }, chainId, walletId, tenantId);
            }

            // Settle ledger entry
            if (walletId) {
              const ledgerAccount = ledgerService.findAccountByWalletAndAsset(walletId, assetId);
              if (ledgerAccount) {
                try {
                  ledgerService.addEntry({
                    ledgerAccountId: ledgerAccount.id,
                    type: 'deposit_settled',
                    amountRaw,
                    referenceType: 'deposit',
                    referenceId: deposit.id,
                    isPending: false,
                  });
                } catch (err) {
                  logger.warn('Failed to create settled ledger entry', { depositId: deposit.id, error: String(err) });
                }
              }
            }
          }
        }
      }
    }
  }
}
