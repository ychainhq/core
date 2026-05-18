import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, UnprocessableEntityError, ValidationError } from '../../shared/errors/index';
import { ledgerService } from '../ledger/ledger.service';
import { webhooksService } from '../webhooks/webhooks.service';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { logger } from '../../shared/logging/index';
import { toUnixTs } from '../../shared/time/index';

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
  created_at: number;
  updated_at: number;
}

function mapWithdrawal(row: any): CustomerWithdrawal {
  return {
    ...row,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export const withdrawalsService = {
  /**
   * Initiate a customer withdrawal. Builds a PSBT from the tenant hot wallet UTXOs,
   * creates a withdrawal record, and fires the withdrawal.ready_for_signing webhook.
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

    // Check customer_available balance
    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, assetId);
    if (!account) {
      throw new UnprocessableEntityError('No BTC ledger account found for this customer');
    }
    const balance = ledgerService.getBalance(account.id);
    if (BigInt(balance.settled) < amountBigInt) {
      throw new UnprocessableEntityError(
        `Insufficient balance: available ${balance.settled} sats, requested ${input.amountSats} sats`
      );
    }

    // Find tenant hot wallet address
    const hotAddr = db
      .prepare(`
        SELECT a.address
        FROM addresses a
        JOIN wallets w ON w.id = a.wallet_id
        WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
          AND a.chain_id = 'bitcoin' AND a.status = 'active'
        LIMIT 1
      `)
      .get(tenantId) as { address: string } | undefined;

    if (!hotAddr) {
      throw new UnprocessableEntityError(
        'No tenant hot wallet address configured — cannot process withdrawal'
      );
    }

    // Get UTXOs from tenant hot wallet
    const adapter = new BitcoinAdapter();
    let utxos: any[];
    try {
      utxos = await adapter.getUtxosForAddress(hotAddr.address, 1, tenantId);
    } catch (err) {
      throw new UnprocessableEntityError(
        `Unable to fetch hot wallet UTXOs: ${String(err)}`
      );
    }

    const totalUtxoSats = utxos.reduce((sum, u) => sum + BigInt(u.amount), BigInt(0));
    if (totalUtxoSats < amountBigInt) {
      throw new UnprocessableEntityError(
        `Hot wallet balance insufficient: ${totalUtxoSats} sats available, ${input.amountSats} sats requested`
      );
    }

    // Estimate fee
    let feeRateSatPerVbyte = 5;
    try {
      const feeEst = await adapter.estimateSmartFee(6);
      if (feeEst.feeRate) feeRateSatPerVbyte = Math.ceil(feeEst.feeRate * 100000);
    } catch {
      logger.warn('withdrawalsService: fee estimation failed, using fallback', { tenantId });
    }

    // Build PSBT — use explicit inputs from hot wallet, customer toAddress as output
    const btcAmount = Number(amountBigInt) / 1e8;
    const inputs = utxos.map((u: any) => ({ txid: u.txHash, vout: u.vout }));
    const outputs = [{ [input.toAddress]: btcAmount }];

    let psbtBase64: string;
    let feeRaw: string;
    try {
      const result = await adapter.walletCreateFundedPsbt(inputs, outputs, {
        feeRate: feeRateSatPerVbyte / 1e5,
        subtractFeeFromOutputs: [0],
      });
      psbtBase64 = result.psbt;
      feeRaw = result.fee ? String(Math.round(result.fee * 1e8)) : String(feeRateSatPerVbyte * 148);
    } catch (err: any) {
      throw new UnprocessableEntityError(`Failed to build PSBT: ${err?.message ?? String(err)}`);
    }

    // Persist withdrawal record
    const id = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, fee_raw, psbt,
         status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, ?, ?, ?, 'pending_signature', ?, ?, ?)
    `).run(
      id, tenantId, customerId,
      input.toAddress, input.amountSats, feeRaw, psbtBase64,
      input.idempotencyKey ?? null,
      now, now
    );

    // Reserve customer balance immediately — prevents double-spend while PSBT awaits signing
    ledgerService.addEntry({
      ledgerAccountId: account.id,
      type: 'withdrawal_reserve',
      amountRaw: (-amountBigInt).toString(),
      referenceType: 'customer_withdrawal',
      referenceId: id,
    });

    const withdrawal = withdrawalsService.getByIdInternal(id);

    // Fire webhook
    webhooksService.queueEvent(
      'withdrawal.ready_for_signing',
      {
        withdrawalId: id,
        tenantId,
        customerId,
        toAddress: input.toAddress,
        amountSats: input.amountSats,
        feeRaw,
        psbt: psbtBase64,
        submitUrl: `/v1/withdrawals/${id}/submit-signed`,
      },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('Customer withdrawal created', { id, tenantId, customerId, amountSats: input.amountSats });
    return withdrawal;
  },

  list(
    tenantId: string,
    customerId: string,
    filters: { status?: string; limit?: number; cursor?: string } = {}
  ): { data: CustomerWithdrawal[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customer_withdrawals WHERE tenant_id = ? AND customer_id = ?';
    const params: unknown[] = [tenantId, customerId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
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
