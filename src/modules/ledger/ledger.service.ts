import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { addSatoshi } from '../../shared/money/index';

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
  created_at: string;
  updated_at: string;
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
  created_at: string;
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
  };
}

function mapEntry(row: any): LedgerEntry {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const ledgerService = {
  createAccount(tenantId: string, input: {
    walletId?: string;
    customerId?: string;
    chainId: string;
    assetId: string;
    accountType?: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): LedgerAccount {
    const db = getDb();
    const id = `lacc_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO ledger_accounts (id, tenant_id, wallet_id, customer_id, chain_id, asset_id, account_type, name, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      now
    );

    return ledgerService.getAccountById(tenantId, id);
  },

  listAccounts(tenantId: string, filters: {
    walletId?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: LedgerAccount[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM ledger_accounts WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.walletId) { query += ' AND wallet_id = ?'; params.push(filters.walletId); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }

    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapAccount),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  // Tenant-scoped lookup for API handlers
  getAccountById(tenantId: string, id: string): LedgerAccount {
    const db = getDb();
    const row = db.prepare('SELECT * FROM ledger_accounts WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('LedgerAccount', id);
    return mapAccount(row);
  },

  // Internal lookup without tenant filter (used by workers and transfers)
  getAccountByIdInternal(id: string): LedgerAccount {
    const db = getDb();
    const row = db.prepare('SELECT * FROM ledger_accounts WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('LedgerAccount', id);
    return mapAccount(row);
  },

  getBalance(accountId: string): LedgerBalance {
    const db = getDb();
    // Get the latest entry to read running balance
    const latestEntry = db
      .prepare('SELECT * FROM ledger_entries WHERE ledger_account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(accountId) as LedgerEntry | undefined;

    if (!latestEntry) {
      return { pending: '0', settled: '0', total: '0' };
    }

    const pending = latestEntry.balance_pending_raw;
    const settled = latestEntry.balance_settled_raw;
    const total = addSatoshi(pending, settled);

    return { pending, settled, total };
  },

  listEntries(accountId: string, opts: {
    limit?: number;
    cursor?: string;
  } = {}): { data: LedgerEntry[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 20, 100);
    let query = 'SELECT * FROM ledger_entries WHERE ledger_account_id = ?';
    const params: unknown[] = [accountId];

    if (opts.cursor) {
      query += ' AND id < ?';
      params.push(opts.cursor);
    }
    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapEntry),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  /**
   * Create a ledger entry. Returns updated balance.
   */
  addEntry(input: {
    ledgerAccountId: string;
    type: string;
    amountRaw: string;    // positive = credit, negative = debit
    referenceType?: string;
    referenceId?: string;
    isPending?: boolean;  // true = affects pending balance, false = affects settled balance
    metadata?: Record<string, unknown>;
  }): { entry: LedgerEntry; balance: LedgerBalance } {
    const db = getDb();

    // Get current balance
    const currentBalance = ledgerService.getBalance(input.ledgerAccountId);
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
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO ledger_entries
        (id, ledger_account_id, type, amount_raw, reference_type, reference_id,
         balance_pending_raw, balance_settled_raw, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.ledgerAccountId,
      input.type,
      input.amountRaw,
      input.referenceType ?? null,
      input.referenceId ?? null,
      newPending.toString(),
      newSettled.toString(),
      input.metadata ? JSON.stringify(input.metadata) : null,
      now
    );

    const entry = ledgerService.listEntries(input.ledgerAccountId, { limit: 1 }).data[0];
    return {
      entry: entry!,
      balance: { pending: newPending.toString(), settled: newSettled.toString(), total: (newPending + newSettled).toString() },
    };
  },

  /**
   * Atomic transfer between two ledger accounts.
   */
  transfer(input: {
    fromLedgerAccountId: string;
    toLedgerAccountId: string;
    assetId: string;
    amountRaw: string;
    reference?: string;
  }): { debit: LedgerEntry; credit: LedgerEntry } {
    const db = getDb();

    // Validate both accounts exist and are for the same asset
    const fromAccount = ledgerService.getAccountByIdInternal(input.fromLedgerAccountId);
    const toAccount = ledgerService.getAccountByIdInternal(input.toLedgerAccountId);

    if (fromAccount.asset_id !== input.assetId || toAccount.asset_id !== input.assetId) {
      throw new Error('Asset mismatch in ledger transfer');
    }

    const transferId = `transfer_${crypto.randomBytes(8).toString('hex')}`;

    // Execute in a SQLite transaction for atomicity
    const doTransfer = db.transaction(() => {
      const debitResult = ledgerService.addEntry({
        ledgerAccountId: input.fromLedgerAccountId,
        type: 'transfer_out',
        amountRaw: (-BigInt(input.amountRaw)).toString(),
        referenceType: 'transfer',
        referenceId: transferId,
        metadata: input.reference ? { reference: input.reference } : undefined,
      });

      const creditResult = ledgerService.addEntry({
        ledgerAccountId: input.toLedgerAccountId,
        type: 'transfer_in',
        amountRaw: input.amountRaw,
        referenceType: 'transfer',
        referenceId: transferId,
        metadata: input.reference ? { reference: input.reference } : undefined,
      });

      return { debit: debitResult.entry, credit: creditResult.entry };
    });

    return doTransfer();
  },

  /**
   * Find ledger account for a wallet and asset.
   */
  findAccountByWalletAndAsset(walletId: string, assetId: string): LedgerAccount | null {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM ledger_accounts WHERE wallet_id = ? AND asset_id = ? LIMIT 1')
      .get(walletId, assetId);
    return row ? mapAccount(row) : null;
  },

  /**
   * Find ledger account for a customer and asset (account_type = customer_available).
   */
  findAccountByCustomerAndAsset(tenantId: string, customerId: string, assetId: string): LedgerAccount | null {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT * FROM ledger_accounts WHERE tenant_id = ? AND customer_id = ? AND asset_id = ? AND account_type = 'customer_available' LIMIT 1"
      )
      .get(tenantId, customerId, assetId);
    return row ? mapAccount(row) : null;
  },
};
