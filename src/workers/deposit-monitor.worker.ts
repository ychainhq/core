import crypto from 'crypto';
import { adapterRegistry } from '../chain-adapters/registry';
import { depositsService } from '../modules/deposits/deposits.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { satoshiToBtc } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';
import { getDb } from '../db/sqlite';
import { ticklerService } from '../shared/tickler/tickler.service';

/**
 * DepositMonitorWorker
 *
 * Polls watched Bitcoin addresses for new deposits and confirmation updates.
 * Runs every DEPOSIT_MONITOR_INTERVAL_MS (default: 30 seconds).
 *
 * Algorithm:
 * 1. Find tenants with active watched addresses for chain=bitcoin
 * 2. For each tenant, scan the tenant FWallet once via listunspent
 * 3. Upsert cached_utxos and mark missing cached UTXOs spent
 * 4. Compare current wallet UTXOs with existing deposits
 * 5. Create/update deposit records and ledger/webhook effects
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
    const db = getDb();
    const tenantRows = db.prepare(`
      SELECT DISTINCT tenant_id
      FROM watched_addresses
      WHERE chain_id = ? AND is_active = 1 AND tenant_id IS NOT NULL
      ORDER BY tenant_id
    `).all(chainId) as Array<{ tenant_id: string }>;

    if (tenantRows.length === 0) return;

    try {
      await adapter.getBlockCount();
    } catch (err) {
      logger.warn('Failed to get block count, skipping deposit monitor run', { error: String(err) });
      return;
    }

    for (const { tenant_id: tenantId } of tenantRows) {
      try {
        await this.processTenantWallet(tenantId, chainId);
      } catch (err) {
        logger.warn('Failed to process tenant wallet deposits', { tenantId, error: String(err) });
      }
    }
  }

  private getAddressContextByTenant(tenantId: string, chainId: string): Map<string, {
    address: string;
    tenant_id: string;
    customer_id: string | null;
    wallet_id: string | null;
    wallet_role: string | null;
  }> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT a.address, a.tenant_id, a.customer_id, a.wallet_id, w.wallet_role
      FROM addresses a
      LEFT JOIN wallets w ON w.id = a.wallet_id
      WHERE a.tenant_id = ?
        AND a.chain_id = ?
        AND a.status = 'active'
    `).all(tenantId, chainId) as Array<{
      address: string;
      tenant_id: string;
      customer_id: string | null;
      wallet_id: string | null;
      wallet_role: string | null;
    }>;

    const byAddress = new Map(rows.map((row) => [row.address, row]));

    const watchedOnly = db.prepare(`
      SELECT address, tenant_id, customer_id, wallet_id
      FROM watched_addresses
      WHERE tenant_id = ?
        AND chain_id = ?
        AND is_active = 1
    `).all(tenantId, chainId) as Array<{
      address: string;
      tenant_id: string;
      customer_id: string | null;
      wallet_id: string | null;
    }>;

    for (const row of watchedOnly) {
      if (!byAddress.has(row.address)) {
        byAddress.set(row.address, { ...row, wallet_role: null });
      }
    }

    return byAddress;
  }

  private async getTenantWalletUtxos(
    tenantId: string,
    chainId: string,
    knownAddresses: string[],
  ): Promise<any[]> {
    const adapter = adapterRegistry.get(chainId);
    if (adapter.getWalletUtxos) {
      return adapter.getWalletUtxos(tenantId, 0);
    }

    const all: any[] = [];
    for (const address of knownAddresses) {
      const utxos = await adapter.getUtxosForAddress(address, 0, tenantId);
      all.push(...utxos);
    }
    return all;
  }

  private syncCachedUtxos(input: {
    tenantId: string;
    chainId: string;
    utxos: any[];
    addressContext: Map<string, {
      customer_id: string | null;
      wallet_id: string | null;
      wallet_role: string | null;
    }>;
  }): void {
    const db = getDb();
    const now = new Date().toISOString();
    const seen = new Set<string>();

    db.transaction(() => {
      for (const utxo of input.utxos) {
        const ctx = input.addressContext.get(utxo.address);
        if (!ctx) continue;

        seen.add(`${utxo.txHash}:${utxo.vout}`);
        const id = `utxo_${crypto.randomBytes(8).toString('hex')}`;

        db.prepare(`
          INSERT INTO cached_utxos (
            id, tenant_id, customer_id, wallet_id, wallet_role,
            chain_id, address, tx_hash, vout, amount_raw, script_pub_key,
            confirmations, is_spent, is_locked, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
          ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            customer_id = excluded.customer_id,
            wallet_id = excluded.wallet_id,
            wallet_role = excluded.wallet_role,
            address = excluded.address,
            amount_raw = excluded.amount_raw,
            script_pub_key = excluded.script_pub_key,
            confirmations = excluded.confirmations,
            is_spent = 0,
            updated_at = excluded.updated_at
        `).run(
          id,
          input.tenantId,
          ctx.customer_id,
          ctx.wallet_id,
          ctx.wallet_role,
          input.chainId,
          utxo.address,
          utxo.txHash,
          utxo.vout,
          utxo.amount,
          utxo.scriptPubKey ?? null,
          utxo.confirmations ?? 0,
          now,
          now,
        );
      }

      const cached = db.prepare(`
        SELECT tx_hash, vout
        FROM cached_utxos
        WHERE tenant_id = ?
          AND chain_id = ?
          AND is_spent = 0
      `).all(input.tenantId, input.chainId) as Array<{ tx_hash: string; vout: number }>;

      for (const row of cached) {
        if (!seen.has(`${row.tx_hash}:${row.vout}`)) {
          db.prepare(`
            UPDATE cached_utxos
            SET is_spent = 1, is_locked = 0, updated_at = ?
            WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
          `).run(now, input.tenantId, input.chainId, row.tx_hash, row.vout);
        }
      }
    })();
  }

  private getExistingDepositMap(tenantId: string, chainId: string): Map<string, any> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT *
      FROM deposits
      WHERE tenant_id = ?
        AND chain_id = ?
    `).all(tenantId, chainId) as any[];
    return new Map(rows.map((row) => [`${row.tx_hash}:${row.vout}`, row]));
  }

  private getPendingPaymentRequestsByAddress(tenantId: string, chainId: string): Map<string, any[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, address, confirmations_required
      FROM payment_requests
      WHERE tenant_id = ?
        AND chain_id = ?
        AND status IN ('pending', 'detected', 'partially_paid')
      ORDER BY created_at DESC
    `).all(tenantId, chainId) as Array<{ id: string; address: string; confirmations_required: number }>;

    const byAddress = new Map<string, any[]>();
    for (const row of rows) {
      const list = byAddress.get(row.address) ?? [];
      list.push(row);
      byAddress.set(row.address, list);
    }
    return byAddress;
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
    ticklerService.record({
      tenantId: input.tenantId,
      category: 'deposit',
      subcategory: 'confirmed',
      entityId: input.depositId,
      actorLogin: 'system:deposit-monitor',
      field1: input.txHash,
      field2: String(input.confirmations),
      field3: input.status,
    });

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

  private async processTenantWallet(tenantId: string, chainId: string): Promise<void> {
    const assetId = 'bitcoin:BTC';
    const addressContext = this.getAddressContextByTenant(tenantId, chainId);
    if (addressContext.size === 0) return;

    let utxos: any[];
    try {
      utxos = await this.getTenantWalletUtxos(tenantId, chainId, [...addressContext.keys()]);
    } catch (err) {
      logger.warn('Failed to get tenant wallet UTXOs', { tenantId, error: String(err) });
      return;
    }

    const knownUtxos = utxos.filter((utxo) => addressContext.has(utxo.address));
    this.syncCachedUtxos({ tenantId, chainId, utxos: knownUtxos, addressContext });

    const existingDeposits = this.getExistingDepositMap(tenantId, chainId);
    const pendingPaymentRequestsByAddress = this.getPendingPaymentRequestsByAddress(tenantId, chainId);

    for (const utxo of knownUtxos) {
      const ctx = addressContext.get(utxo.address);
      if (!ctx) continue;

      const address = utxo.address;
      const customerId = ctx.customer_id;
      const walletId = ctx.wallet_id ?? undefined;
      const key = `${utxo.txHash}:${utxo.vout}`;
      const existing = existingDeposits.get(key);
      const isNew = !existing;

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
        ticklerService.record({
          tenantId,
          category: 'deposit',
          subcategory: 'detected',
          entityId: deposit.id,
          actorLogin: 'system:deposit-monitor',
          field1: utxo.txHash,
          field2: address,
          field3: amountRaw,
          field4: customerId ?? null,
          newValue: deposit,
        });

        // Check for matching payment request
        const pendingPRs = pendingPaymentRequestsByAddress.get(address) ?? [];
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
