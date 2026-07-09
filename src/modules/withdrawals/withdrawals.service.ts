import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, UnprocessableEntityError, ValidationError } from '../../shared/errors/index';
import { ledgerService } from '../ledger/ledger.service';
import { depositsService } from '../deposits/deposits.service';
import { webhooksService } from '../webhooks/webhooks.service';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { adapterRegistry, btcNodeSelector } from '../../chain-adapters/registry';
import { logger } from '../../shared/logging/index';
import { toUnixTs } from '../../shared/time/index';
import { satoshiToBtc } from '../../shared/money/index';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { withdrawalBatcherService } from '../withdrawal-batches/withdrawal-batcher.service';

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
      forceExternal?: boolean;
      chainId?: string;
      assetId?: string;
    }
  ): Promise<CustomerWithdrawal> {
    const db = getDbClient();
    const chainId = input.chainId ?? 'bitcoin';
    const assetId = input.assetId ?? 'bitcoin:BTC';

    // Idempotency check
    if (input.idempotencyKey) {
      const existing = await db.get(
        'SELECT * FROM customer_withdrawals WHERE tenant_id = ? AND idempotency_key = ?',
        [tenantId, input.idempotencyKey]
      ) as any | undefined;
      if (existing) return mapWithdrawal(existing);
    }

    const amountBigInt = BigInt(input.amountSats);
    if (amountBigInt <= 0n) {
      throw new ValidationError('amountSats must be greater than zero');
    }

    // For USDT sender_pays: resolve the fixed withdrawal fee from batch config
    // and include it in the balance check and ledger reserve.
    // For all other modes (tenant_pays, recipient_pays) and non-USDT assets: fee = 0.
    let usdtWithdrawalFeeMicroUnits = 0n;
    if (assetId === 'tron:USDT') {
      const batchConfig = await withdrawalBatcherService.getBatchConfig(tenantId);
      if (batchConfig.withdrawal_fee_coverage === 'sender_pays') {
        usdtWithdrawalFeeMicroUnits = BigInt(batchConfig.tron_usdt_withdrawal_fee ?? '0');
      }
    }

    // Check sender balance
    const senderAccount = await ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, assetId);
    if (!senderAccount) {
      throw new UnprocessableEntityError(`No ${assetId} ledger account found for this customer`);
    }
    const balance = await ledgerService.getBalance(senderAccount.id);
    const totalRequired = amountBigInt + usdtWithdrawalFeeMicroUnits;
    if (BigInt(balance.settled) < totalRequired) {
      throw new UnprocessableEntityError(
        `Insufficient balance: available ${balance.settled}, required ${totalRequired.toString()} (amount ${input.amountSats}${usdtWithdrawalFeeMicroUnits > 0n ? ` + fee ${usdtWithdrawalFeeMicroUnits}` : ''})`
      );
    }

    // On-platform detection: is toAddress a registered customer deposit address for this tenant?
    const platformAddr = input.forceExternal ? undefined : await db.get<{ customer_id: string }>(
      "SELECT customer_id FROM addresses WHERE address = ? AND tenant_id = ? AND chain_id = ? AND address_role = 'customer_deposit' LIMIT 1",
      [input.toAddress, tenantId, chainId]
    );

    if (platformAddr) {
      const result = withdrawalsService._executeInternalTransfer({
        tenantId,
        senderCustomerId: customerId,
        recipientCustomerId: platformAddr.customer_id,
        senderAccount,
        amountBigInt,
        toAddress: input.toAddress,
        idempotencyKey: input.idempotencyKey,
        chainId,
        assetId,
      });
      logger.info('Customer withdrawal executed for internal transfer', { tenantId, customerId, recipientCustomerId: platformAddr.customer_id, toAddress: input.toAddress, amountSats: amountBigInt.toString() });
      return result;
    }

    // External path — validate address for the given chain
    const adapter = chainId === 'bitcoin'
      ? new BitcoinAdapter(btcNodeSelector)
      : adapterRegistry.get(chainId);
    if (!adapter.isValidAddress(input.toAddress)) {
      throw new ValidationError(`Invalid ${chainId} address: ${input.toAddress}`);
    }

    // Persist withdrawal record
    const id = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    // fee_raw at creation time = fixed USDT fee for sender_pays (micro-USDT).
    // For all other modes it's null — batcher fills it in when building the batch.
    const feeRawAtCreation = usdtWithdrawalFeeMicroUnits > 0n
      ? usdtWithdrawalFeeMicroUnits.toString()
      : null;

    await db.run(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, fee_raw, psbt,
         status, idempotency_key, withdrawal_type, recipient_customer_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', ?, 'external', NULL, ?, ?)
    `, [
      id, tenantId, customerId,
      chainId, assetId,
      input.toAddress, input.amountSats, feeRawAtCreation,
      input.idempotencyKey ?? null,
      now, now,
    ]);

    // Reserve customer balance immediately — prevents double-spend while batch awaits signing.
    // For sender_pays USDT: reserve includes the fixed withdrawal fee.
    const reserveAmount = amountBigInt + usdtWithdrawalFeeMicroUnits;
    await ledgerService.addEntry({
      ledgerAccountId: senderAccount.id,
      type: 'withdrawal_reserve',
      amountRaw: (-reserveAmount).toString(),
      referenceType: 'customer_withdrawal',
      referenceId: id,
    });

    const withdrawal = await withdrawalsService.getByIdInternal(id);

    // Fire lightweight lifecycle webhook
    webhooksService.queueEvent(
      'withdrawal.queued',
      {
        withdrawalId: id,
        tenantId,
        customerId,
        toAddress: input.toAddress,
        amountSats: input.amountSats,
        chainId,
        assetId,
      },
      chainId,
      undefined,
      tenantId
    );

    logger.info('Customer withdrawal queued', { id, tenantId, customerId, chainId, assetId, amountSats: input.amountSats });
    return withdrawal;
  },

  async _executeInternalTransfer(
    opts: {
      tenantId: string;
      senderCustomerId: string;
      recipientCustomerId: string;
      senderAccount: { id: string };
      amountBigInt: bigint;
      toAddress: string;
      idempotencyKey?: string;
      chainId?: string;
      assetId?: string;
    }
  ): Promise<CustomerWithdrawal> {
    const {
      tenantId, senderCustomerId, recipientCustomerId, senderAccount,
      amountBigInt, toAddress, idempotencyKey,
    } = opts;
    const chainId = opts.chainId ?? 'bitcoin';
    const assetId = opts.assetId ?? 'bitcoin:BTC';

    if (senderCustomerId === recipientCustomerId) {
      throw new ValidationError('Cannot transfer to your own deposit address');
    }

    const db = getDbClient();

    // Verify recipient is active
    const recipient = await db.get<{ id: string; status: string }>(
      "SELECT id, status FROM customers WHERE id = ? AND tenant_id = ?",
      [recipientCustomerId, tenantId]
    );
    if (!recipient || recipient.status !== 'active') {
      throw new UnprocessableEntityError('Recipient customer is not active');
    }

    // Verify recipient has a matching ledger account
    const recipientAccount = await ledgerService.findAccountByCustomerAndAsset(tenantId, recipientCustomerId, assetId);
    if (!recipientAccount) {
      throw new UnprocessableEntityError(`Recipient has no ${assetId} ledger account`);
    }

    const id = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    // amountDisplay: BTC uses 8 decimals, TRON assets use 6
    const TRON_DECIMALS = 6n;
    const amountDisplay = chainId === 'bitcoin'
      ? satoshiToBtc(amountBigInt)
      : `${amountBigInt / (10n ** TRON_DECIMALS)}.${String(amountBigInt % (10n ** TRON_DECIMALS)).padStart(6, '0')}`;

    const deposit = await db.transaction(async (tx) => {
      await tx.run(`
        INSERT INTO customer_withdrawals
          (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, fee_raw, psbt,
           status, idempotency_key, withdrawal_type, recipient_customer_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '0', NULL, 'confirmed', ?, 'internal', ?, ?, ?)
      `, [
        id, tenantId, senderCustomerId,
        chainId, assetId,
        toAddress, amountBigInt.toString(),
        idempotencyKey ?? null,
        recipientCustomerId,
        now, now,
      ]);

      await ledgerService.transfer({
        fromLedgerAccountId: senderAccount.id,
        toLedgerAccountId: recipientAccount.id,
        assetId,
        amountRaw: amountBigInt.toString(),
        reference: id,
        isPending: false,
      });

      const { deposit: internalDeposit } = await depositsService.upsert({
        tenantId,
        customerId: recipientCustomerId,
        chainId,
        assetId,
        address: toAddress,
        amountRaw: amountBigInt.toString(),
        amountDisplay,
        txHash: `internal:${id}`,
        confirmations: 1,
        status: 'confirmed',
        metadata: { internal_transfer: true, sender_customer_id: senderCustomerId },
      });
      return internalDeposit;
    });

    const withdrawal = await withdrawalsService.getByIdInternal(id);

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

    ticklerService.record({
      tenantId,
      category: 'deposit',
      subcategory: 'internal_transfer',
      entityId: deposit.id,
      actorLogin: `customer:${senderCustomerId}`,
      field1: toAddress,
      field2: amountBigInt.toString(),
      field3: recipientCustomerId,
      field4: id,
      newValue: deposit,
    });

    webhooksService.queueEvent(
      'withdrawal.internal_transfer',
      {
        withdrawalId: id,
        tenantId,
        senderCustomerId,
        recipientCustomerId,
        toAddress,
        amountRaw: amountBigInt.toString(),
        chainId,
        assetId,
      },
      chainId,
      undefined,
      tenantId
    );

    logger.info('Internal transfer completed', { id, tenantId, senderCustomerId, recipientCustomerId, chainId, assetId, amountRaw: amountBigInt.toString() });
    return withdrawal;
  },

  async list(
    tenantId: string,
    customerId: string,
    filters: { status?: string; toAddress?: string; limit?: number; cursor?: string } = {}
  ): Promise<{ data: CustomerWithdrawal[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customer_withdrawals WHERE tenant_id = ? AND customer_id = ?';
    const params: unknown[] = [tenantId, customerId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.toAddress) { query += ' AND to_address LIKE ?'; params.push(filters.toAddress); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items.map(mapWithdrawal), nextCursor: hasMore ? items[items.length - 1].id : null };
  },

  async listForTenant(
    tenantId: string,
    filters: { status?: string; limit?: number; cursor?: string } = {}
  ): Promise<{ data: CustomerWithdrawal[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customer_withdrawals WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items.map(mapWithdrawal), nextCursor: hasMore ? items[items.length - 1].id : null };
  },

  async getById(tenantId: string, id: string): Promise<CustomerWithdrawal> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM customer_withdrawals WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Withdrawal', id);
    return mapWithdrawal(row);
  },

  async getByIdInternal(id: string): Promise<CustomerWithdrawal> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM customer_withdrawals WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Withdrawal', id);
    return mapWithdrawal(row);
  },

  async updateStatus(
    id: string,
    status: string,
    extra: { signedPsbt?: string; txHash?: string; error?: string } = {}
  ): Promise<CustomerWithdrawal> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const sets = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.signedPsbt !== undefined) { sets.push('signed_psbt = ?'); params.push(extra.signedPsbt); }
    if (extra.txHash !== undefined) { sets.push('tx_hash = ?'); params.push(extra.txHash); }
    if (extra.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }

    params.push(id);
    await db.run(`UPDATE customer_withdrawals SET ${sets.join(', ')} WHERE id = ?`, params);
    return withdrawalsService.getByIdInternal(id);
  },

  async markBatched(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = getDbClient();
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(
      `UPDATE customer_withdrawals SET status = 'batched', updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids]
    );
  },

  async requeue(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = getDbClient();
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(
      `UPDATE customer_withdrawals SET status = 'queued', updated_at = ? WHERE id IN (${placeholders}) AND status = 'batched'`,
      [now, ...ids]
    );
  },

  async markBroadcast(ids: string[], txHash: string): Promise<void> {
    if (ids.length === 0) return;
    const db = getDbClient();
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(
      `UPDATE customer_withdrawals SET status = 'broadcast', tx_hash = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [txHash, now, ...ids]
    );
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
    const withdrawal = await withdrawalsService.getById(tenantId, withdrawalId);

    if (withdrawal.status !== 'pending_signature') {
      throw new ValidationError(
        `Withdrawal is in status '${withdrawal.status}', expected 'pending_signature'`
      );
    }

    const adapter = new BitcoinAdapter(btcNodeSelector);
    let txHash: string;
    try {
      const finalizedResult = await adapter.finalizePsbt(signedPsbt);
      if (!finalizedResult.complete) {
        throw new Error('PSBT is not fully signed — missing signatures');
      }
      txHash = await (adapter as any).sendRawTransaction(finalizedResult.hex);
    } catch (err: any) {
      await withdrawalsService.updateStatus(withdrawalId, 'failed', { error: String(err) });
      // Refund the reservation made at create() — broadcast failed, balance is restored
      const custAccount = await ledgerService.findAccountByCustomerAndAsset(
        tenantId, withdrawal.customer_id, withdrawal.asset_id
      );
      if (custAccount) {
        await ledgerService.addEntry({
          ledgerAccountId: custAccount.id,
          type: 'withdrawal_refund',
          amountRaw: withdrawal.amount_raw,
          referenceType: 'customer_withdrawal',
          referenceId: withdrawalId,
        });
      }
      throw new ValidationError(`Failed to broadcast withdrawal: ${err?.message ?? err}`);
    }

    const updated = await withdrawalsService.updateStatus(withdrawalId, 'broadcast', { signedPsbt, txHash });

    // Debit tenant hot wallet control — funds have left the hot wallet
    const hotAccount = await ledgerService.findAccountByTenantAndType(tenantId, 'tenant_hot_control');
    if (hotAccount) {
      const totalOut = BigInt(withdrawal.amount_raw) + BigInt(withdrawal.fee_raw ?? '0');
      await ledgerService.addEntry({
        ledgerAccountId: hotAccount.id,
        type: 'hot_debit',
        amountRaw: (-totalOut).toString(),
        referenceType: 'customer_withdrawal',
        referenceId: withdrawalId,
      });
    }

    // Record network fee expense
    if (withdrawal.fee_raw) {
      const feeAccount = await ledgerService.findAccountByTenantAndType(tenantId, 'network_fee_expense');
      if (feeAccount) {
        await ledgerService.addEntry({
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
