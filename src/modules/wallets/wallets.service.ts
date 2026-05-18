import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { toUnixTs } from '../../shared/time/index';

export interface Wallet {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  wallet_role: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

function mapWallet(row: any): Wallet {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

function generateWalletId(): string {
  return `wallet_${crypto.randomBytes(6).toString('hex')}`;
}

export interface CreateWalletInput {
  name: string;
  type: 'watch_only' | 'external_signer';
  walletRole?: 'watch_only' | 'tenant_hot' | 'tenant_cold' | 'customer_deposits' | 'external_signer';
  metadata?: Record<string, unknown>;
}

export interface ListWalletsInput {
  limit?: number;
  cursor?: string;
  type?: string;
}

export const walletsService = {
  create(tenantId: string, input: CreateWalletInput): Wallet {
    const db = getDb();
    const id = generateWalletId();
    const now = new Date().toISOString();
    const walletRole = input.walletRole ?? 'watch_only';

    db.prepare(`
      INSERT INTO wallets (id, tenant_id, name, type, wallet_role, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id,
      tenantId,
      input.name,
      input.type,
      walletRole,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return walletsService.getById(tenantId, id);
  },

  list(tenantId: string, input: ListWalletsInput = {}): { data: Wallet[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(input.limit ?? 20, 100);
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (input.type) {
      conditions.push('type = ?');
      params.push(input.type);
    }
    if (input.cursor) {
      conditions.push('id > ?');
      params.push(input.cursor);
    }

    let query = 'SELECT * FROM wallets WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapWallet),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getById(tenantId: string, id: string): Wallet {
    const db = getDb();
    const row = db.prepare('SELECT * FROM wallets WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Wallet', id);
    return mapWallet(row);
  },
};
