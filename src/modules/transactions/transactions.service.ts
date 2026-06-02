import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';

export interface Transaction {
  id: string;
  tenant_id: string | null;
  chain_id: string;
  tx_hash: string | null;
  raw_tx: string | null;
  psbt: string | null;
  status: string;
  block_height: number | null;
  block_hash: string | null;
  confirmations: number;
  fee_raw: string | null;
  fee_rate: string | null;
  wallet_id: string | null;
  broadcast_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapTx(row: any): Transaction {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const transactionsService = {
  async upsertByHash(chainId: string, txHash: string, data: Partial<Transaction>): Promise<Transaction> {
    const db = getDbClient();
    const existing = await db.get<Transaction>(
      'SELECT * FROM transactions WHERE chain_id = ? AND tx_hash = ?',
      [chainId, txHash]
    );

    const now = new Date().toISOString();

    if (existing) {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (data.status !== undefined) { updates.push('status = ?'); params.push(data.status); }
      if (data.block_height !== undefined) { updates.push('block_height = ?'); params.push(data.block_height); }
      if (data.block_hash !== undefined) { updates.push('block_hash = ?'); params.push(data.block_hash); }
      if (data.confirmations !== undefined) { updates.push('confirmations = ?'); params.push(data.confirmations); }
      if (data.broadcast_at !== undefined) { updates.push('broadcast_at = ?'); params.push(data.broadcast_at); }

      updates.push('updated_at = ?');
      params.push(now);
      params.push(existing.id);

      if (updates.length > 1) {
        await db.run(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      return transactionsService.getById(existing.id);
    } else {
      const id = `tx_${crypto.randomBytes(8).toString('hex')}`;
      await db.run(`
        INSERT INTO transactions (id, chain_id, tx_hash, raw_tx, psbt, status, block_height, block_hash,
          confirmations, fee_raw, fee_rate, wallet_id, broadcast_at, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id, chainId, txHash,
        data.raw_tx ?? null, data.psbt ?? null,
        data.status ?? 'broadcasted',
        data.block_height ?? null, data.block_hash ?? null,
        data.confirmations ?? 0,
        data.fee_raw ?? null, data.fee_rate ?? null,
        data.wallet_id ?? null, data.broadcast_at ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now, now,
      ]);
      return transactionsService.getById(id);
    }
  },

  async getById(id: string): Promise<Transaction> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Transaction', id);
    return mapTx(row);
  },

  async getByTxHash(chainId: string, txHash: string): Promise<Transaction | null> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM transactions WHERE chain_id = ? AND tx_hash = ?', [chainId, txHash]);
    return row ? mapTx(row) : null;
  },

  async getPendingBroadcasted(chainId: string): Promise<Transaction[]> {
    const db = getDbClient();
    const rows = await db.all(
      "SELECT * FROM transactions WHERE chain_id = ? AND status IN ('broadcasted', 'seen_in_mempool')",
      [chainId]
    );
    return rows.map(mapTx);
  },

  async updateStatus(id: string, status: string, extra: Partial<Transaction> = {}): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.block_height !== undefined) { fields.push('block_height = ?'); params.push(extra.block_height); }
    if (extra.block_hash !== undefined) { fields.push('block_hash = ?'); params.push(extra.block_hash); }
    if (extra.confirmations !== undefined) { fields.push('confirmations = ?'); params.push(extra.confirmations); }

    params.push(id);
    await db.run(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`, params);
  },
};
