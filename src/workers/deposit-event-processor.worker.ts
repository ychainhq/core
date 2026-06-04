import crypto from 'crypto';
import { getDbClient } from '../db/client';
import { depositsService } from '../modules/deposits/deposits.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { satoshiToBtc } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';
import { ticklerService } from '../shared/tickler/tickler.service';

const BATCH_SIZE = 50;
const INTERVAL_MS = 5_000;

interface ChainEvent {
  id: string;
  chain_id: string;
  node_id: string;
  event_type: string;
  tx_hash: string;
  vout_index: number | null;
  spent_tx_hash: string | null;  // utxo_spent: original tx being spent
  spent_vout: number | null;     // utxo_spent: original output index being spent
  address: string | null;
  amount_raw: string | null;
  block_height: number | null;
  block_hash: string | null;
  confirmations: number;
  created_at: string;
}

interface AddressContext {
  tenant_id: string;
  customer_id: string | null;
  wallet_id: string | null;
  wallet_role: string | null;
}

/**
 * DepositEventProcessorWorker (v3)
 *
 * Processes chain_events written by btc-indexer.
 * Replaces DepositMonitorWorker's deposit detection logic.
 * Runs alongside DepositMonitorWorker during the transition period (FAZA 1).
 *
 * Algorithm:
 * 1. Claim next batch of unprocessed chain_events (utxo_created)
 * 2. For each event: look up address context (tenant, customer, wallet)
 * 3. Upsert deposit record + cached_utxo
 * 4. Apply ledger / webhook effects (same as DepositMonitorWorker)
 * 5. Mark event processed
 */
