import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, UnprocessableEntityError, ValidationError } from '../../shared/errors/index';
import { ledgerService } from '../ledger/ledger.service';
import { webhooksService } from '../webhooks/webhooks.service';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { logger } from '../../shared/logging/index';
import { toUnixTs } from '../../shared/time/index';
import { ticklerService } from '../../shared/tickler/tickler.service';

export interface CustomerWithdrawal {
  id: string;
  tenant_id: string;
  customer_id: string;
  chain_id: string;
  asset_id: string;
  to_address: string;
  amount_raw: string;
  fee_raw: string | null;
  psbt: string | null;
  signed_psbt: string | null;
  tx_hash: string | null;
  status: string;
  error: string | null;
  idempotency_key: string | null;
  withdrawal_type: 'external' | 'internal';
  recipient_customer_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapWithdrawal(row: any): CustomerWithdrawal {
  return {
    ...row,
    withdrawal_type: row.withdrawal_type ?? 'external',
    recipient_customer_id: row.recipient_customer_id ?? null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export const withdrawalsService = {
  /**
   * Initiate a customer withdrawal.
   *
   * If toAddress belongs to another customer on the same tenant, the transfer
   * is settled immediately as an internal ledger transfer (withdrawal_type='internal').
   * Otherwise the external path is used: balance reservation + batched broadcast.
   */
  async create(
    tenantId: string,
    customerId: string,
    input: {
      toAddress: string;
      amountSats: string;
      idempotencyKey?: string;
    }
  ): Promise<CustomerWithdrawal> {
    const db = getDb();

    // Idempotency check
    if (input.idempotencyKey) {
      const existing = db
        .prepare('SELECT * FROM customer_withdrawals WHERE tenant_id = ? AND idempotency_key = ?')
        .get(tenantId, input.idempotencyKey) as any | undefined;
      if (existing) return mapWithdrawal(existing);
    }

    const assetId = 'bitcoin:BTC';
    const amountBigInt = BigInt(input.amountSats);
    if (amountBigInt <= 0n) {
      throw new ValidationError('amountSats must be greater than zero');
    }

    // Check sender balance
    const senderAccount = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, assetId);
    if (!senderAccount) {
      throw new UnprocessableEntityError('No BTC ledger account found for this customer');
    }
    const balance = ledgerService.getBalance(senderAccount.id);
    if (BigInt(balance.settled) < amountBigInt) {
      throw new UnprocessableEntityError(
        `Insufficient balance: available ${balance.settled} sats, requested ${input.amountSats} sats`
      );
    }

    // On-platform detection: is toAddress a registered customer deposit address for this tenant?
    const platformAddr = db
      .prepare(
        "SELECT customer_id FROM addresses WHERE address = ? AND tenant_id = ? AND address_role = 'customer_deposit' LIMIT 1"
      )
      .get(input.toAddress, tenantId) as { customer_id: string } | undefined;

    if (platformAddr) {
      return withdrawalsService._executeInternalTransfer(db, {
        tenantId,
        senderCustomerId: customerId,
        recipientCustomerId: platformAddr.customer_id,
        senderAccount,
        amountBigInt,
        toAddress: input.toAddress,
        idempotencyKey: input.idempotencyKey,
      });
    }

    // External path — validate BTC address before reserving
    const adapter = new BitcoinAdapter();
    if (!adapter.isValidAddress(input.toAddress)) {
      throw new ValidationError(`Invalid bitcoin address: ${input.toAddress}`);
    }

    // Persist withdrawal record
    const id = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, fee_raw, psbt,
         status, idempotency_key, withdrawal_type, recipient_customer_id, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, ?, NULL, NULL, 'queued', ?, 'external', NULL, ?, ?)
    `).run(
      id, tenantId, customerId,
      input.toAddress, input.amountSats,
      input.idempotencyKey ?? null,
      now, now
    );

    // Reserve customer balance immediately — prevents double-spend while PSBT awaits signing
    ledgerService.addEntry({
      ledgerAccountId: senderAccount.id,
      type: 'withdrawal_reserve',
      amountRaw: (-amountBigInt).toString(),
      referenceType: 'customer_withdrawal',
      referenceId: id,
    });

    const withdrawal = withdrawalsService.getByIdInternal(id);

    // Fire lightweight lifecycle webhook. Signing-specific events are emitted
    // after the batcher creates a PSBT/signing task.
    webhooksService.queueEvent(
      'withdrawal.queued',
      {
        withdrawalId: id,
        tenantId,
        customerId,
        toAddress: input.toAddress,
        amountSats: input.amountSats,
      },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('Customer withdrawal queued', { id, tenantId, customerId, amountSats: input.amountSats });
    return withdrawal;
  },

  _executeInternalTransfer(
    db: ReturnType<typeof getDb>,
    opts: {
      tenantId: string;
      senderCustomerId: string;
      recipientCustomerId: string;
      senderAccount: { id: string };
      amountBigInt: bigint;
      toAddress: string;
      idempotencyKey?: string;
    }
  ): CustomerWithdrawal {
    const { tenantId, senderCustomerId, recipientCustomerId, senderAccount, amountBigInt, toAddress, idempotencyKey } = opts;

    if (senderCustomerId === recipientCustomerId) {
      throw new ValidationError('Cannot transfer to your own deposit address');
    }

    // Verify recipient is active
    const recipient = db
      .prepare("SELECT id, status FROM customers WHERE id = ? AND tenant_id = ?")
      .get(recipientCustomerId, tenantId) as { id: string; status: string } | undefined;
    if (!recipient || recipient.status !== 'active') {
      throw new UnprocessableEntityError('Recipient customer is not active');
    }

    // Verify recipient has a BTC ledger account
    const recipientAccount = ledgerService.findAccountByCustomerAndAsset(tenantId, recipientCustomerId, 'bitcoin:BTC');
    if (!recipientAccount) {
      throw new UnprocessableEntityError('Recipient has no BTC ledger account');
    }

    const id = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const doTransfer = db.transaction(() => {
      db.prepare(`
        INSERT INTO customer_withdrawals
          (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, fee_raw, psbt,
           status, idempotency_key, withdrawal_type, recipient_customer_id, created_at, updated_at)
        VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, ?, '0', NULL, 'confirmed', ?, 'internal', ?, ?, ?)
      `).run(
        id, tenantId, senderCustomerId,
        toAddress, amountBigInt.toString(),
        idempotencyKey ?? null,
        recipientCustomerId,
        now, now
      );

      ledgerService.transfer({
        fromLedgerAccountId: senderAccount.id,
        toLedgerAccountId: recipientAccount.id,
        assetId: 'bitcoin:BTC',
        amountRaw: amountBigInt.toString(),
        reference: id,
        isPending: false,
      });
    });

    doTransfer();

    const withdrawal = withdrawalsService.getByIdInternal(id);

    ticklerService.record({
      tenantId,
      category: 'withdrawal',
      subcategory: 'internal_transfer',
      entityId: id,
      actorLogin: `customer:${senderCustomerId}`,
      field1: toAddress,
      field2: amountBigInt.toString(),
      field3: senderCustomerId,
      field4: recipientCustomerId,
      newValue: withdrawal,
    });

    webhooksService.queueEvent(
      'withdrawal.internal_transfer',
      {
        withdrawalId: id,
        tenantId,
        senderCustomerId,
        recipientCustomerId,
        toAddress,
        amountSats: amountBigInt.toString(),
      },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('Internal transfer completed', { id, tenantId, senderCustomerId, recipientCustomerId, amountSats: amountBigInt.toString() });
    return withdrawal;
  },

  list(
    tenantId: string,
    customerId: string,
    filters: { status?: string; toAddress?: string; limit?: number; cursor?: string } = {}
  ): { data: CustomerWithdrawal[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customer_withdrawals WHERE tenant_id = ? AND customer_id = ?';
    const params: unknown[] = [tenantId, customerId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.toAddress) { query += ' AND to_address LIKE ?'; params.push(filters.toAddress); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items.map(mapWithdrawal), nextCursor: hasMore ? items[items.length - 1].id : null };
  },

  listForTenant(
    tenantId: string,
    filters: { status?: string; limit?: number; cursor?: string } = {}
  ): { data: CustomerWithdrawal[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customer_withdrawals WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items.map(mapWithdrawal), nextCursor: hasMore ? items[items.length - 1].id : null };
  },

  getById(tenantId: string, id: string): CustomerWithdrawal {
    const db = getDb();
    const row = db.prepare('SELECT * FROM customer_withdrawals WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Withdrawal', id);
    return mapWithdrawal(row);
  },

  getByIdInternal(id: string): CustomerWithdrawal {
    const db = getDb();
    const row = db.prepare('SELECT * FROM customer_withdrawals WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Withdrawal', id);
    return mapWithdrawal(row);
  },

  updateStatus(
    id: string,
    status: string,
    extra: { signedPsbt?: string; txHash?: string; error?: string } = {}
  ): CustomerWithdrawal {
    const db = getDb();
    const now = new Date().toISOString();
    const sets = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.signedPsbt !== undefined) { sets.push('signed_psbt = ?'); params.push(extra.signedPsbt); }
    if (extra.txHash !== undefined) { sets.push('tx_hash = ?'); params.push(extra.txHash); }
    if (extra.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }

    params.push(id);
    db.prepare(`UPDATE customer_withdrawals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return withdrawalsService.getByIdInternal(id);
  },

