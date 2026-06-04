import { chainEventsService, ChainEvent } from '../modules/chain-events/chain-events.service';
import { depositsService } from '../modules/deposits/deposits.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { ledgerService } from '../modules/ledger/ledger.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { addressesService } from '../modules/addresses/addresses.service';
import { monitorsService } from '../modules/monitors/monitors.service';
import { utxoLockService } from '../shared/utxo-lock/utxo-lock.service';
import { satoshiToBtc } from '../shared/money/index';
import { logger } from '../shared/logging/index';
import { ticklerService } from '../shared/tickler/tickler.service';
import { tenantsService } from '../modules/tenants/tenants.service';

const BATCH_SIZE = 50;
const INTERVAL_MS = 5_000;

interface AddressContext {
  tenant_id: string;
  customer_id: string | null;
  wallet_id: string | null;
  wallet_role: string | null;
}

/**
 * ChainEventProcessorWorker (v3)
 *
 * Processes chain_events written by btc-indexer.
 * Replaces DepositMonitorWorker's deposit detection logic.
 * Runs alongside DepositMonitorWorker during the transition period (FAZA 1).
 *
 * Algorithm:
 * 1. Claim next batch of unprocessed chain_events (utxo_created / utxo_spent)
 * 2. For each utxo_created: look up address context → upsert deposit → apply effects
 * 3. For each utxo_spent: mark cached_utxo as spent
 * 4. Mark events processed
 */
