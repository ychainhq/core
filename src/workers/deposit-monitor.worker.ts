import { adapterRegistry } from '../chain-adapters/registry';
import { monitorsService } from '../modules/monitors/monitors.service';
import { depositsService } from '../modules/deposits/deposits.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { satoshiToBtc } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';
import { getDb } from '../db/sqlite';

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

  private getCustomerIdForAddress(address: string, chainId: string): string | null {
    const db = getDb();
    const row = db
      .prepare('SELECT customer_id FROM addresses WHERE chain_id = ? AND address = ? LIMIT 1')
      .get(chainId, address) as { customer_id: string | null } | undefined;
    return row?.customer_id ?? null;
  }

  private getDepositLedgerAccount(
    tenantId: string,
    customerId: string | null,
    walletId: string | undefined,
    assetId: string
  ) {
    return customerId
      ? ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, assetId)
      : (walletId ? ledgerService.findAccountByWalletAndAsset(walletId, assetId) : null);
  }

  private ledgerEntryExists(ledgerAccountId: string, type: string, depositId: string): boolean {
    const db = getDb();
    const row = db
      .prepare(`
        SELECT id FROM ledger_entries
        WHERE ledger_account_id = ?
          AND type = ?
          AND reference_type = 'deposit'
          AND reference_id = ?
        LIMIT 1
      `)
      .get(ledgerAccountId, type, depositId);
    return Boolean(row);
  }

  private ensureDepositPendingLedgerEntry(input: {
    tenantId: string;
    customerId: string | null;
    walletId: string | undefined;
    assetId: string;
    depositId: string;
    amountRaw: string;
  }): void {
    const ledgerAccount = this.getDepositLedgerAccount(input.tenantId, input.customerId, input.walletId, input.assetId);
    if (!ledgerAccount) return;

    const hasPending = this.ledgerEntryExists(ledgerAccount.id, 'deposit_pending', input.depositId);
    const hasSettled = this.ledgerEntryExists(ledgerAccount.id, 'deposit_settled', input.depositId);
    if (hasPending || hasSettled) return;

    try {
      ledgerService.addEntry({
        ledgerAccountId: ledgerAccount.id,
        type: 'deposit_pending',
        amountRaw: input.amountRaw,
        referenceType: 'deposit',
        referenceId: input.depositId,
        isPending: true,
      });
    } catch (err) {
      logger.warn('Failed to create ledger entry for deposit', { depositId: input.depositId, error: String(err) });
    }
  }

  private ensureDepositConfirmedEffects(input: {
    tenantId: string;
    customerId: string | null;
    walletId: string | undefined;
    chainId: string;
    assetId: string;
    depositId: string;
    txHash: string;
    address: string;
    amountRaw: string;
    amountDisplay: string;
    confirmations: number;
    status: string;
  }): void {
    this.ensureDepositPendingLedgerEntry(input);

    webhooksService.queueEventOnce('deposit.confirmed', {
      depositId: input.depositId,
      txHash: input.txHash,
      address: input.address,
      amount: input.amountDisplay,
      amountRaw: input.amountRaw,
      confirmations: input.confirmations,
      status: input.status,
    }, { depositId: input.depositId }, input.chainId, input.walletId, input.tenantId);

    const deposit = depositsService.getByIdInternal(input.depositId);
    if (deposit.payment_request_id) {
      paymentRequestsService.updateStatus(deposit.payment_request_id, 'paid');
      webhooksService.queueEventOnce('payment_request.paid', {
        paymentRequestId: deposit.payment_request_id,
        depositId: input.depositId,
        txHash: input.txHash,
        amount: input.amountDisplay,
        confirmations: input.confirmations,
      }, { depositId: input.depositId, paymentRequestId: deposit.payment_request_id }, input.chainId, input.walletId, input.tenantId);
    }

    const ledgerAccount = this.getDepositLedgerAccount(input.tenantId, input.customerId, input.walletId, input.assetId);
    if (!ledgerAccount) return;

    if (this.ledgerEntryExists(ledgerAccount.id, 'deposit_settled', input.depositId)) {
      return;
    }

    try {
      ledgerService.addEntry({
        ledgerAccountId: ledgerAccount.id,
        type: 'deposit_settled',
        amountRaw: input.amountRaw,
        referenceType: 'deposit',
        referenceId: input.depositId,
        isPending: false,
      });
    } catch (err) {
      logger.warn('Failed to create settled ledger entry', { depositId: input.depositId, error: String(err) });
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
    const customerId = this.getCustomerIdForAddress(address, chainId);

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
        customerId: customerId ?? undefined,
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
      const isConfirmationEligible = status === 'confirmed' || status === 'finalized';

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
          webhooksService.queueEventOnce('payment_request.detected', {
            paymentRequestId: pr.id,
            depositId: deposit.id,
            txHash: utxo.txHash,
            amount: amountDisplay,
            confirmations,
          }, { depositId: deposit.id, paymentRequestId: pr.id }, chainId, walletId, tenantId);

          if (newPrStatus === 'paid') {
            webhooksService.queueEventOnce('payment_request.paid', {
              paymentRequestId: pr.id,
              depositId: deposit.id,
              txHash: utxo.txHash,
              amount: amountDisplay,
              confirmations,
            }, { depositId: deposit.id, paymentRequestId: pr.id }, chainId, walletId, tenantId);
          }
        }

        this.ensureDepositPendingLedgerEntry({
          tenantId,
          customerId,
          walletId,
          assetId,
          depositId: deposit.id,
          amountRaw,
        });

        // Emit deposit webhook
        webhooksService.queueEventOnce('deposit.detected', {
          depositId: deposit.id,
          txHash: utxo.txHash,
          address,
          amount: amountDisplay,
          amountRaw,
          confirmations,
          status,
        }, { depositId: deposit.id }, chainId, walletId, tenantId);

        if (isConfirmationEligible) {
          this.ensureDepositConfirmedEffects({
            tenantId,
            customerId,
            walletId,
            chainId,
            assetId,
            depositId: deposit.id,
            txHash: utxo.txHash,
            address,
            amountRaw,
            amountDisplay,
            confirmations,
            status,
          });
        }
      } else {
        // Update existing deposit — check for confirmation status change
        const existing = existingDeposits.find((d) => `${d.tx_hash}:${d.vout}` === key)!;

        if (existing.status !== status || existing.confirmations !== confirmations) {
          if (isConfirmationEligible) {
            this.ensureDepositConfirmedEffects({
              tenantId,
              customerId,
              walletId,
              chainId,
              assetId,
              depositId: deposit.id,
              txHash: utxo.txHash,
              address,
              amountRaw,
              amountDisplay,
              confirmations,
              status,
            });
          }
        } else if (isConfirmationEligible) {
          this.ensureDepositConfirmedEffects({
            tenantId,
            customerId,
            walletId,
            chainId,
            assetId,
            depositId: deposit.id,
            txHash: utxo.txHash,
            address,
            amountRaw,
            amountDisplay,
            confirmations,
            status,
          });
        }
      }
    }
  }
}
