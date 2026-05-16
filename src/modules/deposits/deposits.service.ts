import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';

export interface Deposit {
  id: string;
  tenant_id: string | null;
  customer_id: string | null;
  chain_id: string;
  asset_id: string;
  wallet_id: string | null;
  address: string;
  amount_raw: string;
  amount_display: string;
  tx_hash: string;
  vout: number | null;
  block_height: number | null;
  block_hash: string | null;
  confirmations: number;
  status: string;
  payment_request_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapDeposit(row: any): Deposit {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const depositsService = {
  upsert(input: {
    tenantId?: string;
    customerId?: string;
    chainId: string;
    assetId: string;
    walletId?: string;
    address: string;
    amountRaw: string;
    amountDisplay: string;
    txHash: string;
    vout?: number;
    blockHeight?: number;
    blockHash?: string;
    confirmations: number;
    status: string;
    paymentRequestId?: string;
    metadata?: Record<string, unknown>;
  }): Deposit {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT * FROM deposits WHERE chain_id = ? AND tx_hash = ? AND vout IS ?')
      .get(input.chainId, input.txHash, input.vout ?? null) as Deposit | undefined;

    if (existing) {
      db.prepare(`
        UPDATE deposits SET
          confirmations = ?, status = ?, block_height = ?, block_hash = ?,
          amount_raw = ?, amount_display = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.confirmations,
        input.status,
        input.blockHeight ?? null,
        input.blockHash ?? null,
        input.amountRaw,
        input.amountDisplay,
        now,
        existing.id
      );
      return depositsService.getByIdInternal(existing.id);
    }

    const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO deposits
        (id, tenant_id, customer_id, chain_id, asset_id, wallet_id, address, amount_raw, amount_display,
         tx_hash, vout, block_height, block_hash, confirmations, status,
         payment_request_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.tenantId ?? null,
      input.customerId ?? null,
      input.chainId,
      input.assetId,
      input.walletId ?? null,
      input.address,
      input.amountRaw,
      input.amountDisplay,
      input.txHash,
      input.vout ?? null,
      input.blockHeight ?? null,
      input.blockHash ?? null,
      input.confirmations,
      input.status,
      input.paymentRequestId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return depositsService.getByIdInternal(id);
  },

  // Tenant-scoped lookup for API handlers
  getById(tenantId: string, id: string): Deposit {
    const db = getDb();
    const row = db.prepare('SELECT * FROM deposits WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Deposit', id);
    return mapDeposit(row);
  },

  // Internal lookup without tenant filter (used by workers and upsert)
  getByIdInternal(id: string): Deposit {
    const db = getDb();
    const row = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Deposit', id);
    return mapDeposit(row);
  },

  list(tenantId: string, filters: {
    walletId?: string;
    chain?: string;
    status?: string;
    address?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: Deposit[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM deposits WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.walletId) { query += ' AND wallet_id = ?'; params.push(filters.walletId); }
    if (filters.chain) { query += ' AND chain_id = ?'; params.push(filters.chain); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.address) { query += ' AND address = ?'; params.push(filters.address); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapDeposit),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  // Used by workers — no tenant filter
  getExistingByAddress(chainId: string, address: string): Deposit[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM deposits WHERE chain_id = ? AND address = ?')
      .all(chainId, address);
    return rows.map(mapDeposit);
  },

  // Used by workers — no tenant filter
  updatePaymentRequestId(depositId: string, paymentRequestId: string): void {
    const db = getDb();
    db.prepare('UPDATE deposits SET payment_request_id = ?, updated_at = ? WHERE id = ?').run(
      paymentRequestId,
      new Date().toISOString(),
      depositId
    );
  },
};