  /**
   * Submit a signed PSBT for a withdrawal (called by signing daemon).
   * Finalizes, broadcasts, and debits the customer ledger.
   */
  async submitSigned(
    tenantId: string,
    withdrawalId: string,
    signedPsbt: string
  ): Promise<CustomerWithdrawal> {
    const withdrawal = withdrawalsService.getById(tenantId, withdrawalId);

    if (withdrawal.status !== 'pending_signature') {
      throw new ValidationError(
        `Withdrawal is in status '${withdrawal.status}', expected 'pending_signature'`
      );
    }

    const adapter = new BitcoinAdapter();
    let txHash: string;
    try {
      const finalizedResult = await adapter.finalizePsbt(signedPsbt);
      if (!finalizedResult.complete) {
        throw new Error('PSBT is not fully signed — missing signatures');
      }
      txHash = await (adapter as any).sendRawTransaction(finalizedResult.hex);
    } catch (err: any) {
      withdrawalsService.updateStatus(withdrawalId, 'failed', { error: String(err) });
      // Refund the reservation made at create() — broadcast failed, balance is restored
      const custAccount = ledgerService.findAccountByCustomerAndAsset(
        tenantId, withdrawal.customer_id, withdrawal.asset_id
      );
      if (custAccount) {
        ledgerService.addEntry({
          ledgerAccountId: custAccount.id,
          type: 'withdrawal_refund',
          amountRaw: withdrawal.amount_raw,
          referenceType: 'customer_withdrawal',
          referenceId: withdrawalId,
        });
      }
      throw new ValidationError(`Failed to broadcast withdrawal: ${err?.message ?? err}`);
    }

    const updated = withdrawalsService.updateStatus(withdrawalId, 'broadcast', { signedPsbt, txHash });

    // Debit tenant hot wallet control — funds have left the hot wallet
    const hotAccount = ledgerService.findAccountByTenantAndType(tenantId, 'tenant_hot_control');
    if (hotAccount) {
      const totalOut = BigInt(withdrawal.amount_raw) + BigInt(withdrawal.fee_raw ?? '0');
      ledgerService.addEntry({
        ledgerAccountId: hotAccount.id,
        type: 'hot_debit',
        amountRaw: (-totalOut).toString(),
        referenceType: 'customer_withdrawal',
        referenceId: withdrawalId,
      });
    }

    // Record network fee expense
    if (withdrawal.fee_raw) {
      const feeAccount = ledgerService.findAccountByTenantAndType(tenantId, 'network_fee_expense');
      if (feeAccount) {
        ledgerService.addEntry({
          ledgerAccountId: feeAccount.id,
          type: 'fee_expense',
          amountRaw: withdrawal.fee_raw,
          referenceType: 'customer_withdrawal',
          referenceId: withdrawalId,
        });
      }
    }

    webhooksService.queueEvent(
      'withdrawal.broadcast',
      { withdrawalId, txHash, tenantId, customerId: withdrawal.customer_id },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('Customer withdrawal broadcast', { withdrawalId, txHash, tenantId });
    return updated;
  },
};