export class ChainEventProcessorWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('ChainEventProcessorWorker started', { intervalMs: INTERVAL_MS });
    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('ChainEventProcessorWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, INTERVAL_MS);

    setImmediate(() => this.run().catch(err =>
      logger.error('ChainEventProcessorWorker initial run error', { error: String(err) })
    ));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('ChainEventProcessorWorker stopped');
    }
  }

  /**
   * Engine-side counterpart to btc-indexer's updateConfirmations().
   *
   * The two sides form a feedback loop that drives deposit status transitions:
   *
   *   btc-indexer: new block arrives → updateConfirmations() recalculates
   *     confirmations for all non-finalized events and resets processed=0 for
   *     events whose count just increased.
   *
   *   engine (here): picks up processed=0 events → upserts deposit with the
   *     new confirmation count → sets processed=1 via claimAndMarkProcessed().
   *
   * The same chain_event is therefore processed multiple times over its
   * lifetime — once per confirmation increase, until it reaches
   * finalityThreshold. Each pass gives depositsService.upsert() a chance to
   * transition the deposit:
   *
   *   conf=0  (mempool)  → deposit created, status=detected
   *   conf=1..N-1        → upsert updates confirmations, status stays detected
   *   conf=N             → status transitions to confirmed, confirmed effects fire
   *   conf>N..finality   → upsert is a no-op (previousStatus already confirmed,
   *                         isNew=false → no ticklers, no webhooks, no ledger entries)
   *
   * where N = tenant_configs.btc_confirmations_required (per-tenant).
   *
   * --- Multi-instance safety ---
   *
   * claimAndMarkProcessed() uses SELECT FOR UPDATE SKIP LOCKED + UPDATE in a
   * single transaction (PostgreSQL). Two engine instances polling concurrently
   * always receive disjoint batches — the same event is never processed twice
   * in parallel.
   *
   * --- Failure semantics ---
   *
   * processed=1 is written BEFORE business logic runs (inside claimAndMarkProcessed).
   * If processReceiveEvent() throws, the event stays processed=1 and is NOT
   * retried unless btc-indexer resets it on the next confirmation increase.
   * Individual event errors are caught and logged so one bad event cannot
   * block the rest of the batch.
   */
  async run(): Promise<void> {
    const events = await chainEventsService.claimAndMarkProcessed(BATCH_SIZE);
    if (events.length === 0) return;

    for (const event of events) {
      try {
        if (event.event_type === 'utxo_created') {
          await this.processReceiveEvent(event);
        } else if (event.event_type === 'utxo_spent') {
          await this.processSpentEvent(event);
        }
      } catch (err) {
        logger.warn('Failed to process chain event', { eventId: event.id, error: String(err) });
      }
    }
  }

  private async processReceiveEvent(event: ChainEvent): Promise<void> {
    logger.info('Processing utxo_created event (RECEIVE)', { eventId: event.id, txHash: event.tx_hash, address: event.address, amountRaw: event.amount_raw, confirmations: event.confirmations });
    if (!event.address || !event.amount_raw || event.vout_index === null){
      logger.warn('chain_event: missing required fields for utxo_created, skipping', {
        eventId: event.id, txHash: event.tx_hash
      });
      return;
    } 

    const ctx = await this.resolveAddressContext(event.address, event.chain_id);
    if (!ctx) {
      logger.warn('chain_event: address not found in engine DB, skipping', {
        address: event.address, txHash: event.tx_hash,
      });
      return;
    }

    const assetId = 'bitcoin:BTC';
    const confirmations = event.confirmations;
    const required = await tenantsService.getConfirmationsRequired(ctx.tenant_id);
    const status = this.confirmationsToStatus(confirmations, required);
    const amountDisplay = satoshiToBtc(event.amount_raw);

    const { deposit, isNew, previousStatus } = await depositsService.upsert({
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

    // as we receive, the new unspent UTXO should be registered as available for spending.
    await utxoLockService.upsertFromDeposit({
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
    
    if (isNew) {      
      logger.info('Deposit detected via chain_event', {
        depositId: deposit.id, txHash: event.tx_hash, address: event.address,
        amount: amountDisplay, confirmations, source: 'btc-indexer',
      });

      ticklerService.record({
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

      const pendingPRs = await paymentRequestsService.findPendingByAddressInternal(
        ctx.tenant_id, event.address, event.chain_id
      );
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
    // ok here is the tricky part - either here we have a new deposit with enough confirmations to be confirmed right away, or we have an existing deposit that just reached the confirmation threshold. In both cases we want to trigger the same "confirmed" effects, but only if we just transitioned to "confirmed" status (not on every update while already confirmed).
    // Transition gate: confirmed effects fire exactly once, when deposit moves detected→confirmed.
    // previousStatus=null means the deposit was just inserted (isNew=true).
    const isTransitionToConfirmed = status === 'confirmed' && previousStatus !== 'confirmed';
    if (isTransitionToConfirmed) {
      await this.ensureConfirmedEffects({ tenantId: ctx.tenant_id, customerId: ctx.customer_id, walletId: ctx.wallet_id, chainId: event.chain_id, assetId, depositId: deposit.id, txHash: event.tx_hash, address: event.address, amountRaw: event.amount_raw, amountDisplay, confirmations, status });
    }    
  }

  // Two deposit statuses: detected (below threshold) and confirmed (threshold reached).
  // N comes from tenant_configs.btc_confirmations_required (per-tenant).
  private confirmationsToStatus(confirmations: number, required: number): string {
    return confirmations >= required ? 'confirmed' : 'detected';
  }

  private async resolveAddressContext(address: string, chainId: string): Promise<AddressContext | null> {
    const ctx = await addressesService.resolveDepositContext(address, chainId);
    if (ctx) return ctx;

    const watched = await monitorsService.findActiveByAddress(address, chainId);
    if (!watched) return null;
    return { ...watched, wallet_role: null };
  }

  private async ensurePendingLedgerEntry(input: {
    tenantId: string; customerId: string | null; walletId: string | null;
    assetId: string; depositId: string; amountRaw: string;
  }): Promise<void> {
    const account = input.customerId
      ? await ledgerService.findAccountByCustomerAndAsset(input.tenantId, input.customerId, input.assetId)
      : (input.walletId ? await ledgerService.findAccountByWalletAndAsset(input.walletId, input.assetId) : null);
    if (!account) return;

    await ledgerService.ensureDepositEntry({
      ledgerAccountId: account.id,
      depositId: input.depositId,
      entryType: 'deposit_pending',
      amountRaw: input.amountRaw,
      isPending: true,
    });
  }

  private async ensureConfirmedEffects(input: {
    tenantId: string; customerId: string | null; walletId: string | null; chainId: string;
    assetId: string; depositId: string; txHash: string; address: string;
    amountRaw: string; amountDisplay: string; confirmations: number; status: string;
  }): Promise<void> {
    await this.ensurePendingLedgerEntry(input);

    webhooksService.queueEventOnce('deposit.confirmed', {
      depositId: input.depositId, txHash: input.txHash, address: input.address,
      amount: input.amountDisplay, amountRaw: input.amountRaw, confirmations: input.confirmations, status: input.status,
    }, { depositId: input.depositId }, input.chainId, input.walletId ?? undefined, input.tenantId);

    ticklerService.record({
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

    await ledgerService.ensureDepositEntry({
      ledgerAccountId: account.id,
      depositId: input.depositId,
      entryType: 'deposit_settled',
      amountRaw: input.amountRaw,
      isPending: false,
    });
  }

  private async processSpentEvent(event: ChainEvent): Promise<void> {
    const { spent_tx_hash: spentTxHash, spent_vout: spentVout } = event;
    if (!spentTxHash || spentVout === null) return;

    await utxoLockService.markSpentByUtxo(event.chain_id, spentTxHash, spentVout);

    logger.debug('UTXO marked as spent via chain_event', {
      spentTxHash, spentVout, spendingTxHash: event.tx_hash, chainId: event.chain_id,
    });
  }
}
