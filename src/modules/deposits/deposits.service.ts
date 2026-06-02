import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { toUnixTs } from '../../shared/time/index';

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
  created_at: number;
  updated_at: number;
}

function mapDeposit(row: any): Deposit {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export const depositsService = {
  async upsert(input: {
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
  }): Promise<Deposit> {
    const db = getDbClient();
    const now = new Date().toISOString();

    const existing = await db.get<Deposit>(
      'SELECT * FROM deposits WHERE chain_id = ? AND tx_hash = ? AND vout IS ?',
      [input.chainId, input.txHash, input.vout ?? null]
    );

    if (existing) {
      await db.run(`
        UPDATE deposits SET
          confirmations = ?, status = ?, block_height = ?, block_hash = ?,
          amount_raw = ?, amount_display = ?,
          customer_id = COALESCE(customer_id, ?),
          updated_at = ?
        WHERE id = ?
      `, [
        input.confirmations,
        input.status,
        input.blockHeight ?? null,
        input.blockHash ?? null,
        input.amountRaw,
        input.amountDisplay,
        input.customerId ?? null,
        now,
        existing.id
      ]);
      return await depositsService.getByIdInternal(existing.id);
    }

    const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
    await db.run(`
      INSERT INTO deposits
        (id, tenant_id, customer_id, chain_id, asset_id, wallet_id, address, amount_raw, amount_display,
         tx_hash, vout, block_height, block_hash, confirmations, status,
         payment_request_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);

    return await depositsService.getByIdInternal(id);
  },

  // Tenant-scoped lookup for API handlers
  async getById(tenantId: string, id: string): Promise<Deposit> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM deposits WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Deposit', id);
    return mapDeposit(row);
  },

  // Internal lookup without tenant filter (used by workers and upsert)
  async getByIdInternal(id: string): Promise<Deposit> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM deposits WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Deposit', id);
    return mapDeposit(row);
  },

  async list(tenantId: string, filters: {
    walletId?: string;
    chain?: string;
    status?: string;
    address?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ data: Deposit[]; nextCursor: string | null }> {
    const db = getDbClient();
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

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapDeposit),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  // Used by workers — no tenant filter
  async getExistingByAddress(chainId: string, address: string): Promise<Deposit[]> {
    const db = getDbClient();
    const rows = await db.all(
      'SELECT * FROM deposits WHERE chain_id = ? AND address = ?',
      [chainId, address]
    );
    return rows.map(mapDeposit);
  },

  // Used by workers — no tenant filter
  async updatePaymentRequestId(depositId: string, paymentRequestId: string): Promise<void> {
    const db = getDbClient();
    await db.run('UPDATE deposits SET payment_request_id = ?, updated_at = ? WHERE id = ?', [
      paymentRequestId,
      new Date().toISOString(),
      depositId
    ]);
  },
};
