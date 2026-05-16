import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
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
  upsertByHash(chainId: string, txHash: string, data: Partial<Transaction>): Transaction {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM transactions WHERE chain_id = ? AND tx_hash = ?')
      .get(chainId, txHash) as Transaction | undefined;

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
        db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      return transactionsService.getById(existing.id);
    } else {
      const id = `tx_${crypto.randomBytes(8).toString('hex')}`;
      db.prepare(`
        INSERT INTO transactions (id, chain_id, tx_hash, raw_tx, psbt, status, block_height, block_hash,
          confirmations, fee_raw, fee_rate, wallet_id, broadcast_at, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, chainId, txHash,
        data.raw_tx ?? null, data.psbt ?? null,
        data.status ?? 'broadcasted',
        data.block_height ?? null, data.block_hash ?? null,
        data.confirmations ?? 0,
        data.fee_raw ?? null, data.fee_rate ?? null,
        data.wallet_id ?? null, data.broadcast_at ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now, now
      );
      return transactionsService.getById(id);
    }
  },

  getById(id: string): Transaction {
    const db = getDb();
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Transaction', id);
    return mapTx(row);
  },

  getByTxHash(chainId: string, txHash: string): Transaction | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM transactions WHERE chain_id = ? AND tx_hash = ?').get(chainId, txHash);
    return row ? mapTx(row) : null;
  },

  getPendingBroadcasted(chainId: string): Transaction[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM transactions WHERE chain_id = ? AND status IN ('broadcasted', 'seen_in_mempool')")
      .all(chainId);
    return rows.map(mapTx);
  },

  updateStatus(id: string, status: string, extra: Partial<Transaction> = {}): void {
    const db = getDb();
    const now = new Date().toISOString();
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.block_height !== undefined) { fields.push('block_height = ?'); params.push(extra.block_height); }
    if (extra.block_hash !== undefined) { fields.push('block_hash = ?'); params.push(extra.block_hash); }
    if (extra.confirmations !== undefined) { fields.push('confirmations = ?'); params.push(extra.confirmations); }

    params.push(id);
    db.prepare(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  },
};
