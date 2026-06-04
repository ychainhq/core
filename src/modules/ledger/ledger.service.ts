import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { addSatoshi } from '../../shared/money/index';
import { toUnixTs } from '../../shared/time/index';
import { ticklerService } from '../../shared/tickler/tickler.service';

// Monotonically increasing counter for ledger entry created_at (ms precision).
// Using a counter instead of Date.now() alone guarantees uniqueness even when
// two entries are created within the same millisecond (common in tests).
// Starts at Date.now() * 1000 (μs from epoch) so values sort correctly across
// process restarts as long as the system clock advances.
let _ledgerSeq = Date.now() * 1000;

export interface LedgerAccount {
  id: string;
  tenant_id: string | null;
  wallet_id: string | null;
  customer_id: string | null;
  chain_id: string;
  asset_id: string;
  account_type: string;
  name: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

export interface LedgerEntry {
  id: string;
  ledger_account_id: string;
  type: string;
  amount_raw: string;
  reference_type: string | null;
  reference_id: string | null;
  balance_pending_raw: string;
  balance_settled_raw: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export interface LedgerBalance {
  pending: string;
  settled: string;
  total: string;
}

function mapAccount(row: any): LedgerAccount {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

function mapEntry(row: any): LedgerEntry {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
  };
}

export const ledgerService = {
  async createAccount(tenantId: string, input: {
    walletId?: string;
    customerId?: string;
    chainId: string;
    assetId: string;
    accountType?: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<LedgerAccount> {
    const db = getDbClient();
    const id = `lacc_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO ledger_accounts (id, tenant_id, wallet_id, customer_id, chain_id, asset_id, account_type, name, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.walletId ?? null,
        input.customerId ?? null,
        input.chainId,
        input.assetId,
        input.accountType ?? 'customer_available',
        input.name,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      ]
    );

    return ledgerService.getAccountById(tenantId, id);
  },

  async listAccounts(tenantId: string, filters: {
    walletId?: string;
    customerId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ data: LedgerAccount[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM ledger_accounts WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.walletId) { query += ' AND wallet_id = ?'; params.push(filters.walletId); }
    if (filters.customerId) { query += ' AND customer_id = ?'; params.push(filters.customerId); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }

    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapAccount),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  // Tenant-scoped lookup for API handlers
  async getAccountById(tenantId: string, id: string): Promise<LedgerAccount> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM ledger_accounts WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('LedgerAccount', id);
    return mapAccount(row);
  },

  // Internal lookup without tenant filter (used by workers and transfers)
  async getAccountByIdInternal(id: string): Promise<LedgerAccount> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM ledger_accounts WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('LedgerAccount', id);
    return mapAccount(row);
  },

  async getBalance(accountId: string): Promise<LedgerBalance> {
    const db = getDbClient();
    const latestEntry = await db.get<LedgerEntry>(
      'SELECT * FROM ledger_entries WHERE ledger_account_id = ? ORDER BY created_at DESC LIMIT 1',
      [accountId]
    );

    if (!latestEntry) {
      return { pending: '0', settled: '0', total: '0' };
    }

    const pending = latestEntry.balance_pending_raw;
    const settled = latestEntry.balance_settled_raw;
    const total = addSatoshi(pending, settled);

    return { pending, settled, total };
  },

  async listEntries(accountId: string, opts: {
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ data: LedgerEntry[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(opts.limit ?? 20, 100);
    let query = 'SELECT * FROM ledger_entries WHERE ledger_account_id = ?';
    const params: unknown[] = [accountId];

    if (opts.cursor) {
      query += ' AND created_at < ?';
      params.push(Number(opts.cursor));
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapEntry),
      nextCursor: hasMore ? String((items[items.length - 1] as any).created_at) : null,
    };
  },

  /**
   * Create a ledger entry. Returns updated balance.
   */
  async addEntry(input: {
    ledgerAccountId: string;
    type: string;
    amountRaw: string;    // positive = credit, negative = debit
    referenceType?: string;
    referenceId?: string;
    isPending?: boolean;  // true = affects pending balance, false = affects settled balance
    metadata?: Record<string, unknown>;
  }): Promise<{ entry: LedgerEntry; balance: LedgerBalance }> {
    const db = getDbClient();

    // Get current balance
    const currentBalance = await ledgerService.getBalance(input.ledgerAccountId);
    const amount = BigInt(input.amountRaw);

    let newPending = BigInt(currentBalance.pending);
    let newSettled = BigInt(currentBalance.settled);

    if (input.isPending !== false && (
      input.type === 'deposit_pending' ||
      input.type === 'transfer_in' ||
      input.type === 'transfer_out' ||
      input.type === 'withdrawal'
    )) {
      newPending += amount;
    } else {
      newSettled += amount;
      // When settling a pending deposit, reduce pending
      if (input.type === 'deposit_settled') {
        // Remove from pending, add to settled
        newPending -= BigInt(input.amountRaw);
        newSettled = BigInt(currentBalance.settled) + amount;
      }
    }

    const id = `lent_${crypto.randomBytes(8).toString('hex')}`;
    // Monotonic ms counter — ORDER BY created_at DESC is stable even for same-millisecond entries.
    const now = ++_ledgerSeq;

    await db.run(
      `INSERT INTO ledger_entries
        (id, ledger_account_id, type, amount_raw, reference_type, reference_id,
         balance_pending_raw, balance_settled_raw, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ledgerAccountId,
        input.type,
        input.amountRaw,
        input.referenceType ?? null,
        input.referenceId ?? null,
        newPending.toString(),
        newSettled.toString(),
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      ]
    );

    const entry = mapEntry(await db.get('SELECT * FROM ledger_entries WHERE id = ?', [id]));
    const account = await db.get<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM ledger_accounts WHERE id = ?',
      [input.ledgerAccountId]
    );
    ticklerService.record({
      tenantId: account?.tenant_id ?? null,
      category: 'ledger',
      subcategory: 'entry.posted',
      entityId: id,
      field1: input.ledgerAccountId,
      field2: input.type,
      field3: input.amountRaw,
      field4: input.referenceType ?? null,
      field5: input.referenceId ?? null,
    });
    return {
      entry: entry!,
      balance: { pending: newPending.toString(), settled: newSettled.toString(), total: (newPending + newSettled).toString() },
    };
  },

  /**
   * Atomic transfer between two ledger accounts.
   */
  async transfer(input: {
    fromLedgerAccountId: string;
    toLedgerAccountId: string;
    assetId: string;
    amountRaw: string;
    reference?: string;
    isPending?: boolean;
  }): Promise<{ debit: LedgerEntry; credit: LedgerEntry }> {
    const db = getDbClient();

    // Validate both accounts exist and are for the same asset
    const fromAccount = await ledgerService.getAccountByIdInternal(input.fromLedgerAccountId);
    const toAccount = await ledgerService.getAccountByIdInternal(input.toLedgerAccountId);

    if (fromAccount.asset_id !== input.assetId || toAccount.asset_id !== input.assetId) {
      throw new Error('Asset mismatch in ledger transfer');
    }

    const transferId = `transfer_${crypto.randomBytes(8).toString('hex')}`;

    // Execute in a transaction for atomicity
    return await db.transaction(async (tx) => {
      const debitResult = await ledgerService.addEntry({
        ledgerAccountId: input.fromLedgerAccountId,
        type: 'transfer_out',
        amountRaw: (-BigInt(input.amountRaw)).toString(),
        referenceType: 'transfer',
        referenceId: transferId,
        isPending: input.isPending,
        metadata: input.reference ? { reference: input.reference } : undefined,
      });

      const creditResult = await ledgerService.addEntry({
        ledgerAccountId: input.toLedgerAccountId,
        type: 'transfer_in',
        amountRaw: input.amountRaw,
        referenceType: 'transfer',
        referenceId: transferId,
        isPending: input.isPending,
        metadata: input.reference ? { reference: input.reference } : undefined,
      });

      return { debit: debitResult.entry, credit: creditResult.entry };
    });
  },

  /**
   * Find ledger account for a wallet and asset.
   */
  async findAccountByWalletAndAsset(walletId: string, assetId: string): Promise<LedgerAccount | null> {
    const db = getDbClient();
    const row = await db.get(
      'SELECT * FROM ledger_accounts WHERE wallet_id = ? AND asset_id = ? LIMIT 1',
      [walletId, assetId]
    );
    return row ? mapAccount(row) : null;
  },

  /**
   * Find ledger account for a customer and asset (account_type = customer_available).
   */
  async findAccountByCustomerAndAsset(tenantId: string, customerId: string, assetId: string): Promise<LedgerAccount | null> {
    const db = getDbClient();
    const row = await db.get(
      "SELECT * FROM ledger_accounts WHERE tenant_id = ? AND customer_id = ? AND asset_id = ? AND account_type = 'customer_available' LIMIT 1",
      [tenantId, customerId, assetId]
    );
    return row ? mapAccount(row) : null;
  },

  /**
   * Find a tenant-level ledger account by account_type (e.g. sweep_in_transit, tenant_hot_control).
   */
  async findAccountByTenantAndType(tenantId: string, accountType: string, chainId = 'bitcoin'): Promise<LedgerAccount | null> {
    const db = getDbClient();
    const row = await db.get(
      'SELECT * FROM ledger_accounts WHERE tenant_id = ? AND account_type = ? AND chain_id = ? LIMIT 1',
      [tenantId, accountType, chainId]
    );
    return row ? mapAccount(row) : null;
  },

  // Idempotent: creates a deposit ledger entry only if one with the same
  // (ledgerAccountId, entryType, depositId) does not already exist.
  // Called by ChainEventProcessorWorker for both deposit_pending and deposit_settled.
  async ensureDepositEntry(input: {
    ledgerAccountId: string;
    depositId: string;
    entryType: 'deposit_pending' | 'deposit_settled';
    amountRaw: string;
    isPending: boolean;
  }): Promise<void> {
    const db = getDbClient();
    const exists = await db.get(
      `SELECT id FROM ledger_entries WHERE ledger_account_id = ? AND type = ?
       AND reference_type = 'deposit' AND reference_id = ? LIMIT 1`,
      [input.ledgerAccountId, input.entryType, input.depositId]
    );
    if (exists) return;
    try {
      await ledgerService.addEntry({
        ledgerAccountId: input.ledgerAccountId,
        type: input.entryType,
        amountRaw: input.amountRaw,
        referenceType: 'deposit',
        referenceId: input.depositId,
        isPending: input.isPending,
      });
    } catch (err) {
      // Log but do not propagate — deposit processing must not fail due to a ledger write error.
      const { logger } = await import('../../shared/logging/index');
      logger.warn('ensureDepositEntry failed', { depositId: input.depositId, entryType: input.entryType, error: String(err) });
    }
  },
};