export class DepositEventProcessorWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('DepositEventProcessorWorker started', { intervalMs: INTERVAL_MS });
    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('DepositEventProcessorWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, INTERVAL_MS);

    setImmediate(() => this.run().catch(err =>
      logger.error('DepositEventProcessorWorker initial run error', { error: String(err) })
    ));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('DepositEventProcessorWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDbClient();

    // Process both utxo_created and utxo_spent events
    const events = await db.all<ChainEvent>(`
      SELECT * FROM chain_events
      WHERE processed = 0
        AND event_type IN ('utxo_created', 'utxo_spent')
      ORDER BY created_at ASC
      LIMIT ?
    `, [BATCH_SIZE]);

    if (events.length === 0) return;

    // Mark as processed immediately to prevent double-processing
    const ids = events.map(e => e.id);
    await db.run(`
      UPDATE chain_events
      SET processed = 1, processed_at = ?
      WHERE id IN (${ids.map(() => '?').join(',')})
    `, [new Date().toISOString(), ...ids]);

    for (const event of events) {
      try {
        if (event.event_type === 'utxo_created') {
          await this.processEvent(event);
        } else if (event.event_type === 'utxo_spent') {
          await this.processSpentEvent(event);
        }
      } catch (err) {
        logger.warn('Failed to process chain event', { eventId: event.id, error: String(err) });
      }
    }
  }

  private async processEvent(event: ChainEvent): Promise<void> {
    if (!event.address || !event.amount_raw || event.vout_index === null) return;

    const ctx = await this.resolveAddressContext(event.address, event.chain_id);
    if (!ctx) {
      logger.debug('chain_event: address not found in engine DB, skipping', {
        address: event.address, txHash: event.tx_hash,
      });
      return;
    }

    const assetId = 'bitcoin:BTC';
    const confirmations = event.confirmations;
    const status = this.confirmationsToStatus(confirmations);
    const amountDisplay = satoshiToBtc(event.amount_raw);

    const { deposit, isNew } = await depositsService.upsert({
      tenantId: ctx.tenant_id,
      customerId: ctx.customer_id ?? undefined,
      chainId: event.chain_id,
      assetId,
      walletId: ctx.wallet_id ?? undefined,
      address: event.address,
      amountRaw: event.amount_raw,
      amountDisplay,
      txHash: event.tx_hash,
      vout: event.vout_index,
      confirmations,
      status,
    });

    // Sync cached_utxos (same as DepositMonitorWorker)
    await this.upsertCachedUtxo({
      tenantId: ctx.tenant_id,
      customerId: ctx.customer_id,
      walletId: ctx.wallet_id,
      walletRole: ctx.wallet_role,
      chainId: event.chain_id,
      address: event.address,
      txHash: event.tx_hash,
      vout: event.vout_index,
      amountRaw: event.amount_raw,
      confirmations,
    });

    const isConfirmed = status === 'confirmed' || status === 'finalized';

    // New deposit: emit detected event + check payment request
    if (confirmations === 0 || isNew) {
      logger.info('Deposit detected via chain_event', {
        depositId: deposit.id, txHash: event.tx_hash, address: event.address,
        amount: amountDisplay, confirmations, source: 'btc-indexer',
      });

      await ticklerService.record({
        tenantId: ctx.tenant_id,
        category: 'deposit',
        subcategory: 'detected',
        entityId: deposit.id,
        actorLogin: 'system:deposit-event-processor',
        field1: event.tx_hash,
        field2: event.address,
        field3: event.amount_raw,
        field4: ctx.customer_id ?? null,
      });

      const pendingPRs = await this.getPendingPaymentRequests(ctx.tenant_id, event.address, event.chain_id);
      for (const pr of pendingPRs) {
        await depositsService.updatePaymentRequestId(deposit.id, pr.id);
        const newPrStatus = confirmations >= pr.confirmations_required ? 'paid' : 'detected';
        await paymentRequestsService.updateStatus(pr.id, newPrStatus);
        webhooksService.queueEventOnce('payment_request.detected', {
          paymentRequestId: pr.id, depositId: deposit.id,
          txHash: event.tx_hash, amount: amountDisplay, confirmations,
        }, { depositId: deposit.id, paymentRequestId: pr.id }, event.chain_id, ctx.wallet_id ?? undefined, ctx.tenant_id);
      }

      await this.ensurePendingLedgerEntry({ tenantId: ctx.tenant_id, customerId: ctx.customer_id, walletId: ctx.wallet_id, assetId, depositId: deposit.id, amountRaw: event.amount_raw });

      webhooksService.queueEventOnce('deposit.detected', {
        depositId: deposit.id, txHash: event.tx_hash, address: event.address,
        amount: amountDisplay, amountRaw: event.amount_raw, confirmations, status,
      }, { depositId: deposit.id }, event.chain_id, ctx.wallet_id ?? undefined, ctx.tenant_id);
    }

    if (isConfirmed) {
      await this.ensureConfirmedEffects({ tenantId: ctx.tenant_id, customerId: ctx.customer_id, walletId: ctx.wallet_id, chainId: event.chain_id, assetId, depositId: deposit.id, txHash: event.tx_hash, address: event.address, amountRaw: event.amount_raw, amountDisplay, confirmations, status });
    }
  }

  private confirmationsToStatus(confirmations: number): string {
    if (confirmations === 0) return 'detected';
    if (confirmations < config.BTC_DEFAULT_CONFIRMATIONS) return 'pending_confirmation';
    if (confirmations < config.BTC_FINALITY_CONFIRMATIONS) return 'confirmed';
    return 'finalized';
  }

  private async resolveAddressContext(address: string, chainId: string): Promise<AddressContext | null> {
    const db = getDbClient();
    const row = await db.get<AddressContext>(`
      SELECT a.tenant_id, a.customer_id, a.wallet_id, w.wallet_role
      FROM addresses a
      LEFT JOIN wallets w ON w.id = a.wallet_id
      WHERE a.address = ? AND a.chain_id = ? AND a.status = 'active'
      LIMIT 1
    `, [address, chainId]);

    if (row) return row;

    // Fallback: watched_addresses
    const watched = await db.get<AddressContext>(`
      SELECT tenant_id, customer_id, wallet_id, NULL as wallet_role
      FROM watched_addresses
      WHERE address = ? AND chain_id = ? AND is_active = 1
      LIMIT 1
    `, [address, chainId]);

    return watched ?? null;
  }

  private async getPendingPaymentRequests(tenantId: string, address: string, chainId: string): Promise<Array<{ id: string; confirmations_required: number }>> {
    const db = getDbClient();
    return db.all<{ id: string; confirmations_required: number }>(`
      SELECT id, confirmations_required FROM payment_requests
      WHERE tenant_id = ? AND chain_id = ? AND address = ?
        AND status IN ('pending', 'detected', 'partially_paid')
      ORDER BY created_at DESC
    `, [tenantId, chainId, address]);
  }

  private async upsertCachedUtxo(input: {
    tenantId: string; customerId: string | null; walletId: string | null; walletRole: string | null;
    chainId: string; address: string; txHash: string; vout: number;
    amountRaw: string; confirmations: number;
  }): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const id = `utxo_${crypto.randomBytes(8).toString('hex')}`;
    await db.run(`
      INSERT INTO cached_utxos (
        id, tenant_id, customer_id, wallet_id, wallet_role, chain_id,
        address, tx_hash, vout, amount_raw, confirmations, is_spent, is_locked, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
        confirmations = excluded.confirmations,
        is_spent = 0,
        updated_at = excluded.updated_at
    `, [id, input.tenantId, input.customerId, input.walletId, input.walletRole, input.chainId,
      input.address, input.txHash, input.vout, input.amountRaw, input.confirmations, now, now]);
  }

  private async ensurePendingLedgerEntry(input: { tenantId: string; customerId: string | null; walletId: string | null; assetId: string; depositId: string; amountRaw: string }): Promise<void> {
    const account = input.customerId
      ? await ledgerService.findAccountByCustomerAndAsset(input.tenantId, input.customerId, input.assetId)
      : (input.walletId ? await ledgerService.findAccountByWalletAndAsset(input.walletId, input.assetId) : null);
    if (!account) return;

    const db = getDbClient();
    const exists = await db.get(`
      SELECT id FROM ledger_entries WHERE ledger_account_id = ? AND type = 'deposit_pending'
        AND reference_type = 'deposit' AND reference_id = ? LIMIT 1
    `, [account.id, input.depositId]);
    if (exists) return;

    try {
      await ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: input.amountRaw, referenceType: 'deposit', referenceId: input.depositId, isPending: true });
    } catch (err) {
      logger.warn('Failed to create pending ledger entry', { depositId: input.depositId, error: String(err) });
    }
  }

  private async ensureConfirmedEffects(input: { tenantId: string; customerId: string | null; walletId: string | null; chainId: string; assetId: string; depositId: string; txHash: string; address: string; amountRaw: string; amountDisplay: string; confirmations: number; status: string }): Promise<void> {
    await this.ensurePendingLedgerEntry(input);

    webhooksService.queueEventOnce('deposit.confirmed', {
      depositId: input.depositId, txHash: input.txHash, address: input.address,
      amount: input.amountDisplay, amountRaw: input.amountRaw, confirmations: input.confirmations, status: input.status,
    }, { depositId: input.depositId }, input.chainId, input.walletId ?? undefined, input.tenantId);

    await ticklerService.record({
      tenantId: input.tenantId,
      category: 'deposit',
      subcategory: 'confirmed',
      entityId: input.depositId,
      actorLogin: 'system:deposit-event-processor',
      field1: input.txHash,
      field2: String(input.confirmations),
      field3: input.status,
    });

    const deposit = await depositsService.getByIdInternal(input.depositId);
    if (deposit.payment_request_id) {
      await paymentRequestsService.updateStatus(deposit.payment_request_id, 'paid');
      webhooksService.queueEventOnce('payment_request.paid', {
        paymentRequestId: deposit.payment_request_id, depositId: input.depositId,
        txHash: input.txHash, amount: input.amountDisplay, confirmations: input.confirmations,
      }, { depositId: input.depositId, paymentRequestId: deposit.payment_request_id }, input.chainId, input.walletId ?? undefined, input.tenantId);
    }

    const account = input.customerId
      ? await ledgerService.findAccountByCustomerAndAsset(input.tenantId, input.customerId, input.assetId)
      : (input.walletId ? await ledgerService.findAccountByWalletAndAsset(input.walletId, input.assetId) : null);
    if (!account) return;

    const db = getDbClient();
    const alreadySettled = await db.get(`
      SELECT id FROM ledger_entries WHERE ledger_account_id = ? AND type = 'deposit_settled'
        AND reference_type = 'deposit' AND reference_id = ? LIMIT 1
    `, [account.id, input.depositId]);
    if (alreadySettled) return;

    try {
      await ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_settled', amountRaw: input.amountRaw, referenceType: 'deposit', referenceId: input.depositId, isPending: false });
    } catch (err) {
      logger.warn('Failed to create settled ledger entry', { depositId: input.depositId, error: String(err) });
    }
  }

  /**
   * Mark a spent UTXO in cached_utxos.
   * Called for utxo_spent chain_events — the btc-indexer emits these when it sees
   * a known UTXO used as an input in a confirmed block (e.g. sweep tx inputs).
   */
  private async processSpentEvent(event: ChainEvent): Promise<void> {
    if (!event.spent_tx_hash && event.vout_index === null) return;
    const db = getDbClient();

    // The spent UTXO is identified by spent_tx_hash + spent_vout
    // (tx_hash here is the spending transaction, not the original deposit tx)
    const { spent_tx_hash: spentTxHash, spent_vout: spentVout } = event;
    if (!spentTxHash || spentVout === null) return;

    await db.run(
      'UPDATE cached_utxos SET is_spent = 1, is_locked = 0, updated_at = ? WHERE chain_id = ? AND tx_hash = ? AND vout = ?',
      [new Date().toISOString(), event.chain_id, spentTxHash, spentVout]
    );

    logger.debug('UTXO marked as spent via chain_event', {
      spentTxHash, spentVout, spendingTxHash: event.tx_hash, chainId: event.chain_id,
    });
  }
}
